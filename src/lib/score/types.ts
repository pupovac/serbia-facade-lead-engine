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

/**
 * Everything the relevance half reads. Deliberately nothing else: if a contact
 * channel could reach this interface, relevance would start measuring
 * completeness again, which is the defect FUZZ-37 exists to remove.
 */
export interface ScoreClassification {
  readonly label: LeadClassification;
  readonly confidence?: number | null | undefined;
  /**
   * The deciding axis's `net` from `classifyLead` — `decidingNet(result)`.
   * Absent means the caller kept the label and lost the arithmetic (an old row
   * with no `classification_evidence`); the confidence then stands in for it,
   * so a pre-existing lead is not punished for a column that did not exist.
   */
  readonly evidenceNet?: number | null | undefined;
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
  readonly classification?: ScoreClassification | undefined;
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

/** One line of a breakdown the review UI renders under a score. */
interface Component<Id extends string> {
  readonly id: Id;
  /** Points awarded. Negative for the no-phone cap. */
  readonly points: number;
  /** The most this component could have awarded. */
  readonly max: number;
  /** One line a human can read, e.g. `2 phones, 1 mobile`. */
  readonly detail: string;
}

export type ScoreComponent = Component<
  keyof import('./weights.js').ContactabilityWeights | 'noPhoneCeiling'
>;

export type RelevanceComponent = Component<keyof import('./weights.js').RelevanceWeights>;

export interface LeadScore {
  /**
   * 0–100. **Is this a lead for us?** The label, its confidence and the
   * strength of the evidence behind it. No contact channel contributes a
   * single point: two leads with identical classification evidence and wildly
   * different contact cards score the same here, and `score.test.ts` asserts
   * exactly that.
   */
  readonly relevance: number;
  readonly relevanceComponents: readonly RelevanceComponent[];
  /**
   * 0–100. **How much contact data do we hold?** Phones, extra numbers, mobile
   * vs landline, email, website, social, city, corroboration, recency.
   */
  readonly contactability: number;
  readonly components: readonly ScoreComponent[];
  /**
   * 0–100, derived: `relevance × contactability / 100`. The export's single
   * sort key — relevance gates, contactability ranks. Never the only thing a
   * list can rank by; the two halves above are sorted on independently.
   */
  readonly score: number;
  /** True when the no-phone ceiling was applied to `contactability`. */
  readonly capped: boolean;
}
