/**
 * Deduplication and merging.
 *
 * The same fasader is on a directory, on a classifieds site, on Facebook and on
 * their own website. Without this module the deliverable is thousands of
 * duplicate rows and the sales list is unusable; with it, one business is one
 * row carrying every phone, every email and every source URL that any of those
 * pages published.
 *
 * ## The three entry points
 *
 * ```ts
 * findCandidates(db, record)              // which stored leads could this be?
 * scoreMatch(a, b)                        // are these two the same business?
 * mergeLeads(db, targetId, sourceId, why) // make them one, reversibly
 * ```
 *
 * `dedupeDatabase(db)` runs all three over everything and reports the numbers.
 * `ingestLead(db, input, provenance)` is what an adapter writes through — it is
 * `repo.upsertLead` with the full rule set and the guards attached, instead of
 * the exact signals alone.
 *
 * ## The three properties everything else follows from
 *
 * - **Merge, never delete.** The merged lead keeps every phone, every email,
 *   every website, every social profile and every source URL from both sides.
 *   The merged-away row stays as a tombstone, so every id ever handed out still
 *   resolves. Conflicts on the fields that can only hold one value are resolved
 *   by source trust and recency, and the losing value stays in
 *   `lead_field_values` with its provenance.
 * - **Three outcomes, not two.** `merge`, `review`, `distinct`. The middle band
 *   is where a strong name match with nothing behind it goes, and it is what
 *   the review UI lists. A binary decision either loses data or corrupts it.
 * - **Every merge is reversible.** `merge_log` holds the deciding signal, the
 *   score, the full signal list and a snapshot; `unmergeLeads` walks it back and
 *   re-grades both leads. That is what makes an aggressive rule safe to run.
 *
 * ## The guard
 *
 * One call-centre number published by forty businesses would chain-merge all
 * forty into one row, and then everything each of them matches. So before any
 * merging, every decisive value is counted against the number of **distinct
 * businesses** carrying it, and the ones that are shared are quarantined: they
 * stop deciding anything, at the insert path and in the matcher alike. They are
 * not deleted — a quarantined number is still the deliverable, it just stops
 * being an identity. See `quarantine.ts`.
 */
export { scoreMatch, type ScoreMatchOptions } from './score.js';
export {
  allCandidatePairs,
  findCandidates,
  findCandidatesForLead,
  type CandidatePair,
  type FindCandidatesOptions,
} from './candidates.js';
export {
  chooseSurvivor,
  mergeLeads,
  mergedRecord,
  resolveSingularConflicts,
  unmergeLeads,
  type MergeOptions,
  type MergeOutcome,
  type MergeRefusal,
  type ResolvedConflict,
  type UnmergeOutcome,
} from './merge.js';
export { dedupeDatabase, type SweepOptions, type SweepStats } from './sweep.js';
export { ingestLead, type IngestOptions, type IngestResult } from './ingest.js';
export {
  assessIdentifiers,
  countDistinctBusinesses,
  isSameBusinessName,
  loadQuarantine,
  neverAnIdentity,
  refreshQuarantine,
  staticQuarantine,
  STRUCTURAL_QUARANTINE,
  type IdentifierSpread,
  type QuarantineStats,
} from './quarantine.js';
export { completeness, leadRecord, requireLeadRecord, toLeadRecord } from './from-db.js';
export { regradeLead, type RegradeResult } from './regrade.js';
export {
  BANDS,
  CITY_CONFLICT_PENALTY,
  MAX_CITY_BLOCK,
  MAX_SWEEP_ROUNDS,
  NAME_WEIGHT,
  QUARANTINE_LIMITS,
  SAME_BUSINESS_SIMILARITY,
  SIGNAL_WEIGHTS,
  WEAK_NAME_MIN,
} from './weights.js';
export { NO_QUARANTINE } from './types.js';
export type * from './types.js';
