/**
 * The adapter contract.
 *
 * One requirement shapes every line of this file: **adding a source later must
 * mean writing one directory, not touching shared code.** So an adapter
 * declares what it is, discovers item references, and turns one item into raw
 * records — and everything else (HTTP, politeness, resume points, validation,
 * normalization, dedup, classification, scoring, persistence, run bookkeeping)
 * is the framework's, handed over through `CrawlContext`.
 *
 * Discovery and extraction are **two phases** rather than one loop for a
 * practical reason: a directory's listing pages and its detail pages fail at
 * different times and in different ways. Splitting them means discovery can be
 * resumed from a cursor without re-extracting anything, extraction can re-run
 * over items discovered yesterday, and a run that dies halfway costs the
 * cheaper half twice rather than the whole crawl.
 */
import type { Municipality } from '@/lib/geo';
import type { LeadType } from '@/lib/queries';
import type { ConfigOverrides, ScraperConfig } from './config.js';
import type { CrawlStateStore } from './crawl-state.js';
import { StructureChangedError } from './errors.js';
import type { PoliteFetcher } from './http/fetcher.js';
import type { Logger } from './logger.js';
import type { RawLeadInput } from './raw-lead.js';

export type { LeadType };
export type { RawLead, RawLeadInput, ScrapedLink } from './raw-lead.js';

/**
 * A reference to something worth extracting, produced by `discover`.
 *
 * It is deliberately not a lead. A listing page usually knows a URL, a name and
 * sometimes a phone; `hints` carries whatever it saw so `extract` does not have
 * to re-read the listing, and a source with everything on the listing page can
 * skip the detail fetch entirely by returning records straight from the hints.
 */
export interface DiscoveredItem {
  /** The detail page — the URL a record from this item will carry as provenance. */
  readonly url: string;
  /** The discovery scope this item came from, e.g. `city:novi-sad|term:fasader`. */
  readonly scopeKey: string;
  /** What the listing already told us. Adapter-defined. */
  readonly hints?: Readonly<Record<string, unknown>> | undefined;
  /** Human label for the log line when this item fails. Defaults to the URL. */
  readonly label?: string | undefined;
}

/** The scope one run was restricted to — the CLI's `--city`, `--query`, `--limit`. */
export interface RunScope {
  /** Resolved from `--city` against `data/serbia-geo.json`. Empty means the whole country. */
  readonly municipalities: readonly Municipality[];
  /** Search terms from `--query`, or the adapter's own from `src/lib/queries`. */
  readonly queries: readonly string[];
  /** Stop after this many records. `null` means no limit. */
  readonly limit: number | null;
  /** Re-scrape an item whose last scrape is older than this. */
  readonly stalenessMs: number;
  /** Re-walk a completed listing scope once it is older than this. */
  readonly rediscoverAfterMs: number;
  /** `--since` — an absolute floor that overrides the staleness window. */
  readonly since: Date | null;
}

/** The `src/lib` helpers, handed to adapters so none of them re-implements one. */
export interface ScraperLib {
  readonly geo: typeof import('@/lib/geo');
  readonly queries: typeof import('@/lib/queries');
  readonly text: {
    readonly foldDiacritics: (value: string) => string;
    readonly foldForComparison: (value: string) => string;
    readonly normalizeWhitespace: (value: string) => string;
    readonly diacriticVariants: (term: string) => string[];
    readonly toLatin: (value: string) => string;
    readonly hasCyrillic: (value: string) => boolean;
  };
}

/**
 * Everything an adapter is allowed to reach, and nothing it should own.
 *
 * There is no database handle here on purpose. An adapter cannot write a lead
 * even by accident — the persistence layer owns merging and deduplication, and
 * `pipeline.ts` is the only caller of it.
 */
export interface CrawlContext {
  readonly sourceId: string;
  /** `crawl_runs.id`, or `null` under `--dry-run`. */
  readonly runId: number | null;
  readonly config: ScraperConfig;
  /** The only route to the network: robots, rate limit, retries, budget. */
  readonly http: PoliteFetcher;
  readonly log: Logger;
  readonly state: CrawlStateStore;
  readonly lib: ScraperLib;
  readonly scope: RunScope;
  /** Aborted when the run is cancelled or the request budget runs out. */
  readonly signal: AbortSignal;
  /** The clock, injected so a test can fix "now". */
  readonly now: () => Date;
  readonly dryRun: boolean;
  /**
   * Assert that a selector found something.
   *
   * The whole point of `StructureChangedError` runs through this call: a
   * redesigned listing page must break the run loudly instead of reporting a
   * healthy crawl with zero leads. Use it for anything the source guarantees —
   * the listing container, the name on a detail page — and plain optional
   * handling for anything it does not, like a phone that many listings simply
   * lack.
   */
  expect<T>(
    value: T | null | undefined | readonly T[],
    selector: string,
    url: string,
    expected?: string,
  ): T;
}

/**
 * What a source is, and how to crawl it.
 *
 * `discover` is an async iterable so an adapter can yield a listing page's
 * items as it parses them and save its cursor between pages — a source with
 * 11,000 records never has to hold 11,000 items in memory, and a run that stops
 * halfway has still recorded where it stopped.
 */
export interface SourceAdapter {
  /** Registry slug, matching `research/sources-*.json` and `sources.id`. */
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Which buyer groups this source is expected to yield. */
  readonly leadTypes: readonly LeadType[];
  /** Free text mirroring the registry's `category`, for the `sources` row. */
  readonly category?: string | undefined;
  /** True only when the content genuinely requires JS rendering. Justify it in the PR. */
  readonly requiresJs?: boolean | undefined;
  /**
   * Politeness overrides. An adapter may make the crawl gentler than the
   * environment asks for; it can never make it harsher.
   */
  readonly config?: ConfigOverrides | undefined;
  /** Addresses and profiles the directory itself publishes on every listing. */
  readonly sourceOwnedEmails?: readonly string[] | undefined;
  readonly sourceOwnedProfiles?: readonly string[] | undefined;

  /** Listing pages → item references. Save the cursor as you go. */
  discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem>;

  /** One item → the records it holds. Usually one; a listing block can hold many. */
  extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]>;

  /**
   * The stable identity of an item across runs — what `last_scraped_at` is
   * keyed by. Defaults to the URL, which is right whenever the URL is stable.
   * Override it when the source decorates URLs with session or tracking
   * parameters, or the same page would look new on every run.
   */
  resumeKey?(item: DiscoveredItem): string;
}

/** The default `resumeKey`: the item's URL. */
export function resumeKeyOf(adapter: SourceAdapter, item: DiscoveredItem): string {
  return adapter.resumeKey?.(item) ?? item.url;
}

/**
 * The implementation behind `ctx.expect`.
 *
 * An empty array counts as nothing found, which is the case that actually bites
 * — `$('.listing-item')` returning zero elements is exactly what a redesign
 * looks like, and it is not falsy.
 */
export function expectFound<T>(
  sourceId: string,
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string | undefined,
): T {
  const missing =
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'string' && value.trim() === '');
  if (missing) {
    throw new StructureChangedError({ sourceId, url, selector, expected });
  }
  return value as T;
}
