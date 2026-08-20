/**
 * `ingestLead` — the entry point an adapter writes through.
 *
 * `repo.upsertLead` matches on the **exact** signals and nothing else, which is
 * all an insert needs and deliberately less than the merge engine knows. This
 * wraps it with the three things the engine adds, so that a record is matched
 * with the full rule set at the moment it arrives rather than only when a sweep
 * next runs:
 *
 * - **The same page, seen again.** Runs are incremental, so a re-crawl of a URL
 *   already attached to a lead updates that lead. Checked first, because it is
 *   the one identity that cannot be wrong.
 * - **`findCandidates` next.** A near-duplicate name, a shared address, a
 *   shared Facebook page — none of these has an exact key for `upsertLead` to
 *   look up, and all of them are matches.
 * - **Attach only what can be attached.** This is the important one. An attach
 *   is irreversible — it leaves no `merge_log` row, so there is nothing to undo
 *   — while a merge is one revert away from being wrong safely. So a record is
 *   attached only to a lead whose name says it is the same business; a shared
 *   phone under two unrelated names is written as a second lead and merged
 *   reversibly by the sweep, after the quarantine has had its say. That is what
 *   keeps one call-centre number from chaining five businesses into one row
 *   before any sweep has run.
 * - **The review band.** A pair the engine will not decide is written to
 *   `merge_candidates` as it is found, so the review queue fills during the
 *   crawl rather than only at the end of it.
 *
 * A sweep afterwards is still worth running — `dedupeDatabase` sees pairs that
 * only exist once both sides are stored — but this makes the database
 * defensible on its own between sweeps.
 */
import type { Db } from '../db/client.js';
import {
  findLeadsBySourceUrl,
  upsertLead,
  upsertMergeCandidate,
  type LeadInput,
  type Provenance,
  type UpsertLeadResult,
} from '../db/repo.js';
import { findCandidates } from './candidates.js';
import { leadRecord } from './from-db.js';
import { isSameBusinessName, loadQuarantine } from './quarantine.js';
import { regradeLead } from './regrade.js';
import type { MatchCandidate, MatchSignalName, Quarantine } from './types.js';

export interface IngestOptions {
  /** Loaded from the database when not supplied. Pass it to reuse across a batch. */
  readonly quarantine?: Quarantine | undefined;
  readonly at?: Date | undefined;
  /** Skip the review-band write. The pairs are still returned. */
  readonly skipReviewQueue?: boolean | undefined;
  /**
   * Skip the classify-and-score pass. Only for a caller that grades in bulk
   * afterwards — a lead written and left ungraded is `UNKNOWN`, and `UNKNOWN`
   * stays out of the export.
   */
  readonly skipGrading?: boolean | undefined;
}

export interface IngestResult {
  readonly leadId: number;
  readonly created: boolean;
  /** The signal the merge engine matched on, or `null` for a lead written fresh. */
  readonly matchedBy: MatchSignalName | null;
  /** True when this was the same page seen again, and no matching was needed. */
  readonly reSighted: boolean;
  readonly score: number | null;
  /** Pairs parked for a human. Already written unless `skipReviewQueue`. */
  readonly review: readonly MatchCandidate[];
  readonly upsert: UpsertLeadResult;
}

/**
 * Store one scraped business, attached to the lead it already is if the rules
 * say so.
 */
export function ingestLead(
  db: Db,
  input: LeadInput,
  provenance: Provenance,
  options: IngestOptions = {},
): IngestResult {
  const at = options.at ?? provenance.seenAt ?? new Date();
  const quarantine = options.quarantine ?? loadQuarantine(db);

  // A re-crawl of the same page is the same sighting. This is checked before
  // anything else because it is the one identity that cannot be wrong: runs are
  // incremental, and a record whose other signals the engine declines to decide
  // on would otherwise be re-inserted on every crawl.
  const seenHere = findLeadsBySourceUrl(db, provenance.sourceId, provenance.sourceUrl).find(
    (lead) => isSameBusinessName(lead.name, input.name),
  );

  const candidates =
    input.leadId == null && seenHere == null
      ? findCandidates(db, toRecord(input), { quarantine })
      : [];

  // Attaching and merging are not the same act, and the difference is whether
  // it can be undone. An attach folds the incoming record into an existing lead
  // and leaves no `merge_log` row; a merge leaves a snapshot. So the incoming
  // record is only ever *attached* to a lead whose name says it is the same
  // business. Everything else the rules would merge — a shared phone under two
  // unrelated names, which is either a real duplicate or the first sign of a
  // switchboard — is written as its own lead and left to `dedupeDatabase`,
  // which runs the quarantine first and merges reversibly. The database is
  // briefly one row longer; it is never irreversibly one row shorter.
  const best = candidates.find(
    (candidate) =>
      candidate.match.decision === 'merge' && isSameBusinessName(candidate.lead.name, input.name),
  );
  const review = candidates.filter((candidate) => candidate.match.decision === 'review');

  const attachTo = seenHere?.id ?? best?.leadId;
  const result = upsertLead(
    db,
    attachTo == null ? input : { ...input, leadId: attachTo },
    provenance,
    // The verdict above is the whole rule set. Letting `upsertLead`'s exact
    // matcher have a second opinion would undo it: a shared phone across two
    // differently registered companies is a `review`, and the exact matcher
    // would attach them regardless.
    { matching: 'caller' },
  );

  if (options.skipReviewQueue !== true) {
    for (const candidate of review) {
      if (candidate.leadId === result.leadId) continue;
      upsertMergeCandidate(db, {
        leadAId: result.leadId,
        leadBId: candidate.leadId,
        score: candidate.match.score,
        topSignal: candidate.match.topSignal,
        signalValue: candidate.match.topSignalValue,
        signals: JSON.stringify(candidate.match.signals),
        seenAt: at,
      });
    }
  }

  // Grading is derived from what the lead now holds, and the lead has just
  // gained a source, a phone or a description. `applyGrading` overwrites on
  // purpose, so a re-crawl over better text replaces the previous verdict.
  if (options.skipGrading !== true) regradeLead(db, result.leadId, at);

  return {
    leadId: result.leadId,
    created: result.created,
    matchedBy: best?.match.topSignal ?? null,
    reSighted: seenHere != null,
    score: best?.match.score ?? null,
    review,
    upsert: result,
  };
}

/** The `LeadInput` an adapter produced, as something the matcher can compare. */
function toRecord(input: LeadInput) {
  return leadRecord({
    name: input.name,
    cityId: input.cityId ?? null,
    municipalityId: input.municipalityId ?? null,
    addressNormalized: input.addressNormalized ?? input.address ?? null,
    registrationNumber: input.registrationNumber ?? null,
    taxId: input.taxId ?? null,
    phones: (input.phones ?? [])
      .filter((phone) => phone.valid !== false)
      .map((phone) => phone.e164),
    websiteDomains: (input.contacts ?? [])
      .filter((contact) => contact.kind === 'website' && contact.domain)
      .map((contact) => contact.domain as string),
    emails: (input.contacts ?? [])
      .filter((contact) => contact.kind === 'email')
      .map((contact) => contact.value.toLowerCase()),
    socialUrls: (input.contacts ?? [])
      .filter((contact) =>
        (['facebook', 'instagram', 'google_maps', 'linkedin', 'youtube'] as const).includes(
          contact.kind as 'facebook',
        ),
      )
      .map((contact) => contact.value),
  });
}
