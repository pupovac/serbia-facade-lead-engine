/**
 * Contact enrichment — turning a thin lead into a good one.
 *
 * A source often yields no more than `Mika Fasade · Novi Sad · 064 123 4567`,
 * or worse, a name and a website and no phone at all. Enrichment goes back to
 * the business and finds the rest: the phone, the email, the Instagram page,
 * the address, the second number.
 *
 * ## The one rule that matters
 *
 * **Only merge when the page is confidently the same business.** Everything
 * else in this directory is arrangements around that sentence:
 *
 * ```ts
 * selectTargets(db)          // which leads would gain the most?
 * readPage({ url, html, $ }) // what does this page claim?
 * assessCandidate({ … })     // is it this business? merge | suggest | discard
 * applyMerge(…) / queueSuggestions(…)
 * ```
 *
 * A name match alone is never enough. Serbia has many `Fasade Petrović`, and
 * one wrong merge writes a competitor's phone number onto a lead and quietly
 * poisons the sales list — the failure nobody notices, because the row looks
 * exactly like a good one. The rules and their thresholds are in
 * `confidence.ts` and `thresholds.ts`, they are pure, and the negative fixture
 * set in `confidence.test.ts` measures their false-merge rate.
 *
 * Politeness is not this module's invention either: every request goes through
 * the same `PoliteFetcher` an adapter uses, so `robots.txt`, the per-host rate
 * limit, the honest User-Agent and the request budget apply to a stranger's
 * hosting account exactly as they apply to a directory we crawl on purpose.
 */
export { assessCandidate, RULE_TIER } from './confidence.js';
export { applyMerge, findingsFrom, queueSuggestions } from './apply.js';
export type { ApplyOptions, ApplyResult } from './apply.js';
export { contactLinks, type ContactLink } from './contact-pages.js';
export {
  buildQuery,
  DuckDuckGoHtmlFinder,
  isChallenge,
  parseDuckDuckGoResults,
  SearchChallengedError,
  type CandidateFinder,
  type FinderContext,
  type SearchCandidate,
} from './finder.js';
export { countBusinesses, readPage, stripPageLabel, type ReadPageOptions } from './page.js';
export { runEnrichment, SUGGESTION_SAMPLE } from './run.js';
export { DEFAULT_ENRICHMENT_PATH } from './run.js';
export type { EnrichmentPath, EnrichRunOptions, EnrichSummary, SuggestionSample } from './run.js';
export {
  ENRICHMENT_SOURCE_IDS,
  OWN_SITE_SOURCE,
  SEARCH_SOURCE,
  ensureEnrichmentSources,
} from './sources.js';
export { missingFields, selectTargets, type SelectTargetsOptions } from './targets.js';
export {
  CONFIDENCE_BANDS,
  CONTACT_PAGE_KEYWORDS,
  FIELD_GAIN,
  MAX_BUSINESSES_ON_PAGE,
  MAX_PAGES_PER_SITE,
  MAX_PHONES_ON_PAGE,
  MAX_SEARCH_CANDIDATES,
  OWN_SITE_CONFIDENCE,
} from './thresholds.js';
export type * from './types.js';
