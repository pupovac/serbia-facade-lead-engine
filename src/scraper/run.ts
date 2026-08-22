/**
 * Run orchestration — the loop that turns an adapter into rows.
 *
 * It owns the parts an adapter must not: the `crawl_runs` row, the resume
 * bookkeeping, the staleness decision, the zod boundary, the failure policy and
 * the summary a human reads afterwards.
 *
 * ## Failure policy
 *
 * The three failures are treated differently on purpose:
 *
 * - **One item failed** — a timeout, a 500, a detail page that is not what it
 *   claimed. Logged with its URL, counted, the item marked `failed` so it is
 *   revisited next run, and the crawl continues. One bad page must not cost the
 *   other ten thousand.
 * - **The structure changed** — a selector the adapter guarantees matched
 *   nothing. This is a source that stopped working, not an item that failed, so
 *   it ends the run: immediately when it comes from discovery or before any
 *   item has extracted cleanly, and after `structureErrorLimit` of them
 *   otherwise. The error is re-thrown after the run row is closed as `failed`,
 *   because a source that silently produces zero leads for a month is the
 *   failure mode this project cannot have.
 * - **The budget is gone** — the run stops cleanly, `completed`, with the
 *   reason in `notes`. The fuse blew; nothing is broken.
 */
import {
  RUN_HEARTBEAT_INTERVAL_MS,
  finishRun,
  getSource,
  heartbeatRun,
  reconcileAbandonedRuns,
  startRun,
  upsertSource,
  type Db,
} from '@/lib/db';
import {
  configFromEnv,
  resolveConfig,
  type ConfigOverrides,
  type ScraperConfig,
} from './config.js';
import { DbCrawlStateStore, MemoryCrawlStateStore, type CrawlStateStore } from './crawl-state.js';
import {
  RequestBudgetExceededError,
  RobotsDisallowedError,
  StructureChangedError,
} from './errors.js';
import { PoliteFetcher, type FetchImpl, type FetchStats } from './http/fetcher.js';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { normalizeRawLead, persistLead, persistRejected } from './pipeline.js';
import { validateRawLead } from './raw-lead.js';
import {
  expectFound,
  resumeKeyOf,
  type CrawlContext,
  type RunScope,
  type ScraperLib,
  type SourceAdapter,
} from './types.js';
import * as geo from '@/lib/geo';
import * as queries from '@/lib/queries';
import {
  diacriticVariants,
  foldDiacritics,
  foldForComparison,
  normalizeWhitespace,
} from '@/lib/text/fold.js';
import { hasCyrillic, toLatin } from '@/lib/text/cyrillic.js';

/** The `src/lib` surface every adapter gets. Built once — it is all pure functions. */
export const SCRAPER_LIB: ScraperLib = {
  geo,
  queries,
  text: {
    foldDiacritics,
    foldForComparison,
    normalizeWhitespace,
    diacriticVariants,
    toLatin,
    hasCyrillic,
  },
};

/** An item that failed, as the summary reports it. */
export interface ItemFailure {
  readonly url: string;
  readonly message: string;
  readonly kind: 'http' | 'robots' | 'structure' | 'validation' | 'other';
}

/** What a run did. Printed by the CLI, stored on the `crawl_runs` row. */
export interface RunSummary {
  readonly sourceId: string;
  /** `crawl_runs.id`, or `null` under `--dry-run`. */
  readonly runId: number | null;
  readonly status: 'completed' | 'failed';
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly wallTimeMs: number;

  readonly itemsDiscovered: number;
  /** Skipped because their last scrape is inside the staleness window. */
  readonly itemsSkippedFresh: number;
  readonly itemsExtracted: number;
  readonly itemsFailed: number;

  /** Records that passed the zod boundary. */
  readonly recordsEmitted: number;
  /** Records that failed it. Stored with their error, never dropped. */
  readonly recordsRejected: number;
  /** Emitted records carrying at least one parseable phone — the primary deliverable. */
  readonly recordsWithPhone: number;

  readonly leadsCreated: number;
  readonly leadsUpdated: number;
  readonly phonesAdded: number;

  readonly requests: number;
  readonly retries: number;
  readonly budget: number;
  readonly budgetRemaining: number;
  readonly rateLimitWaitMs: number;

  /** `budget exhausted`, `limit reached`, … when the run stopped early. */
  readonly stoppedBecause: string | null;
  /** Capped at `FAILURE_SAMPLE` entries; the counts above are complete. */
  readonly failures: readonly ItemFailure[];
}

/** How many failing URLs the summary keeps. The counts stay exact. */
export const FAILURE_SAMPLE = 20;

export interface RunOptions {
  readonly adapter: SourceAdapter;
  /** Omitted or `null` under `--dry-run`; nothing is opened and nothing is written. */
  readonly db?: Db | null | undefined;
  readonly scope?: Partial<RunScope> | undefined;
  /** CLI-level config overrides — the last layer on top of the environment. */
  readonly config?: ConfigOverrides | undefined;
  readonly log?: Logger | undefined;
  readonly dryRun?: boolean | undefined;
  readonly trigger?: string | undefined;
  /** Consecutive structural failures tolerated before the run is called broken. */
  readonly structureErrorLimit?: number | undefined;
  readonly fetchImpl?: FetchImpl | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly random?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_SCOPE: RunScope = {
  municipalities: [],
  queries: [],
  limit: null,
  stalenessMs: 14 * 24 * 60 * 60 * 1000,
  rediscoverAfterMs: 24 * 60 * 60 * 1000,
  since: null,
};

function classifyFailure(error: unknown): ItemFailure['kind'] {
  if (error instanceof StructureChangedError) return 'structure';
  if (error instanceof RobotsDisallowedError) return 'robots';
  if (error instanceof Error && error.name === 'HttpError') return 'http';
  return 'other';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make sure the source has a row, because `crawl_runs.source_id` is a foreign
 * key and an adapter for a source the registry never listed still has to run.
 *
 * A row seeded from `research/sources-*.json` is left alone: it carries the
 * measured `robots_allows`, the priority and the record estimates, and an
 * adapter's three fields would overwrite all of it.
 */
function ensureSourceRow(db: Db, adapter: SourceAdapter, log: Logger): void {
  if (getSource(db, adapter.id) !== undefined) return;
  log.warn('source is not in the research registry; inserting a minimal row', {
    sourceId: adapter.id,
  });
  upsertSource(db, {
    id: adapter.id,
    name: adapter.name,
    url: adapter.baseUrl,
    category: adapter.category ?? 'adapter',
    hasContractors: adapter.leadTypes.includes('FACADE_CONTRACTOR'),
    hasStores: adapter.leadTypes.includes('CONSTRUCTION_MATERIAL_STORE'),
    requiresJs: adapter.requiresJs ?? false,
    enabled: true,
  });
}

/**
 * Run one adapter to completion.
 *
 * Returns the summary. Re-throws a `StructureChangedError` after closing the
 * run as `failed` — everything else is counted and survived.
 */
export async function runSource(options: RunOptions): Promise<RunSummary> {
  const { adapter } = options;
  const dryRun = (options.dryRun ?? options.db === undefined) || options.db === null;
  const db = dryRun ? null : (options.db ?? null);
  const log = (options.log ?? silentLogger).child(adapter.id);
  const now = options.now ?? ((): Date => new Date());
  const structureErrorLimit = options.structureErrorLimit ?? 3;

  const config: ScraperConfig = resolveConfig({
    env: configFromEnv(),
    adapter: adapter.config,
    cli: options.config,
  });

  const scope: RunScope = {
    ...DEFAULT_SCOPE,
    stalenessMs: config.stalenessMs,
    rediscoverAfterMs: config.rediscoverAfterMs,
    ...Object.fromEntries(
      Object.entries(options.scope ?? {}).filter(([, value]) => value !== undefined),
    ),
  } as RunScope;

  const startedAt = now();
  if (db !== null) ensureSourceRow(db, adapter, log);

  // Before this run is recorded, write off the ones whose process is gone.
  // A killed crawler leaves `running` behind forever and every later report
  // then counts a run that never finished.
  if (db !== null) {
    for (const abandoned of reconcileAbandonedRuns(db, { now: startedAt })) {
      log.warn('reconciled an abandoned run', {
        runId: abandoned.id,
        source: abandoned.sourceId,
        lastSeenAt: abandoned.lastSeenAt.toISOString(),
      });
    }
  }

  const runId =
    db === null
      ? null
      : startRun(db, adapter.id, {
          trigger: options.trigger ?? 'manual',
          scope: JSON.stringify({
            cities: scope.municipalities.map((municipality) => municipality.id),
            queries: scope.queries,
            limit: scope.limit,
            stalenessMs: scope.stalenessMs,
            rediscoverAfterMs: scope.rediscoverAfterMs,
            since: scope.since?.toISOString() ?? null,
          }),
          startedAt,
        });

  const state: CrawlStateStore =
    db === null ? new MemoryCrawlStateStore() : new DbCrawlStateStore(db, adapter.id, runId);

  // "Still here." Throttled, because a heartbeat on every record would be one
  // extra write per second for no extra information.
  let lastBeatAt = startedAt.getTime();
  const beat = (at: Date): void => {
    if (db === null || runId === null) return;
    if (at.getTime() - lastBeatAt < RUN_HEARTBEAT_INTERVAL_MS) return;
    lastBeatAt = at.getTime();
    heartbeatRun(db, runId, at);
  };

  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const http = new PoliteFetcher({
    config,
    log: log.child('http'),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.random === undefined ? {} : { random: options.random }),
    now: () => now().getTime(),
    signal: controller.signal,
  });

  const ctx: CrawlContext = {
    sourceId: adapter.id,
    runId,
    config,
    http,
    log,
    state,
    lib: SCRAPER_LIB,
    scope,
    signal: controller.signal,
    now,
    dryRun,
    expect: (value, selector, url, expected) =>
      expectFound(adapter.id, value, selector, url, expected),
  };

  let itemsDiscovered = 0;
  let itemsSkippedFresh = 0;
  let itemsExtracted = 0;
  let itemsFailed = 0;
  let recordsEmitted = 0;
  let recordsRejected = 0;
  let recordsWithPhone = 0;
  let leadsCreated = 0;
  let leadsUpdated = 0;
  let phonesAdded = 0;
  let structureErrors = 0;
  let stoppedBecause: string | null = null;
  const failures: ItemFailure[] = [];

  const recordFailure = (url: string, error: unknown): void => {
    itemsFailed += 1;
    const failure: ItemFailure = { url, message: messageOf(error), kind: classifyFailure(error) };
    if (failures.length < FAILURE_SAMPLE) failures.push(failure);
    log.warn('item failed', { url, kind: failure.kind, error: failure.message });
  };

  let fatal: unknown = null;

  try {
    for await (const item of adapter.discover(ctx)) {
      itemsDiscovered += 1;

      if (scope.limit !== null && recordsEmitted >= scope.limit) {
        stoppedBecause = `limit of ${scope.limit} records reached`;
        break;
      }
      if (http.budgetExhausted()) {
        stoppedBecause = `request budget of ${config.requestBudget} exhausted`;
        break;
      }

      const resumeKey = resumeKeyOf(adapter, item);
      if (!shouldVisit(state, resumeKey, scope, now())) {
        itemsSkippedFresh += 1;
        log.debug('skipping fresh item', { url: item.url });
        continue;
      }

      try {
        const emitted = await adapter.extract(item, ctx);
        itemsExtracted += 1;

        for (const candidate of emitted) {
          const validated = validateRawLead(candidate, adapter.id);
          if (!validated.ok) {
            recordsRejected += 1;
            log.warn('record failed validation', { url: item.url, error: validated.error });
            if (db !== null) {
              persistRejected(db, adapter.id, item.url, validated.value, validated.error, now());
            }
            continue;
          }

          const lead = validated.lead;
          const normalized = normalizeRawLead(
            lead,
            {
              ...(adapter.sourceOwnedEmails === undefined
                ? {}
                : { sourceOwnedEmails: adapter.sourceOwnedEmails }),
              ...(adapter.sourceOwnedProfiles === undefined
                ? {}
                : { sourceOwnedProfiles: adapter.sourceOwnedProfiles }),
            },
            now(),
          );
          recordsEmitted += 1;
          if (normalized.phoneCount > 0) recordsWithPhone += 1;
          if (normalized.cityFailure !== null) {
            log.debug('city did not resolve', {
              url: lead.sourceUrl,
              reason: normalized.cityFailure,
            });
          }

          if (db !== null) {
            const persisted = persistLead(db, lead, normalized, { runId, now: now() });
            if (persisted.created) leadsCreated += 1;
            else leadsUpdated += 1;
            phonesAdded += persisted.phonesAdded;
            beat(now());
          }

          if (scope.limit !== null && recordsEmitted >= scope.limit) break;
        }

        state.markItem(resumeKey, 'done', null, now());
      } catch (error) {
        if (error instanceof RequestBudgetExceededError) {
          stoppedBecause = error.message;
          break;
        }
        state.markItem(resumeKey, 'failed', messageOf(error), now());
        recordFailure(item.url, error);

        if (error instanceof StructureChangedError) {
          structureErrors += 1;
          // Nothing has parsed cleanly yet, or this keeps happening: the source
          // changed, it is not one odd page.
          if (itemsExtracted === 0 || structureErrors >= structureErrorLimit) {
            fatal = error;
            break;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof RequestBudgetExceededError) {
      stoppedBecause = error.message;
    } else {
      // A structural failure in `discover` is the listing page itself changing.
      fatal = error;
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  const finishedAt = now();
  const stats: FetchStats = http.stats();
  const status: RunSummary['status'] = fatal === null ? 'completed' : 'failed';

  if (db !== null && runId !== null) {
    finishRun(
      db,
      runId,
      status,
      {
        requestsMade: stats.requests,
        pagesFetched: itemsExtracted,
        recordsEmitted,
        recordsRejected,
        leadsCreated,
        leadsUpdated,
        phonesAdded,
        error: fatal === null ? null : messageOf(fatal),
        notes: stoppedBecause,
      },
      finishedAt,
    );
  }

  const summary: RunSummary = {
    sourceId: adapter.id,
    runId,
    status,
    dryRun,
    startedAt,
    finishedAt,
    wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
    itemsDiscovered,
    itemsSkippedFresh,
    itemsExtracted,
    itemsFailed,
    recordsEmitted,
    recordsRejected,
    recordsWithPhone,
    leadsCreated,
    leadsUpdated,
    phonesAdded,
    requests: stats.requests,
    retries: stats.retries,
    budget: stats.budget,
    budgetRemaining: stats.budgetRemaining,
    rateLimitWaitMs: stats.rateLimitWaitMs,
    stoppedBecause,
    failures,
  };

  log.info('run finished', {
    status,
    discovered: itemsDiscovered,
    extracted: itemsExtracted,
    failed: itemsFailed,
    records: recordsEmitted,
    withPhone: recordsWithPhone,
    requests: stats.requests,
    wallTimeMs: summary.wallTimeMs,
  });

  if (fatal !== null) throw fatal;
  return summary;
}

/**
 * Should this run visit the item at all?
 *
 * `--since` is an absolute floor and overrides the rolling window: it is what
 * you reach for after a parser fix, when "scraped last week" is exactly the set
 * you want to redo.
 */
function shouldVisit(
  state: CrawlStateStore,
  resumeKey: string,
  scope: RunScope,
  now: Date,
): boolean {
  const last = state.lastScrapedAt(resumeKey);
  if (last === null) return true;
  if (scope.since !== null) return last.getTime() < scope.since.getTime();
  return now.getTime() - last.getTime() >= scope.stalenessMs;
}

export { createLogger };
