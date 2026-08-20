/**
 * The sweep: run the whole engine over a stored database.
 *
 * Order matters and is not negotiable.
 *
 * 1. **Quarantine first.** Count every decisive value against the number of
 *    distinct businesses carrying it, and disarm the ones that are shared. Doing
 *    this after merging would be closing the gate behind the horse: the
 *    chain-merge the guard exists to prevent would already have happened.
 * 2. **Score every blocked pair**, strongest evidence first.
 * 3. **Merge what the rules say to merge**, park what they say to review, and
 *    ignore the rest.
 * 4. **Repeat until a round changes nothing.** A merge creates new evidence —
 *    A and B merge on a phone, and the union now shares a domain with C — so one
 *    pass is not enough. A pass that merges nothing is the fixed point.
 *
 * ## Idempotence
 *
 * Running the sweep twice over the same database must change nothing the second
 * time, and that is a test, not an aspiration. Three things make it true: a
 * merged-away lead resolves to its survivor, so its pairs come back as
 * `already_merged`; a `review` pair is stored under an unordered key and its
 * status is never reset; and a pair a human rejected stays rejected.
 */
import type { Db } from '../db/client.js';
import {
  activeLeadCount,
  pendingMergeCandidates,
  resolveLead,
  resolveMergeCandidate,
  upsertMergeCandidate,
} from '../db/repo.js';
import type { MergeSignal } from '../db/schema.js';
import { allCandidatePairs, type CandidatePair } from './candidates.js';
import { toLeadRecord } from './from-db.js';
import { chooseSurvivor, mergeLeads, type MergeRefusal } from './merge.js';
import { scoreMatch } from './score.js';
import { loadQuarantine, refreshQuarantine, type QuarantineStats } from './quarantine.js';
import { MAX_SWEEP_ROUNDS } from './weights.js';
import type { MatchDecision, MatchSignalName } from './types.js';

export interface SweepOptions {
  readonly at?: Date | undefined;
  readonly runId?: number | null | undefined;
  readonly actor?: string | undefined;
  /** Score and report, write nothing. One round only — nothing changes, so nothing follows. */
  readonly dryRun?: boolean | undefined;
  /** Skip the quarantine pass. Only for a caller that has just run it. */
  readonly skipQuarantine?: boolean | undefined;
}

export interface SweepStats {
  readonly leadsBefore: number;
  readonly leadsAfter: number;
  /** `leadsBefore - leadsAfter`, as a share of `leadsBefore`. The duplicate rate. */
  readonly duplicateRate: number;
  /** Pairs the blocking produced on the first pass, before anything was merged. */
  readonly pairsScored: number;
  /** What the engine decided about those pairs. The merge-decision distribution. */
  readonly decisions: Readonly<Record<MatchDecision, number>>;
  /** Merges actually performed, across every round. */
  readonly merged: number;
  /** Merges by deciding signal. */
  readonly mergedBySignal: Readonly<Partial<Record<MergeSignal, number>>>;
  /** Pairs the engine wanted to merge but was not allowed to. */
  readonly refused: Readonly<Partial<Record<MergeRefusal, number>>>;
  /** Pairs waiting for a human when the sweep finished. */
  readonly reviewPending: number;
  /** Review pairs a human had already decided, so they were not re-proposed. */
  readonly reviewAlreadyDecided: number;
  /**
   * Pairs withdrawn from the queue because the rules no longer propose them —
   * usually a value the quarantine disarmed after the pair was queued.
   */
  readonly reviewWithdrawn: number;
  readonly quarantine: QuarantineStats;
  readonly rounds: number;
  /** True when the round cap was hit — a rule that will not settle, and a bug. */
  readonly roundsExhausted: boolean;
  /** City blocks skipped for being over `MAX_CITY_BLOCK`. Never silent. */
  readonly blocksTruncated: number;
}

const EMPTY_QUARANTINE: QuarantineStats = {
  identifiersSeen: 0,
  quarantined: 0,
  byKind: { phone: 0, website_domain: 0, email: 0 },
  newlyQuarantined: [],
};

/**
 * Deduplicate the whole database, and report what happened in numbers.
 *
 * Nothing is deleted at any point: a duplicate becomes a tombstone pointing at
 * its survivor, and every merge is one `merge_log` row away from being undone.
 */
export function dedupeDatabase(db: Db, options: SweepOptions = {}): SweepStats {
  const at = options.at ?? new Date();
  const dryRun = options.dryRun === true;
  const leadsBefore = activeLeadCount(db);

  const quarantine =
    options.skipQuarantine === true || dryRun ? EMPTY_QUARANTINE : refreshQuarantine(db, at);

  const decisions: Record<MatchDecision, number> = { merge: 0, review: 0, distinct: 0 };
  const mergedBySignal: Partial<Record<MergeSignal, number>> = {};
  const refused: Partial<Record<MergeRefusal, number>> = {};
  let pairsScored = 0;
  let merged = 0;
  let reviewAlreadyDecided = 0;
  let blocksTruncated = 0;
  let rounds = 0;
  let roundsExhausted = false;

  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    rounds = round + 1;
    const pairs = allCandidatePairs(db, {
      quarantine: loadQuarantine(db),
      // The `distinct` verdicts are wanted here even though nothing acts on
      // them: a decision distribution that only counts the pairs the engine
      // liked says nothing about how often it said no.
      includeDistinct: true,
      onBlockTruncated: () => {
        blocksTruncated += 1;
      },
    });

    if (round === 0) {
      pairsScored = pairs.length;
      for (const pair of pairs) decisions[pair.match.decision] += 1;
    }
    if (dryRun) break;

    let mergedThisRound = 0;
    for (const pair of pairs) {
      if (pair.match.decision === 'distinct') continue;
      // A merge earlier in this round may have moved one side. The pair is
      // re-derived next round against the survivor rather than patched here.
      if (movedSince(db, pair)) continue;

      if (pair.match.decision === 'merge') {
        const { survivor, merged: loser } = chooseSurvivor(pair.a, pair.b);
        if (survivor.id == null || loser.id == null) continue;
        const outcome = mergeLeads(
          db,
          survivor.id,
          loser.id,
          {
            signal: mergeSignalOf(pair.match.topSignal),
            signalValue: pair.match.topSignalValue,
            score: pair.match.score,
            signals: pair.match.signals,
            ...(options.actor == null ? {} : { actor: options.actor }),
            ...(options.runId == null ? {} : { runId: options.runId }),
          },
          { at },
        );
        if (outcome.merged) {
          merged += 1;
          mergedThisRound += 1;
          const signal = mergeSignalOf(pair.match.topSignal);
          mergedBySignal[signal] = (mergedBySignal[signal] ?? 0) + 1;
        } else if (outcome.refusal != null) {
          refused[outcome.refusal] = (refused[outcome.refusal] ?? 0) + 1;
          // A merge the quarantine stopped is exactly what the review band is
          // for: the evidence is real, it is just no longer trusted alone.
          if (outcome.refusal === 'quarantined_signal') queueForReview(db, pair, at);
        }
      } else if (pair.match.decision === 'review') {
        const result = queueForReview(db, pair, at);
        if (result === 'already_decided') reviewAlreadyDecided += 1;
      }
    }

    if (mergedThisRound === 0) break;
    if (round === MAX_SWEEP_ROUNDS - 1) roundsExhausted = true;
  }

  const reviewWithdrawn = dryRun ? 0 : withdrawAnsweredPairs(db, at);
  const leadsAfter = activeLeadCount(db);
  return {
    leadsBefore,
    leadsAfter,
    duplicateRate: leadsBefore === 0 ? 0 : (leadsBefore - leadsAfter) / leadsBefore,
    pairsScored,
    decisions,
    merged,
    mergedBySignal,
    refused,
    reviewPending: dryRun ? 0 : pendingMergeCandidates(db).length,
    reviewAlreadyDecided,
    reviewWithdrawn,
    quarantine,
    rounds,
    roundsExhausted,
    blocksTruncated,
  };
}

/**
 * Take back the questions the engine has stopped asking.
 *
 * A pair is queued at the moment it is found, which is often before the
 * quarantine pass has seen the records that reveal what the value connecting
 * the two leads really is. Once it has, that pair is not a question any more —
 * and a review queue that accumulates answers nobody asked for is a queue a
 * human stops opening.
 *
 * Every pending pair is re-scored, not just the ones the blocking happens to
 * find again: a pair whose only shared key has since been disarmed would
 * otherwise never come up for reconsideration and would sit there forever. The
 * queue is bounded by human throughput, so this is cheap.
 *
 * A human's `rejected` is never touched. This writes `rejected` with
 * `resolved_by = 'pipeline'`, which is what distinguishes the two.
 */
function withdrawAnsweredPairs(db: Db, at: Date): number {
  const quarantine = loadQuarantine(db);
  let withdrawn = 0;
  for (const candidate of pendingMergeCandidates(db)) {
    const a = resolveLead(db, candidate.leadAId);
    const b = resolveLead(db, candidate.leadBId);
    if (!a || !b) continue;
    if (a.id === b.id) {
      resolveMergeCandidate(db, candidate.id, 'merged', { resolvedBy: 'pipeline', at });
      continue;
    }
    const recordA = toLeadRecord(db, a.id);
    const recordB = toLeadRecord(db, b.id);
    if (!recordA || !recordB) continue;
    if (scoreMatch(recordA, recordB, { quarantine }).decision !== 'distinct') continue;
    resolveMergeCandidate(db, candidate.id, 'rejected', { resolvedBy: 'pipeline', at });
    withdrawn += 1;
  }
  return withdrawn;
}

/** Has either side of this pair been merged away since the pair was scored? */
function movedSince(db: Db, pair: CandidatePair): boolean {
  return resolveLead(db, pair.aId)?.id !== pair.aId || resolveLead(db, pair.bId)?.id !== pair.bId;
}

function queueForReview(db: Db, pair: CandidatePair, at: Date): 'queued' | 'already_decided' {
  const result = upsertMergeCandidate(db, {
    leadAId: pair.aId,
    leadBId: pair.bId,
    score: pair.match.score,
    topSignal: pair.match.topSignal,
    signalValue: pair.match.topSignalValue,
    signals: JSON.stringify(pair.match.signals),
    seenAt: at,
  });
  return result.status === 'pending' ? 'queued' : 'already_decided';
}

/**
 * `merge_log.signal` has no `social_profile` slot and does not need one: a
 * social profile is corroboration, it never decides a merge alone, and
 * `scoreMatch` already ranks the deciding rule above it. This is the total
 * function that says so in the type system.
 */
function mergeSignalOf(signal: MatchSignalName): MergeSignal {
  return signal === 'social_profile' ? 'name_city' : (signal satisfies MergeSignal);
}
