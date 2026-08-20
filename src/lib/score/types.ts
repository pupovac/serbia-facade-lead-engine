/** The shapes the lead score reads and returns. */
import type { LeadClassification, PhoneType } from '../db/schema.js';
import type { CityMatch } from '../normalize/city.js';

/** What the score needs to know about one phone number. */
export interface ScorePhone {
  readonly e164: string;
  readonly type?: PhoneType | undefined;
  /** `false` keeps an unparseable number on the lead for auditing; it earns nothing. */
  readonly valid?: boolean | undefined;
}

export interface ScoreInput {
  /** Distinct canonical numbers. Duplicates are collapsed here, not counted twice. */
  readonly phones?: readonly ScorePhone[] | undefined;
  readonly emails?: readonly string[] | undefined;
  readonly websites?: readonly string[] | undefined;
  /** Canonical profile URLs — Facebook, Instagram, Google Maps. */
  readonly socials?: readonly string[] | undefined;
  /** From `resolveCity`. Its `confidence` is what scales the component. */
  readonly city?: Pick<CityMatch, 'confidence' | 'matchedVia'> | null | undefined;
  readonly classification?:
    | { readonly label: LeadClassification; readonly confidence?: number | null | undefined }
    | undefined;
  /** Distinct `sources.id` values that published this business. */
  readonly sourceIds?: readonly string[] | undefined;
  /** When a source last saw the business. */
  readonly lastSeenAt?: Date | null | undefined;
  /**
   * The clock, passed in rather than read — the score is pure and a test must
   * be able to fix "now". Defaults to `lastSeenAt`, which makes recency full
   * marks when the caller does not care.
   */
  readonly now?: Date | undefined;
}

/** One line of the breakdown the review UI renders under a score. */
export interface ScoreComponent {
  readonly id: keyof import('./weights.js').ScoreWeights | 'noPhoneCeiling';
  /** Points awarded. Negative for the no-phone cap. */
  readonly points: number;
  /** The most this component could have awarded. */
  readonly max: number;
  /** One line a human can read, e.g. `2 phones, 1 mobile`. */
  readonly detail: string;
}

export interface LeadScore {
  /** 0–100, integer. Data completeness and relevance — never purchase likelihood. */
  readonly score: number;
  readonly components: readonly ScoreComponent[];
  /** True when the no-phone ceiling was applied. */
  readonly capped: boolean;
}
