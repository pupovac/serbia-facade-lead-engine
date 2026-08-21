/**
 * Source-asserted classification — a label the directory gave us.
 *
 * The pilot classified 3,601 leads and found 49 facade contractors, because
 * every source it had was a general business directory and the only way to
 * recover the facade slice was to read company names for facade words. That
 * works on `TERMO FASADE d.o.o.` and fails on `Srdjan Todić`, which is what
 * most of this trade is actually called.
 *
 * A contractor-only listing removes the guess. A profile filed under
 * `nadjimajstora.rs/gradjevinski-radovi/fasader` is a fasader by construction:
 * the tradesman picked the trade, the site enforces one trade per profile, and
 * the page never has to say the word "fasada" for that to be true. Running such
 * a record through the word-scorer cannot add information and can only take the
 * label away — an undecided label on a record the source already identified is a
 * bug, not caution.
 *
 * So an adapter over a pre-filtered source asserts the label, and this is how
 * it says so in the shape the rest of the system already reads. The inferred
 * result rides along under `inferred` so the classifier's own view of these
 * records stays measurable.
 */
import { IN_SCOPE_CLASSIFICATIONS } from '../db/schema.js';
import type { AxisBreakdown, ClassificationResult } from './types.js';

/** An axis with no evidence on it: nothing was scored, because nothing was read. */
const EMPTY_AXIS: AxisBreakdown = {
  core: 0,
  supporting: 0,
  ambiguous: 0,
  penalty: 0,
  net: 0,
  ambiguousCredit: 0,
  coreCancelled: 0,
  gateOpen: false,
  assortment: 0,
};

export interface AssertedClassificationInput {
  /**
   * The label the source's own taxonomy establishes. A buyer group, always —
   * neither undecided label can be *asserted*, which is what
   * `IN_SCOPE_CLASSIFICATIONS` is narrowing to here.
   */
  readonly label: (typeof IN_SCOPE_CLASSIFICATIONS)[number];
  /**
   * Why the source is entitled to assert it — the category walked, in the
   * source's words. `listed under gradjevinski-radovi/fasader` is the whole
   * argument, and a reviewer can re-open it from the record's `sourceUrl`.
   */
  readonly reason: string;
  /**
   * What the word-scorer said about the same record, when it was run for audit.
   * Optional: an adapter that does not care to measure may omit it.
   */
  readonly inferred?: ClassificationResult | undefined;
}

/**
 * Build the result for a label the source established.
 *
 * Confidence is 1: not a flourish, a statement about where the number comes
 * from. Every other confidence in this module is a scorer's opinion of its own
 * word matches; this one reports that the directory filed the business under
 * the trade, which is either true or the source changed shape.
 */
export function assertClassification(input: AssertedClassificationInput): ClassificationResult {
  return {
    label: input.label,
    confidence: 1,
    contractor: EMPTY_AXIS,
    store: EMPTY_AXIS,
    evidence: [],
    suppressed: [],
    reason: `Source-asserted: ${input.reason}. The listing is pre-filtered by trade, so the name was not read for evidence.`,
    sourceAsserted: true,
    ...(input.inferred === undefined ? {} : { inferred: input.inferred }),
  };
}
