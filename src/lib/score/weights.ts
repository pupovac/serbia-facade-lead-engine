/**
 * The lead-score weight table.
 *
 * The score measures **data completeness and relevance**: how usable this row
 * is to a salesperson with a phone in their hand. It is explicitly *not* a
 * guess at whether the business will buy — nothing here knows that, and a
 * column that pretends to would be quietly trusted.
 *
 * The components sum to exactly 100, so a component's weight is also its share
 * of the score and the breakdown reads as percentages.
 *
 * ## Why these numbers
 *
 * | Component        | Max | Why                                                                                                  |
 * | ---------------- | --: | ---------------------------------------------------------------------------------------------------- |
 * | `phone`          |  38 | The deliverable. The product brief is phone-first: a name, a city and a phone is a good lead.         |
 * | `additionalPhone`|   6 | A second number is a second chance to reach the same business — real, but far smaller than the first. |
 * | `mobileLine`     |   4 | Sole traders answer a 06x; a landline on a yard rings a desk that may be empty.                       |
 * | `email`          |   6 | Useful for the follow-up, never a reason to keep or drop a lead.                                      |
 * | `website`        |   8 | A site is both a contact channel and corroboration that the business is real and current.             |
 * | `social`         |   4 | A Facebook or Instagram page is often the only web presence a fasader has.                            |
 * | `city`           |  10 | Scaled by `resolveCity` confidence: a landline-inferred city is a guess and scores like one.          |
 * | `classification` |  14 | Relevance. `UNKNOWN` scores zero — an unclassified row is not a lead we can hand to sales.            |
 * | `corroboration`  |   6 | Two independent sources publishing the same business is the strongest liveness signal we have.        |
 * | `recency`        |   4 | A number last seen three years ago is likelier to be dead. Small, because sources go stale, not leads. |
 *
 * ## The one rule that is not a weight
 *
 * A lead with no phone is capped at `NO_PHONE_CEILING`. Without the cap, a
 * phone-less record with an email, a site, a social profile, a resolved city
 * and a confident label would score 52 and outrank a phone-only lead at 42 —
 * which inverts the product. The cap guarantees that **every lead with a phone
 * outranks every lead without one**, and `score.test.ts` asserts it.
 */
export interface ScoreWeights {
  readonly phone: number;
  readonly additionalPhone: number;
  readonly mobileLine: number;
  readonly email: number;
  readonly website: number;
  readonly social: number;
  readonly city: number;
  readonly classification: number;
  readonly corroboration: number;
  readonly recency: number;
}

export const SCORE_WEIGHTS: ScoreWeights = {
  phone: 38,
  additionalPhone: 6,
  mobileLine: 4,
  email: 6,
  website: 8,
  social: 4,
  city: 10,
  classification: 14,
  corroboration: 6,
  recency: 4,
};

/** The weights sum to 100 by construction; `score.test.ts` holds them to it. */
export const MAX_SCORE = 100;

/** A lead with no phone number can never score above this, whatever else it has. */
export const NO_PHONE_CEILING = 25;

/** Full marks at two extra numbers. A third adds nothing a caller can use. */
export const ADDITIONAL_PHONE_CAP = 2;

/** Full marks at three independent sources. */
export const CORROBORATION_CAP = 3;

/** Sightings inside this window are as fresh as it gets. */
export const RECENCY_FULL_DAYS = 30;

/** Recency decays linearly to zero here — a year without a sighting scores nothing. */
export const RECENCY_ZERO_DAYS = 365;

/**
 * How much of the classification component each label is worth.
 *
 * `BOTH` is not worth more than a single label — it is not a better lead, just
 * a business in two segments — so both clear labels score full marks and the
 * component is then scaled by the classifier's own confidence.
 */
export const CLASSIFICATION_RELEVANCE: Readonly<Record<string, number>> = {
  FACADE_CONTRACTOR: 1,
  CONSTRUCTION_MATERIAL_STORE: 1,
  BOTH: 1,
  UNKNOWN: 0,
};
