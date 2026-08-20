/**
 * Where a crawl got to, so the next run continues instead of starting over.
 *
 * Two different things are remembered, and the difference is what makes a run
 * incremental rather than merely resumable:
 *
 * - **Discovery scopes** — whatever unit the adapter paginates over: a city
 *   page, a category, a search term. The adapter writes an opaque `cursor` (a
 *   page number, a next-page URL, an API offset) and reads it back on the next
 *   run. Nothing but the adapter that wrote it may interpret it.
 * - **Items** — one detail page each, with the time it was last scraped. A
 *   second run skips an item whose last scrape is younger than the staleness
 *   window, which is what turns the second crawl of a 11,000-record directory
 *   into a few hundred requests instead of eleven thousand.
 *
 * Both live in `crawl_state`, under namespaced keys (`scope:` / `item:`), so
 * this needed no schema change — `crawl_state` was already defined as "one row
 * per (source, scope), scope being whatever unit the adapter paginates over".
 *
 * `MemoryCrawlStateStore` is the same interface without a database. It is what
 * `--dry-run` runs against, which is how a dry run can exercise resume logic
 * and still write nothing.
 */
import { getCrawlState, saveCrawlState, type Executor } from '@/lib/db';
import type { CrawlStateStatus } from '@/lib/db';

/** Discovery-scope keys and item keys share one table; the prefix keeps them apart. */
export const SCOPE_PREFIX = 'scope:';
export const ITEM_PREFIX = 'item:';

export interface ScopeState {
  readonly cursor: string | null;
  readonly status: CrawlStateStatus;
  /** Every visit, successful or not — a scope that keeps failing is visible here. */
  readonly attempts: number;
  readonly lastError: string | null;
  readonly lastSeenAt: Date;
  readonly completedAt: Date | null;
}

export interface ScopeUpdate {
  readonly cursor?: string | null | undefined;
  readonly status?: CrawlStateStatus | undefined;
  readonly lastError?: string | null | undefined;
  readonly at?: Date | undefined;
}

/** Where discovery should start on this scope, and whether it should run at all. */
export interface ScopeResume {
  /**
   * True when the scope finished recently enough that re-walking it would only
   * re-read pages we already know. Discovery returns without a request.
   */
  readonly skip: boolean;
  /** The saved cursor to resume from, or `null` to start at the first page. */
  readonly cursor: string | null;
}

/**
 * How fresh a completed scope has to be to be worth skipping.
 *
 * Deliberately **not** the item staleness window. Re-walking a listing costs a
 * handful of requests and is how a new business is ever found; re-scraping every
 * detail page costs one request per record. They want different cadences —
 * listings often, details rarely — so they are separate numbers.
 */
export interface ScopeFreshness {
  readonly rediscoverAfterMs: number;
  /** `--since`: an absolute floor that overrides the rolling window. */
  readonly since: Date | null;
}

/**
 * The resume store, as adapters and the orchestrator see it.
 *
 * An adapter only ever needs `getScope` / `saveScope`; the item half is driven
 * by the orchestrator, which is why an adapter cannot forget to record that it
 * scraped something.
 */
export interface CrawlStateStore {
  getScope(scopeKey: string): ScopeState | undefined;
  saveScope(scopeKey: string, update?: ScopeUpdate): void;
  /**
   * What discovery should do with this scope. Call this instead of reading
   * `getScope().cursor` directly — see `resumeScope` for why the two are not
   * the same question.
   */
  resume(scopeKey: string, freshness: ScopeFreshness, now?: Date): ScopeResume;
  /** When this item was last scraped, or `null` if never. */
  lastScrapedAt(resumeKey: string): Date | null;
  /** Record a visit. `failed` still stamps the time — a broken page is not retried every hour. */
  markItem(resumeKey: string, status: 'done' | 'failed', error?: string | null, at?: Date): void;
  /** True when the item has never been scraped, or its last scrape is older than the window. */
  isStale(resumeKey: string, stalenessMs: number, now?: Date): boolean;
}

function staleAgainst(last: Date | null, stalenessMs: number, now: Date): boolean {
  if (last === null) return true;
  return now.getTime() - last.getTime() >= stalenessMs;
}

/**
 * Turn a stored scope into a discovery decision.
 *
 * The distinction that matters: **a saved cursor resumes an interrupted crawl;
 * it does not describe a finished one.** A scope that completed has no cursor
 * worth resuming, because the useful thing about re-walking a listing is the
 * entries that were not on it last time. So a completed scope starts over — but
 * only once `rediscoverAfterMs` has passed, otherwise a second run the same
 * afternoon re-reads every listing page for nothing.
 *
 * Getting this wrong is quiet in exactly the wrong way: discovery reports zero
 * items, the run is "successful", and the source silently stops producing new
 * leads the moment its first crawl finishes.
 */
export function resumeScope(
  scope: ScopeState | undefined,
  freshness: ScopeFreshness,
  now: Date,
): ScopeResume {
  // Never crawled, or interrupted partway: resume exactly where it stopped.
  if (scope === undefined) return { skip: false, cursor: null };
  if (scope.status !== 'done') return { skip: false, cursor: scope.cursor };

  // Completed. `--since` is an absolute floor and overrides the window.
  const completedAt = scope.completedAt ?? scope.lastSeenAt;
  const stale =
    freshness.since !== null
      ? completedAt.getTime() < freshness.since.getTime()
      : staleAgainst(completedAt, freshness.rediscoverAfterMs, now);

  return stale ? { skip: false, cursor: null } : { skip: true, cursor: null };
}

/** The real store: `crawl_state` rows, through the repository. */
export class DbCrawlStateStore implements CrawlStateStore {
  constructor(
    private readonly db: Executor,
    private readonly sourceId: string,
    private readonly runId: number | null = null,
  ) {}

  getScope(scopeKey: string): ScopeState | undefined {
    const row = getCrawlState(this.db, this.sourceId, `${SCOPE_PREFIX}${scopeKey}`);
    if (row === undefined) return undefined;
    return {
      cursor: row.cursor,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      lastSeenAt: row.lastSeenAt,
      completedAt: row.completedAt,
    };
  }

  saveScope(scopeKey: string, update: ScopeUpdate = {}): void {
    saveCrawlState(this.db, this.sourceId, `${SCOPE_PREFIX}${scopeKey}`, {
      ...(update.cursor === undefined ? {} : { cursor: update.cursor }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.lastError === undefined ? {} : { lastError: update.lastError }),
      ...(update.at === undefined ? {} : { seenAt: update.at }),
      lastRunId: this.runId,
    });
  }

  resume(scopeKey: string, freshness: ScopeFreshness, now: Date = new Date()): ScopeResume {
    return resumeScope(this.getScope(scopeKey), freshness, now);
  }

  lastScrapedAt(resumeKey: string): Date | null {
    const row = getCrawlState(this.db, this.sourceId, `${ITEM_PREFIX}${resumeKey}`);
    return row?.lastSeenAt ?? null;
  }

  markItem(
    resumeKey: string,
    status: 'done' | 'failed',
    error: string | null = null,
    at: Date = new Date(),
  ): void {
    saveCrawlState(this.db, this.sourceId, `${ITEM_PREFIX}${resumeKey}`, {
      status,
      lastError: error,
      lastRunId: this.runId,
      seenAt: at,
    });
  }

  isStale(resumeKey: string, stalenessMs: number, now: Date = new Date()): boolean {
    return staleAgainst(this.lastScrapedAt(resumeKey), stalenessMs, now);
  }
}

/**
 * The same store with no database behind it.
 *
 * `--dry-run` uses this: discovery and extraction run in full, resume points
 * are read from nothing and written to nowhere, and the database is not opened.
 */
export class MemoryCrawlStateStore implements CrawlStateStore {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly items = new Map<string, Date>();

  /** Seed from a real store so a dry run can still resume where the last real run stopped. */
  static seededFrom(source: CrawlStateStore, scopeKeys: readonly string[]): MemoryCrawlStateStore {
    const store = new MemoryCrawlStateStore();
    for (const key of scopeKeys) {
      const scope = source.getScope(key);
      if (scope !== undefined) store.scopes.set(key, scope);
    }
    return store;
  }

  getScope(scopeKey: string): ScopeState | undefined {
    return this.scopes.get(scopeKey);
  }

  saveScope(scopeKey: string, update: ScopeUpdate = {}): void {
    const at = update.at ?? new Date();
    const existing = this.scopes.get(scopeKey);
    const status = update.status ?? existing?.status ?? 'pending';
    this.scopes.set(scopeKey, {
      cursor: update.cursor === undefined ? (existing?.cursor ?? null) : update.cursor,
      status,
      attempts: (existing?.attempts ?? 0) + 1,
      lastError: update.lastError === undefined ? (existing?.lastError ?? null) : update.lastError,
      lastSeenAt: at,
      completedAt: status === 'done' ? at : (existing?.completedAt ?? null),
    });
  }

  resume(scopeKey: string, freshness: ScopeFreshness, now: Date = new Date()): ScopeResume {
    return resumeScope(this.getScope(scopeKey), freshness, now);
  }

  lastScrapedAt(resumeKey: string): Date | null {
    return this.items.get(resumeKey) ?? null;
  }

  markItem(
    resumeKey: string,
    _status: 'done' | 'failed',
    _error: string | null = null,
    at: Date = new Date(),
  ): void {
    this.items.set(resumeKey, at);
  }

  isStale(resumeKey: string, stalenessMs: number, now: Date = new Date()): boolean {
    return staleAgainst(this.lastScrapedAt(resumeKey), stalenessMs, now);
  }
}
