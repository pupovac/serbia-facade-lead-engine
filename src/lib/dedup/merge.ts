/**
 * Turning a verdict into a merge, and back out again.
 *
 * `repo.recordMerge` already knows how to move rows: every phone, every email,
 * every website, every social profile and every source URL from both sides ends
 * up on the survivor, the merged-away row stays as a tombstone so every id ever
 * handed out keeps resolving, and a snapshot goes into `merge_log` so the whole
 * thing can be undone. **Union, never truncation.**
 *
 * What this file adds is everything around that:
 *
 * - **The guard.** A merge is refused, not attempted, when its deciding value
 *   is quarantined. The refusal is a returned result rather than an exception,
 *   because a sweep that stops on the first shared switchboard number in the
 *   country is not a sweep.
 * - **Which side survives.** The target survives by default — the caller asked
 *   for that — but the sweep uses `chooseSurvivor`, which prefers the record
 *   that already carries more, because inheriting into a fuller row leaves
 *   fewer field conflicts to resolve.
 * - **Conflicts on singular fields.** Name and city cannot both be kept on the
 *   `leads` row. The winner is decided by source trust rank and then recency,
 *   and the loser stays in `lead_field_values` with its provenance — recorded,
 *   not discarded.
 * - **Re-grading.** The union is a different record from either input, so its
 *   label and score are recomputed rather than inherited.
 */
import type { Db } from '../db/client.js';
import {
  getLead,
  getMergeLogEntry,
  getSharedIdentifier,
  leadFieldClaims,
  promoteFieldValue,
  recordMerge,
  releaseCandidatesFor,
  resolveLead,
  revertMerge,
  type MergeResult,
} from '../db/repo.js';
import type { IdentifierKind, MergeSignal, ProvenanceField, Source } from '../db/schema.js';
import { getSource } from '../db/repo.js';
import { completeness, toLeadRecord } from './from-db.js';
import { regradeLead, type RegradeResult } from './regrade.js';
import type { LeadRecord, MatchReason } from './types.js';

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a merge did not happen. `null` in `MergeOutcome.refusal` means it did. */
export type MergeRefusal =
  /** The two ids already resolve to one lead. Re-running dedup is meant to hit this. */
  | 'already_merged'
  /** The deciding value is quarantined and may not decide anything. */
  | 'quarantined_signal'
  /** One of the two leads does not exist. */
  | 'missing_lead';

export interface MergeOutcome {
  readonly merged: boolean;
  readonly survivingLeadId: number;
  readonly mergedLeadId: number | null;
  readonly refusal: MergeRefusal | null;
  readonly result: MergeResult | null;
  /** What the survivor was re-graded to after the union. */
  readonly regraded: RegradeResult | null;
  /** Singular fields whose winner had to be chosen: name, city, address. */
  readonly conflictsResolved: readonly ResolvedConflict[];
}

export interface ResolvedConflict {
  readonly field: ProvenanceField;
  readonly kept: string;
  readonly alsoRecorded: readonly string[];
  readonly decidedBy: 'source_trust' | 'recency' | 'incumbent';
}

export interface MergeOptions {
  readonly at?: Date | undefined;
  /** Skip the quarantine guard. Only a human's explicit decision may do this. */
  readonly force?: boolean | undefined;
}

/**
 * Merge `sourceId` into `targetId`.
 *
 * Idempotent: calling it again on a pair that is already one lead returns
 * `already_merged` and changes nothing, which is what makes re-running dedup
 * over a merged database a no-op rather than a slow corruption.
 */
export function mergeLeads(
  db: Db,
  targetId: number,
  sourceId: number,
  reason: MatchReason,
  options: MergeOptions = {},
): MergeOutcome {
  const at = options.at ?? new Date();
  const target = resolveLead(db, targetId);
  const source = resolveLead(db, sourceId);

  if (!target || !source) {
    return refuse('missing_lead', target?.id ?? targetId, null);
  }
  if (target.id === source.id) {
    return refuse('already_merged', target.id, null);
  }
  if (options.force !== true && isQuarantinedSignal(db, reason)) {
    return refuse('quarantined_signal', target.id, source.id);
  }

  const result = recordMerge(db, {
    survivingLeadId: target.id,
    mergedLeadId: source.id,
    signal: reason.signal,
    signalValue: reason.signalValue,
    score: reason.score ?? null,
    signals: reason.signals ? JSON.stringify(reason.signals) : null,
    actor: reason.actor ?? 'pipeline',
    runId: reason.runId ?? null,
    mergedAt: at,
  });

  const conflictsResolved = resolveSingularConflicts(db, target.id);
  releaseCandidatesFor(db, source.id, at);
  const regraded = regradeLead(db, target.id, at) ?? null;

  return {
    merged: true,
    survivingLeadId: target.id,
    mergedLeadId: source.id,
    refusal: null,
    result,
    regraded,
    conflictsResolved,
  };
}

function refuse(refusal: MergeRefusal, survivingLeadId: number, mergedLeadId: number | null) {
  return {
    merged: false,
    survivingLeadId,
    mergedLeadId,
    refusal,
    result: null,
    regraded: null,
    conflictsResolved: [],
  } satisfies MergeOutcome;
}

/** `phone` / `website_domain` / `email` signals map onto a quarantinable kind. */
const QUARANTINABLE: Partial<Record<MergeSignal, IdentifierKind>> = {
  phone: 'phone',
  website_domain: 'website_domain',
  email: 'email',
};

function isQuarantinedSignal(db: Db, reason: MatchReason): boolean {
  const kind = QUARANTINABLE[reason.signal];
  if (kind == null) return false;
  return getSharedIdentifier(db, kind, reason.signalValue)?.quarantined === true;
}

/* -------------------------------------------------------------------------- */
/* Which side survives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pick the survivor of a pair.
 *
 * `recordMerge` fills the survivor's blanks from the merged-away lead, so the
 * fuller record surviving means fewer values arrive as conflicts and more of
 * them are already right. Ties break on age: the lead seen first keeps its id,
 * which is the id anything outside this system may already be holding.
 */
export function chooseSurvivor(
  a: LeadRecord,
  b: LeadRecord,
): { readonly survivor: LeadRecord; readonly merged: LeadRecord } {
  const byCompleteness = completeness(b) - completeness(a);
  if (byCompleteness !== 0) {
    return byCompleteness > 0 ? { survivor: b, merged: a } : { survivor: a, merged: b };
  }
  const aFirst = a.firstSeenAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bFirst = b.firstSeenAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (aFirst !== bFirst)
    return aFirst < bFirst ? { survivor: a, merged: b } : { survivor: b, merged: a };
  return (a.id ?? 0) <= (b.id ?? 0) ? { survivor: a, merged: b } : { survivor: b, merged: a };
}

/* -------------------------------------------------------------------------- */
/* Conflicts on singular fields                                               */
/* -------------------------------------------------------------------------- */

/**
 * Source trust: the registry priority a source was ranked at in Stage 1.
 *
 * A national business directory that publishes a registered company name beats
 * a classifieds ad where the seller typed whatever fitted the headline.
 */
const TRUST_RANK: Record<Source['priority'], number> = {
  high: 3,
  medium: 2,
  low: 1,
  rejected: 0,
};

/** Fields that live in one column and therefore have to have exactly one winner. */
const SINGULAR_FIELDS: readonly ProvenanceField[] = ['name', 'city', 'address'];

/**
 * After a union, the survivor holds claims from both sides for every singular
 * field. Pick the winner by source trust rank, then by recency, and promote it.
 *
 * The losing values are not touched: they stay in `lead_field_values` with
 * their own provenance, which is what `repo.fieldConflicts()` shows a reviewer.
 * "Conflicts are recorded, not silently resolved" means recorded *and* resolved
 * — a spreadsheet cannot show two names in one cell.
 */
export function resolveSingularConflicts(db: Db, leadId: number): ResolvedConflict[] {
  const lead = getLead(db, leadId);
  if (!lead) return [];

  const claims = leadFieldClaims(db, leadId);
  const resolved: ResolvedConflict[] = [];
  const trustCache = new Map<string, number>();
  const trustOf = (sourceId: string): number => {
    const cached = trustCache.get(sourceId);
    if (cached != null) return cached;
    const rank = TRUST_RANK[getSource(db, sourceId)?.priority ?? 'low'];
    trustCache.set(sourceId, rank);
    return rank;
  };

  for (const field of SINGULAR_FIELDS) {
    const forField = claims.filter((claim) => claim.field === field);
    const values = [...new Set(forField.map((claim) => claim.value))];
    if (values.length < 2) continue;

    const best = forField.reduce((winner, claim) => {
      const byTrust = trustOf(claim.sourceId) - trustOf(winner.sourceId);
      if (byTrust !== 0) return byTrust > 0 ? claim : winner;
      return claim.lastSeenAt > winner.lastSeenAt ? claim : winner;
    });

    const incumbent = forField.find((claim) => claim.isCurrent);
    const decidedBy: ResolvedConflict['decidedBy'] =
      incumbent != null && incumbent.value === best.value
        ? 'incumbent'
        : trustOf(best.sourceId) > trustOf(incumbent?.sourceId ?? best.sourceId)
          ? 'source_trust'
          : 'recency';

    if (incumbent == null || incumbent.value !== best.value) {
      promoteFieldValue(db, leadId, field, best.value);
    }
    resolved.push({
      field,
      kept: best.value,
      alsoRecorded: values.filter((value) => value !== best.value),
      decidedBy,
    });
  }

  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Undoing a merge                                                            */
/* -------------------------------------------------------------------------- */

export interface UnmergeOutcome {
  readonly mergeLogId: number;
  readonly survivingLeadId: number;
  readonly restoredLeadId: number;
  /** Both leads, re-graded from what each carries once the rows have moved back. */
  readonly regraded: readonly RegradeResult[];
}

/**
 * Undo a merge from its `merge_log` snapshot, and re-grade both leads.
 *
 * This is the path that makes an aggressive rule safe to run. The engine will
 * be wrong sometimes — two branches of one company, two businesses sharing an
 * accountant's number — and reversibility is what turns a wrong merge into a
 * correction instead of a data loss. `repo.revertMerge` puts every row back
 * where it was, including the exact-duplicate claims that were absorbed; the
 * re-grade is here because both leads now hold less than they did a moment ago
 * and a stale score would outlive the merge that produced it.
 *
 * Reverting a merge that has already been reverted throws. Reverting one whose
 * survivor has since been merged into a third lead is refused by `revertMerge`
 * for the same reason: the snapshot no longer describes the rows.
 */
export function unmergeLeads(db: Db, mergeLogId: number, note?: string): UnmergeOutcome {
  const entry = getMergeLogEntry(db, mergeLogId);
  if (!entry) throw new Error(`merge log entry ${mergeLogId} not found`);

  revertMerge(db, mergeLogId, note);

  const at = new Date();
  const regraded = [
    regradeLead(db, entry.survivingLeadId, at),
    regradeLead(db, entry.mergedLeadId, at),
  ].filter((result): result is RegradeResult => result != null);

  return {
    mergeLogId,
    survivingLeadId: entry.survivingLeadId,
    restoredLeadId: entry.mergedLeadId,
    regraded,
  };
}

/** The record a lead now holds, after a merge or an unmerge. */
export function mergedRecord(db: Db, leadId: number): LeadRecord | undefined {
  return toLeadRecord(db, leadId);
}
