/**
 * The shapes the classifier reads and returns.
 *
 * The result is deliberately verbose. A label on its own is a number nobody
 * can argue with and nobody trusts, so every run returns the spans it matched,
 * the span it deliberately did **not** count, and the arithmetic that turned
 * them into a label — that is what the review UI shows and what a reviewer
 * overrules.
 */
import type { AdjacentIndustry, LeadClassification } from '../db/schema.js';

export type { AdjacentIndustry, LeadClassification };

/** Which buyer group a signal argues for. `adjacent` argues against both. */
export type SignalAxis = 'contractor' | 'store' | 'adjacent';

/**
 * How much a match is allowed to decide on its own.
 *
 * - `core` — the term names the trade outright (`fasaderski radovi`,
 *   `stovarište`). One of these is enough for a label.
 * - `supporting` — the term is consistent with the trade but shared with
 *   neighbours (`malterisanje`, `veleprodaja`, `stiropor`).
 * - `ambiguous` — the term appears in the target trade and in at least one
 *   unrelated one (`fasada`, `termoizolacija`, `izolacija`, `prodaja`). Never
 *   decisive on its own; this is where the false positives live.
 */
export type SignalStrength = 'core' | 'supporting' | 'ambiguous';

/**
 * The trade a disqualifying match actually belongs to.
 *
 * Defined in `src/lib/db/schema.ts` — `leads.classification_industry` persists
 * it, and the schema may not import the classifier.
 */
export { ADJACENT_INDUSTRIES } from '../db/schema.js';

/**
 * What has to be true before an axis may produce a label at all.
 *
 * `facade` — something in the text names a facade (`fasada`, `demit`, `ETICS`).
 * A pile of `termoizolacija` never opens this gate, which is precisely how the
 * roofing, window and waterproofing companies stay out of the contractor label.
 *
 * `retail` — something names selling: `stovarište`, `prodaja`, `veleprodaja`,
 * `farbara`, or a wide enough assortment of building materials to be a yard.
 */
export type SignalGate = 'facade' | 'retail';

/** Where in the record a match was found. Weighted differently — see `FIELD_WEIGHTS`. */
export type ClassificationField = 'name' | 'category' | 'description' | 'website' | 'websiteText';

export interface Signal {
  /** Stable id, quoted in the evidence trail and in tests. */
  readonly id: string;
  readonly axis: SignalAxis;
  readonly strength: SignalStrength;
  /** Base weight before the field multiplier. `core` signals sit at or above `DECISION_THRESHOLD`. */
  readonly weight: number;
  /** Regex sources, matched against the folded text. Longest match over a span wins. */
  readonly patterns: readonly RegExp[];
  readonly gate?: SignalGate;
  /** Set on `adjacent` signals: the trade the match really belongs to. */
  readonly industry?: AdjacentIndustry;
  /** Which axes this disqualifier pushes down. */
  readonly suppresses?: readonly Exclude<SignalAxis, 'adjacent'>[];
  /**
   * Set on the disqualifiers that re-read the facade word itself rather than
   * merely sitting next to it — `alubond fasada`, `čišćenje fasada`. These
   * subtract from `core`, which ordinary disqualifiers never do: a company that
   * also roofs is still a facade contractor, a company that washes facades or
   * hangs composite cladding is not.
   */
  readonly cancelsCore?: boolean;
  /** Counts toward the building-materials assortment test. */
  readonly assortment?: boolean;
  /**
   * Demoted from `core` to `supporting` **and discounted to
   * `NO_ASSORTMENT_DISCOUNT` of its weight** when the record shows no building
   * materials at all. `veleprodaja` says the business sells; it does not say
   * what, and a cleaning company with a retail arm is not a stovarište. The
   * discount is the part that matters: without it the demotion only changed
   * the evidence trail, and a `supporting` 0.95 decides a label on its own.
   */
  readonly needsAssortment?: boolean;
  /** One line explaining what the term means, for the README and the UI. */
  readonly note?: string;
}

/** One matched span, with everything needed to re-read the decision later. */
export interface ClassificationEvidence {
  readonly signalId: string;
  readonly axis: SignalAxis;
  readonly strength: SignalStrength;
  readonly field: ClassificationField;
  /** The text as it appeared in the folded field, e.g. `fasaderski radovi`. */
  readonly matched: string;
  /** Base weight × field multiplier. Positive for both axes and for disqualifiers. */
  readonly weight: number;
  readonly industry?: AdjacentIndustry;
  /** Times the same signal fired in the same field. Only the first is scored. */
  readonly occurrences: number;
  /**
   * Why `weight` is below the signal's own. Set on an assortment-dependent
   * term — `veleprodaja` — in a record that names no building material: the
   * word says the business sells, not what it sells.
   */
  readonly discountedFor?: 'no-assortment';
  /** The weight the signal would have carried undiscounted. */
  readonly fullWeight?: number;
}

/**
 * A span a shorter signal wanted and a longer one took.
 *
 * `čišćenje fasada` beating `fasada` is the whole false-positive defence, so
 * the losing signal is reported rather than dropped: this is the line that
 * explains why a company advertising facades all over its page is `UNKNOWN`.
 */
export interface SuppressedMatch {
  readonly field: ClassificationField;
  /** The text that was claimed, e.g. `čišćenje fasada`. */
  readonly matched: string;
  /** The signal that claimed it. */
  readonly claimedBy: string;
  /** The signal that would otherwise have fired on part of it. */
  readonly suppressed: string;
}

export interface AxisBreakdown {
  /** Sum of `core` matches, after `cancelsCore` disqualifiers have been subtracted. */
  readonly core: number;
  readonly supporting: number;
  readonly ambiguous: number;
  /** Sum of the disqualifiers pointing at this axis. */
  readonly penalty: number;
  /**
   * `core + max(0, supporting + ambiguousCredit − penalty)`, or 0 when the gate
   * is shut. `ambiguousCredit` is capped at `core + supporting`: a word that
   * belongs to two trades corroborates real evidence, it never substitutes for
   * it, which is why no amount of `termoizolacija` produces a label on its own.
   */
  readonly net: number;
  /** The part of `ambiguous` that was allowed to count. */
  readonly ambiguousCredit: number;
  /** Facade core evidence cancelled by a `cancelsCore` disqualifier. */
  readonly coreCancelled: number;
  /** True when a manufacturer was found and no retail core evidence outweighed it. */
  readonly vetoed?: boolean;
  /** False when nothing opened the axis gate, whatever else matched. */
  readonly gateOpen: boolean;
  /** Distinct building-material product terms found. Only meaningful on `store`. */
  readonly assortment: number;
}

export interface ClassificationResult {
  readonly label: LeadClassification;
  /** 0–1. How sure the label is — never a purchase-likelihood guess. */
  readonly confidence: number;
  readonly contractor: AxisBreakdown;
  readonly store: AxisBreakdown;
  /** Every scored match, strongest first. */
  readonly evidence: readonly ClassificationEvidence[];
  readonly suppressed: readonly SuppressedMatch[];
  /** One sentence, safe to render in the review UI. */
  readonly reason: string;
  /**
   * Set only on `OUT_OF_SCOPE`: the adjacent trade that decided it. Persisted
   * to `leads.classification_industry` so the exclusion can be audited and
   * argued with, rather than being a row that quietly vanished.
   */
  readonly industry?: AdjacentIndustry;
  /**
   * Set when the label came from the source rather than from the text.
   *
   * A company listed under `nadjimajstora.rs/gradjevinski-radovi/fasader` is a
   * fasader because the directory says so, and reading its name for facade
   * words can only lose it — `Srdjan Todić` contains no evidence of anything.
   * So a pre-filtered source asserts the label and the word-scorer never gets
   * a vote.
   *
   * It is a distinct flag rather than a high confidence score because the two
   * mean different things to a reviewer, and because an audit of the
   * classifier's precision has to be able to exclude the labels it did not
   * produce.
   *
   * It also changes how the record is *scored*: an asserted result carries no
   * axis arithmetic, so `decidingNet` reports `null` for it and
   * `scoreRelevance` falls back to confidence rather than reading a net of
   * zero. Without that, asserting a label would score the lead as if there
   * were no evidence for it — see `src/lib/score/score.ts`.
   */
  readonly sourceAsserted?: boolean;
  /**
   * What the word-scorer would have said, kept for exactly that audit.
   *
   * Never used for the label. It is how we find out that a source-asserted
   * corpus reads as `UNCLASSIFIED` to the classifier — which is the
   * measurement that says whether the signal list is missing terms.
   */
  readonly inferred?: ClassificationResult;
}

export interface ClassificationInput {
  /** The business name as published. The strongest field there is. */
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  /** Categories the source filed the business under, e.g. `Termo izolacija, zvučna izolacija`. */
  readonly categories?: readonly string[] | undefined;
  /** The business's own website URL — its slug often names the trade. */
  readonly website?: string | undefined;
  /** Text pulled from the business's own site by the enrichment crawler. */
  readonly websiteText?: string | undefined;
}
