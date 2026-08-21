/**
 * The two weight tables.
 *
 * Until FUZZ-37 there was one 0–100 number folding ten components together,
 * and 66 of those 100 points were contact-channel completeness against 14 for
 * relevance. On the FUZZ-22 pilot that made `Garaza Banovina d.o.o.` — a
 * parking garage, `UNKNOWN`, no classification evidence at all — score 76,
 * ahead of the average confirmed facade contractor, because it had two phones,
 * an email, a website and a social profile. 93 unclassified leads outranked
 * the average `FACADE_CONTRACTOR`, and 32% of the top 200 rows the owner
 * actually browses were unclassified. A perfectly-documented irrelevant
 * business is still an irrelevant business, and one number could not say so.
 *
 * So there are two numbers now, and neither borrows from the other:
 *
 * - **`RELEVANCE_WEIGHTS`** — is this a lead for us? The label, how sure the
 *   classifier is, and how much evidence is behind it. Nothing about how
 *   reachable the business is. Both undecided labels score 0.
 * - **`CONTACTABILITY_WEIGHTS`** — how much contact data do we hold? The old
 *   completeness components, renormalized to 100 now that relevance has left.
 *
 * `lead_score` survives as a derived column for the export's single sort key:
 * `relevance × contactability / 100`. Relevance gates, contactability ranks.
 *
 * ## Why the contactability numbers
 *
 * | Component        | Max | Why                                                                                                  |
 * | ---------------- | --: | ---------------------------------------------------------------------------------------------------- |
 * | `phone`          |  44 | The deliverable. The product brief is phone-first: a name, a city and a phone is a good lead.         |
 * | `additionalPhone`|   7 | A second number is a second chance to reach the same business — real, but far smaller than the first. |
 * | `mobileLine`     |   5 | Sole traders answer a 06x; a landline on a yard rings a desk that may be empty.                       |
 * | `email`          |   7 | Useful for the follow-up, never a reason to keep or drop a lead.                                      |
 * | `website`        |   9 | A site is both a contact channel and corroboration that the business is real and current.             |
 * | `social`         |   5 | A Facebook or Instagram page is often the only web presence a fasader has.                            |
 * | `city`           |  12 | Scaled by `resolveCity` confidence: a landline-inferred city is a guess and scores like one.          |
 * | `corroboration`  |   7 | Two independent sources publishing the same business is the strongest liveness signal we have.        |
 * | `recency`        |   4 | A number last seen three years ago is likelier to be dead. Small, because sources go stale, not leads. |
 *
 * These are the old weights scaled by 100/86 and rounded to sum to 100 again,
 * so the ranking *within* contactability is the ranking the pilot was read
 * with. A city you can put in the `Grad` column is completeness, not
 * relevance — every lead in this database is Serbian, so knowing where one is
 * says nothing about whether it buys facade panels.
 *
 * ## The one rule that is not a weight
 *
 * A lead with no phone is capped at `NO_PHONE_CEILING`, **inside
 * contactability**. Without the cap a phone-less record with an email, a site,
 * a social profile, a resolved city and two sources would reach 44 and tie the
 * bare phone-only lead at 44 — which inverts the product. The cap guarantees
 * that **every lead with a phone outranks every lead without one**, and
 * `score.test.ts` asserts it against the new column.
 */

/* -------------------------------------------------------------------------- */
/* Contactability — how much contact data we hold                             */
/* -------------------------------------------------------------------------- */

export interface ContactabilityWeights {
  readonly phone: number;
  readonly additionalPhone: number;
  readonly mobileLine: number;
  readonly email: number;
  readonly website: number;
  readonly social: number;
  readonly city: number;
  readonly corroboration: number;
  readonly recency: number;
}

export const CONTACTABILITY_WEIGHTS: ContactabilityWeights = {
  phone: 44,
  additionalPhone: 7,
  mobileLine: 5,
  email: 7,
  website: 9,
  social: 5,
  city: 12,
  corroboration: 7,
  recency: 4,
};

/** Both tables sum to 100 by construction; `score.test.ts` holds them to it. */
export const MAX_SCORE = 100;

/**
 * A lead with no phone number can never score above this on contactability,
 * whatever else it has. The old ceiling of 25 scaled by the same 100/86.
 */
export const NO_PHONE_CEILING = 29;

/** Full marks at two extra numbers. A third adds nothing a caller can use. */
export const ADDITIONAL_PHONE_CAP = 2;

/** Full marks at three independent sources. */
export const CORROBORATION_CAP = 3;

/** Sightings inside this window are as fresh as it gets. */
export const RECENCY_FULL_DAYS = 30;

/** Recency decays linearly to zero here — a year without a sighting scores nothing. */
export const RECENCY_ZERO_DAYS = 365;

/* -------------------------------------------------------------------------- */
/* Relevance — is this a lead for us                                          */
/* -------------------------------------------------------------------------- */

export interface RelevanceWeights {
  /** The label itself: a buyer group, or not. Half the score, because it is half the answer. */
  readonly label: number;
  /** How sure the classifier is, rescaled from the floor it assigns any decided label. */
  readonly confidence: number;
  /** How much net evidence the deciding axis actually carried. */
  readonly evidence: number;
}

export const RELEVANCE_WEIGHTS: RelevanceWeights = {
  label: 50,
  confidence: 25,
  evidence: 25,
};

/**
 * How much of the `label` component each label is worth.
 *
 * `BOTH` is not worth more than a single label — it is not a better lead, just
 * a business in two segments — so all three in-scope labels score full marks.
 * `UNCLASSIFIED` and `OUT_OF_SCOPE` score zero and drag the other two
 * components to zero with them: a lead that is not a lead has no relevance to
 * be confident about.
 */
export const CLASSIFICATION_RELEVANCE: Readonly<Record<string, number>> = {
  FACADE_CONTRACTOR: 1,
  CONSTRUCTION_MATERIAL_STORE: 1,
  BOTH: 1,
  UNCLASSIFIED: 0,
  OUT_OF_SCOPE: 0,
};

/**
 * The confidence floor `classifyLead` assigns to any label it decides.
 *
 * `confidenceFor` starts at 0.5 and climbs to 0.98, so a raw confidence used
 * as a 0–1 fraction would spend half the component on being decided at all —
 * which the `label` component already pays for. Rescaling from the floor gives
 * the component its full range back.
 */
export const CONFIDENCE_FLOOR = 0.5;

/** The top of `confidenceFor`'s range. */
export const CONFIDENCE_CEILING = 0.98;

/**
 * Net evidence that earns the whole `evidence` component: twice
 * `DECISION_THRESHOLD`. A label that only just cleared the gate is a label we
 * hold more loosely than one carried by `fasaderski radovi` in the company's
 * own name, and the number should say so.
 */
export const EVIDENCE_FULL_NET = 1.8;
