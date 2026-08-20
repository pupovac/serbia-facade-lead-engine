/**
 * Finding candidate pages for a lead that has no website.
 *
 * ## What is actually available, measured
 *
 * A web search is the only way to find a page for a business we know nothing
 * about but a name and a city, and the project's rules narrow the options to
 * almost nothing:
 *
 * - No paid API without an explicit go-ahead in the issue, so no Google Places,
 *   no Bing API, no SerpAPI. ScrapeGraph has no credits provisioned.
 * - `robots.txt` is honoured, with no override parameter anywhere in the
 *   fetcher. Google (`Disallow: /search`), Bing, Brave, Ecosia, Startpage and
 *   Mojeek all disallow their result paths, so all of them are out — not
 *   "risky", out.
 * - `html.duckduckgo.com` and `lite.duckduckgo.com` publish `Allow: /`. They
 *   are the one search surface a robots-respecting crawler may read, and this
 *   is the provider built here.
 *
 * ## And what it does when the provider refuses
 *
 * Measured on 2026-08-20 from this runtime, with the project's honest
 * User-Agent: DuckDuckGo answers a handful of queries and then serves an
 * anti-bot challenge page (`anomaly.js`, a `challenge-form`) instead of
 * results. Five of the first twelve queries were challenged; every one of the
 * next forty was. It is a rate limit dressed as a CAPTCHA, and the project's
 * compliance rule covers both readings: never solve or bypass a challenge, and
 * never lie about who is asking.
 *
 * So the provider **detects the challenge and gives up**, raising
 * `SearchChallengedError`, which the run counts as `search_unavailable` and
 * reports. It does not retry with a browser User-Agent, it does not fall back
 * to a proxy, and — the failure that would actually be dangerous — it does not
 * quietly return zero results as though the business had no pages. A search
 * that was never really run must not read like a search that found nothing.
 *
 * The interface is what makes that a configuration problem rather than a dead
 * end: `CandidateFinder` is one method, and a provider that is permitted —
 * a paid API once the issue approves one, a Serbian directory's own search, a
 * self-hosted index — plugs in without touching the confidence rules, which are
 * the part of this issue that matters.
 */
import type { CheerioAPI } from 'cheerio';
import { ScraperError } from '../errors.js';
import type { PoliteFetcher } from '../http/fetcher.js';
import type { Logger } from '../logger.js';
import { MAX_SEARCH_CANDIDATES } from './thresholds.js';
import type { EnrichmentTarget } from './types.js';

/** One result worth fetching. */
export interface SearchCandidate {
  /** Absolute, redirector unwrapped. */
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  /** 1-based position in the result list. Lower is better. */
  readonly rank: number;
}

export interface FinderContext {
  readonly http: PoliteFetcher;
  readonly log: Logger;
}

/**
 * A source of candidate pages for a business.
 *
 * One method, on purpose: everything that decides whether a candidate is
 * *this* business lives in `confidence.ts`, and a finder that started scoring
 * its own results would be a second opinion about identity.
 */
export interface CandidateFinder {
  readonly id: string;
  search(target: EnrichmentTarget, ctx: FinderContext): Promise<readonly SearchCandidate[]>;
}

/** The provider answered with an anti-bot challenge. Not retryable, not solvable. */
export class SearchChallengedError extends ScraperError {
  override readonly name = 'SearchChallengedError';
  constructor(readonly provider: string) {
    super(
      `${provider} answered with an anti-bot challenge instead of results. ` +
        'Solving or bypassing it is out of bounds; configure a permitted search provider instead.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The query                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The search query for one lead.
 *
 * The name is quoted so the engine looks for the business rather than for
 * facade work in general, and the city is appended unquoted because a business
 * writes its own city a dozen ways. `kontakt` biases the result set toward the
 * page that carries a phone number, which is the whole point of the crawl.
 */
export function buildQuery(target: EnrichmentTarget): string {
  const parts = [`"${target.name.replace(/"/g, '')}"`];
  if (target.cityName !== null && target.cityName.trim() !== '') parts.push(target.cityName);
  parts.push('kontakt');
  return parts.join(' ');
}

/* -------------------------------------------------------------------------- */
/* DuckDuckGo HTML                                                            */
/* -------------------------------------------------------------------------- */

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

/** The markers DuckDuckGo's challenge page carries and a result page does not. */
const CHALLENGE_MARKERS = ['anomaly.js', 'challenge-form', 'id="challenge'];

export class DuckDuckGoHtmlFinder implements CandidateFinder {
  readonly id = 'duckduckgo-html';

  constructor(private readonly limit: number = MAX_SEARCH_CANDIDATES) {}

  async search(target: EnrichmentTarget, ctx: FinderContext): Promise<readonly SearchCandidate[]> {
    const query = buildQuery(target);
    const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}&kl=rs-sr`;
    const { body, $ } = await ctx.http.html(url);

    if (isChallenge(body)) throw new SearchChallengedError(this.id);
    return parseDuckDuckGoResults($, this.limit);
  }
}

/** True when the response is an anti-bot interstitial rather than a result page. */
export function isChallenge(body: string): boolean {
  const hasResults = /class="result__a"|class="result-link"/.test(body);
  return !hasResults && CHALLENGE_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Read a DuckDuckGo HTML result page.
 *
 * Result links are wrapped in `/l/?uddg=<encoded>` redirectors, which are
 * unwrapped here rather than followed: following one costs a request and hands
 * the crawler's interest to the engine, and the destination is right there in
 * the parameter.
 */
export function parseDuckDuckGoResults($: CheerioAPI, limit: number): SearchCandidate[] {
  const results: SearchCandidate[] = [];
  const seen = new Set<string>();

  for (const element of $('.result__a, a.result-link').toArray()) {
    const anchor = $(element);
    const href = anchor.attr('href') ?? '';
    const url = unwrap(href);
    if (url === null || seen.has(url)) continue;
    seen.add(url);

    const container = anchor.closest('.result, .web-result, tr');
    const snippet = container.find('.result__snippet, .result-snippet').first().text();
    results.push({
      url,
      title: anchor.text().replace(/\s+/g, ' ').trim(),
      snippet: snippet.replace(/\s+/g, ' ').trim(),
      rank: results.length + 1,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** `//duckduckgo.com/l/?uddg=https%3A%2F%2Ffirma.rs%2F` → `https://firma.rs/`. */
function unwrap(href: string): string | null {
  if (href === '') return null;
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  let parsed: URL;
  try {
    parsed = new URL(absolute, DDG_ENDPOINT);
  } catch {
    return null;
  }
  const target = parsed.searchParams.get('uddg');
  if (target !== null) {
    try {
      const inner = new URL(target);
      return inner.protocol === 'http:' || inner.protocol === 'https:' ? inner.toString() : null;
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // A link back into the engine is navigation, not a result.
  return /(^|\.)duckduckgo\.com$/i.test(parsed.hostname) ? null : parsed.toString();
}
