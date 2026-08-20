/**
 * The shapes the deduplication engine compares and the verdicts it returns.
 *
 * The comparable unit is a `LeadRecord`, not a `leads` row: a `leads` row does
 * not carry the phones, the emails, the domains or the social profiles, and
 * every one of those is a matching signal. Building the record from the
 * database is `from-db.ts`'s job; everything in `score.ts` is pure over this
 * shape, which is what makes the rules testable without a database.
 */
import type { IdentifierKind, MergeSignal } from '../db/schema.js';
import type { NormalizedCompanyName } from '../normalize/index.js';

/**
 * What the engine decided about a pair.
 *
 * The middle band is not a hedge, it is the point. A binary merge/no-merge on a
 * strong-but-not-decisive name match either loses data (refuse, and one business
 * ships as two rows) or corrupts it (merge, and two businesses ship as one).
 * `review` hands that pair to a human and stays out of both failure modes.
 */
export type MatchDecision = 'merge' | 'review' | 'distinct';

/**
 * Everything the engine can observe about a pair, including the observations
 * that argue against a merge.
 */
export type SignalKind =
  /* Decisive on their own, subject to the quarantine. */
  | 'phone'
  | 'website_domain'
  | 'email'
  | 'registration_number'
  /* Strong, but never decisive alone. */
  | 'name_city'
  /* Corroboration: enough to promote a name match to a merge. */
  | 'address'
  | 'social_profile'
  /* Weight only — never enough to decide anything by itself. */
  | 'name_weak'
  | 'phone_area_code'
  /* Against. */
  | 'city_conflict'
  | 'registration_conflict'
  /* A decisive value that is no longer trusted to decide. */
  | 'quarantined_identifier';

/**
 * How a signal is allowed to affect the verdict, independent of its weight.
 *
 * The distinction matters because the rules are structural, not arithmetic: no
 * pile of corroboration merges two leads without a decisive signal or a name
 * match, and no name match merges anything on its own however high it scores.
 */
export type SignalRole =
  /** Sufficient on its own. */
  | 'decisive'
  /** Promotes a `name_city` match to a merge; never merges anything alone. */
  | 'corroborating'
  /** Moves the score, decides nothing. */
  | 'supporting'
  /** Argues against, and can cap the verdict. */
  | 'opposing'
  /** A decisive signal the quarantine has disarmed: forces `review`, never `merge`. */
  | 'blocked';

export interface Signal {
  readonly kind: SignalKind;
  /** The value that matched: the e164, the domain, the address, the name key. */
  readonly value: string;
  /** 0-1 contribution. Positive for evidence, positive-and-`opposing` for evidence against. */
  readonly weight: number;
  readonly role: SignalRole;
  /** One line, aimed at the human reading the review queue. */
  readonly detail: string;
}

export interface MatchScore {
  /** 0-1. Within a decision band, it orders the review queue; it does not pick the band. */
  readonly score: number;
  readonly signals: readonly Signal[];
  readonly decision: MatchDecision;
  /**
   * The strongest positive signal, in `merge_log`'s vocabulary plus
   * `social_profile`. What goes into `merge_log.signal` when this pair merges.
   */
  readonly topSignal: MatchSignalName;
  readonly topSignalValue: string;
  /** Why the decision came out the way it did, in one sentence. */
  readonly reason: string;
}

/** `merge_log.signal` plus the one corroborating signal that has no slot there. */
export type MatchSignalName = MergeSignal | 'social_profile';

/**
 * One stored business, flattened into everything the matcher compares.
 *
 * `id` is null for a record that has not been written yet — an adapter can ask
 * `findCandidates` what an incoming record would match before deciding to store
 * it.
 */
export interface LeadRecord {
  readonly id: number | null;
  /** As published. Only ever shown to a human; never compared. */
  readonly name: string;
  /** The matching keys and tokens. Compared. */
  readonly nameKey: NormalizedCompanyName;
  readonly cityId: string | null;
  readonly municipalityId: string | null;
  readonly addressNormalized: string | null;
  readonly registrationNumber: string | null;
  readonly taxId: string | null;
  /** Canonical `+381…`, valid numbers only. An unparseable string never anchors a merge. */
  readonly phones: readonly string[];
  /** Registrable domains of the business's own websites. */
  readonly websiteDomains: readonly string[];
  /** Lower-cased addresses. */
  readonly emails: readonly string[];
  /** Canonical social profile URLs, one per network. */
  readonly socialUrls: readonly string[];
  readonly sourceIds: readonly string[];
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
}

/** A stored lead the engine believes may be the same business, with its verdict. */
export interface MatchCandidate {
  readonly leadId: number;
  readonly lead: LeadRecord;
  readonly match: MatchScore;
}

/**
 * Which decisive values have lost the right to decide.
 *
 * Passed in rather than looked up, so `scoreMatch` stays pure and a test can
 * state the quarantine in one line. `from-db.ts` builds the database-backed
 * implementation.
 */
export interface Quarantine {
  has(kind: IdentifierKind, value: string): boolean;
}

/** Nothing is quarantined. The default for a pure comparison in a test. */
export const NO_QUARANTINE: Quarantine = { has: () => false };

/** Why a merge happened, in the form `merge_log` stores. */
export interface MatchReason {
  readonly signal: MergeSignal;
  readonly signalValue: string;
  readonly score?: number | null | undefined;
  /** The full signal list, so the merge can be argued with and not just cited. */
  readonly signals?: readonly Signal[] | undefined;
  /** `pipeline` or `reviewer:<id>`. */
  readonly actor?: string | undefined;
  readonly runId?: number | null | undefined;
}
