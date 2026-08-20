/**
 * Every number the deduplicator uses, in one file, with the reason it has the
 * value it has.
 *
 * They are here rather than inline because a threshold buried in a conditional
 * is a threshold nobody re-derives when the corpus changes. The name-similarity
 * cut-off is not defined here at all — it is
 * `RECOMMENDED_NAME_MATCH_THRESHOLD` from `src/lib/normalize`, measured against
 * the true-positive and true-negative name corpora in `name.test.ts`, and a
 * second copy of it would drift.
 */

/* -------------------------------------------------------------------------- */
/* Decision bands                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The three bands a score is clamped into once the rules have chosen a verdict.
 *
 * The rules decide, not the arithmetic: a shared phone merges whatever the
 * name similarity says, and a 0.99 name match in one city still only reaches
 * `review` on its own. The score's job inside a band is to order the review
 * queue, so the bands do not overlap and the band a score falls in always names
 * the decision that produced it.
 */
export const BANDS = {
  merge: { min: 0.9, max: 1 },
  review: { min: 0.5, max: 0.89 },
  distinct: { min: 0, max: 0.49 },
} as const;

/* -------------------------------------------------------------------------- */
/* Signal weights                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How much each signal contributes, combined as a noisy-or
 * (`1 - Π(1 - w)`) so two independent pieces of evidence reinforce without ever
 * summing past 1.
 *
 * The decisive four sit near the top of the range because they *are* the
 * decision; their exact values only matter for ordering one merge against
 * another in the log.
 */
export const SIGNAL_WEIGHTS = {
  /** A state-issued unique key. The only signal stronger than a phone. */
  registrationNumber: 0.98,
  /** The primary identifier of this whole project. */
  phone: 0.95,
  websiteDomain: 0.92,
  email: 0.9,
  /** Same building, same business — but two firms share an address often enough. */
  address: 0.45,
  /** One Facebook page is one business, and a directory's own page is filtered upstream. */
  socialProfile: 0.55,
  /**
   * Both landlines in the same area code. Almost nothing — every business in
   * Belgrade is `011` — so it is weight and never corroboration.
   */
  phoneAreaCode: 0.1,
  /**
   * Two landlines in the same subscriber range — every digit but the last two
   * (`011 444 5501` and `011 444 5502`): two extensions of one switchboard far
   * more often than two unrelated companies. This is what corroborates a name
   * match, and the reason the range is that tight is that anything looser is
   * just the town exchange.
   */
  phoneBlock: 0.4,
} as const;

/**
 * A name match at exactly the recommended threshold is worth `min`; a perfect
 * match is worth `max`. Neither is close to `BANDS.merge.min` on its own, which
 * is the arithmetic saying what the rules say: a name never merges anything by
 * itself.
 */
export const NAME_WEIGHT = { min: 0.35, max: 0.6 } as const;

/**
 * Below the recommended threshold but above this, a name is logged as weak
 * supporting evidence rather than ignored: it is what makes a pair with a
 * shared address and a half-matching name reach `review` instead of vanishing.
 */
export const WEAK_NAME_MIN = 0.65;

/** The most a sub-threshold name can contribute. */
export const WEAK_NAME_WEIGHT = 0.15;

/**
 * Two leads placed in different cities. Not a veto — a company with a yard in
 * Novi Sad and an office in Belgrade is one business and one phone call — but
 * it is evidence against, and it is why a name match requires the same city
 * before it counts at all.
 */
export const CITY_CONFLICT_PENALTY = 0.25;

/* -------------------------------------------------------------------------- */
/* Quarantine                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How many *distinct businesses* one decisive value may be attached to before
 * it stops being allowed to decide anything.
 *
 * The counts are of businesses, not rows: one fasader listed by eight
 * directories is eight rows and one business, and quarantining that number
 * would throw away the strongest signal in the system. The failure this guards
 * against is the other one — a call-centre or landlord number that five
 * unrelated companies publish, which chain-merges all five and then everything
 * they each match, until a hundred businesses are one row.
 *
 * Phones are the tightest because they are the strongest signal and therefore
 * the most damaging when wrong. A domain is looser: a real group of companies
 * does trade under one site, and `mojafirma.rs/kontakt` listing three brands is
 * a normal thing to find.
 */
export const QUARANTINE_LIMITS = {
  phone: 4,
  website_domain: 6,
  email: 4,
} as const;

/** How many of the distinct names to keep on the row, for a human to judge it by. */
export const QUARANTINE_SAMPLE_NAMES = 6;

/**
 * Two names count as the same business while counting the spread of a shared
 * value. Deliberately below `RECOMMENDED_NAME_MATCH_THRESHOLD`: here a false
 * "same business" only makes the guard slightly more permissive, whereas
 * over-counting spellings of one name would quarantine a perfectly good phone.
 */
export const SAME_BUSINESS_SIMILARITY = 0.75;

/* -------------------------------------------------------------------------- */
/* Sweep                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How many merge rounds a sweep runs before giving up.
 *
 * A merge can create a new match — A and B merge on a phone, and the union now
 * shares a domain with C — so the sweep repeats until a round changes nothing.
 * The cap is a guard against a rule that oscillates, not an expected limit;
 * reaching it is reported, never silent.
 */
export const MAX_SWEEP_ROUNDS = 8;

/**
 * Leads compared per city block before the fuzzy name pass gives up on that
 * city and says so.
 *
 * Name matching inside a city is quadratic, and Belgrade will not stay small.
 * A silent cap would read as "no duplicates found"; this one is counted and
 * reported in `SweepStats.blocksTruncated` so a truncated pass is visible.
 */
export const MAX_CITY_BLOCK = 2000;
