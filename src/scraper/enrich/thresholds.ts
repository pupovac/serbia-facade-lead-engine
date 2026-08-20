/**
 * Every number the enrichment crawler decides on, in one file, with the reason
 * it has the value it has.
 *
 * ## The thresholds, stated explicitly
 *
 * | Outcome   | Confidence | What it takes                                                                                       |
 * | --------- | ---------- | --------------------------------------------------------------------------------------------------- |
 * | `merge`   | ≥ 0.90     | The page is on the lead's **own domain**, or a **decisive identifier** is shared (phone, domain, email, matični broj), or a **name match in the same place with corroboration** behind it (shared address, shared social profile, two landlines in one subscriber range). |
 * | `suggest` | 0.50–0.89  | A strong name match in the same place with **nothing** corroborating it; corroboration with no name match; a decisive signal the quarantine has disarmed. |
 * | `discard` | < 0.50     | Nothing connects the page to this lead, the lead has no city so a name can never be placed, the page describes many businesses, or the page is a directory reached by search. |
 *
 * The bands are `src/lib/dedup`'s, deliberately and by import rather than by
 * copy: enrichment is asking the same question the deduplicator asks — *are
 * these the same business?* — and two answers to one question drift apart the
 * first time either is tuned. What enrichment adds on top is asymmetry (the
 * business's own site is trusted by ownership, not by inference) and three
 * vetoes the deduplicator has no reason to have, because it never reads an
 * arbitrary page off the open web.
 *
 * ## The rule underneath all of it
 *
 * **A name match alone never merges anything.** Serbia has many `Fasade
 * Petrović`; `scoreMatch` already refuses to merge on a name without
 * corroboration, and every rule here inherits that refusal rather than
 * re-deciding it. The negative fixture set in `confidence.test.ts` is what
 * holds it to that, and its measured false-merge rate is zero.
 */
import { BANDS } from '@/lib/dedup';

/**
 * The confidence band each outcome is clamped into.
 *
 * Re-exported from the deduplicator rather than redefined. `merge` starts at
 * 0.90, `suggest` runs 0.50–0.89, `discard` is everything below.
 */
export const CONFIDENCE_BANDS = {
  merge: BANDS.merge,
  suggest: BANDS.review,
  discard: BANDS.distinct,
} as const;

/**
 * How confident "this page is on the business's own domain" is.
 *
 * Not 1.0. The domain is on the lead because some source published it, and a
 * source can be wrong — a directory that printed the wrong website for a
 * fasader puts a stranger's domain on the lead, and everything on it would
 * then be merged. It is the highest confidence the crawler ever reports, and
 * it still is not certainty.
 */
export const OWN_SITE_CONFIDENCE = 0.97;

/**
 * How many distinct businesses a page may describe before it is refused as a
 * source of contact details.
 *
 * A business's own contact page publishes one business's numbers; a category
 * page on a directory publishes forty. Reading the second as the first is the
 * single most damaging thing this crawler could do, because every phone on it
 * belongs to somebody, so the guard is a hard veto rather than a penalty and
 * it applies on the own-site path too — a fasader whose site has a "partneri"
 * page is not an exception worth carving out.
 *
 * Two rather than one: a real contact page routinely carries the owner's mobile
 * and the office landline, and a business with two branches lists both.
 */
export const MAX_BUSINESSES_ON_PAGE = 2;

/**
 * How many distinct phone numbers one page may publish before it is read as a
 * listing rather than as one business's contact page.
 *
 * The proxy for `MAX_BUSINESSES_ON_PAGE` when the page has no structured
 * markup to count businesses from. A fasader with a mobile, an office line, a
 * fax and a second branch is four; a directory page is thirty.
 */
export const MAX_PHONES_ON_PAGE = 6;

/* -------------------------------------------------------------------------- */
/* Crawl shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How many pages one lead's own site is worth.
 *
 * The homepage plus up to three contact-bearing pages. The cap is politeness
 * arithmetic, not caution: 31 leads × 4 pages is 124 requests, and at the
 * default one request per second per host that is a crawl a small Serbian
 * hosting account does not notice.
 */
export const MAX_PAGES_PER_SITE = 4;

/** How many search results are evaluated for a lead with no website. */
export const MAX_SEARCH_CANDIDATES = 5;

/**
 * Anchor text and hrefs that mean "the page with the phone number on it",
 * in both diacritic and ASCII-folded form, Serbian first.
 *
 * Ranked: a link that says `kontakt` is a better bet than one that says
 * `o nama`, and both beat guessing URLs that mostly 404.
 */
export const CONTACT_PAGE_KEYWORDS: readonly (readonly [pattern: string, rank: number])[] = [
  ['kontakt', 100],
  ['contact', 95],
  ['kontaktirajte', 90],
  ['pisite-nam', 85],
  ['pisite nam', 85],
  ['o-nama', 70],
  ['o nama', 70],
  ['about', 65],
  ['about-us', 65],
  ['impressum', 60],
  ['lokacije', 55],
  ['prodajna-mesta', 55],
  ['gde-smo', 50],
  ['nadji-nas', 50],
];

/**
 * The lead-score weight each missing field would add if enrichment filled it.
 *
 * Straight from `src/lib/score`'s weight table rather than re-invented, so the
 * ordering the crawler spends its budget by is the ordering the product
 * actually values. `phone` carries the ceiling removal with it, which is why it
 * dominates everything else combined.
 */
export const FIELD_GAIN = {
  /** 38 for the number, 4 for a mobile, and the no-phone ceiling comes off. */
  phone: 42,
  email: 6,
  website: 8,
  social: 4,
  /** The address is not scored directly; it is corroboration for every later match. */
  address: 2,
  city: 10,
} as const;
