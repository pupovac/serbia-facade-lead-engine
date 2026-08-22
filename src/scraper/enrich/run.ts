/**
 * The enrichment run: pick targets, fetch pages, decide, apply.
 *
 * It is the sibling of `src/scraper/run.ts` and shares its machinery — the same
 * `PoliteFetcher`, so `robots.txt`, the per-host rate limit, the honest
 * User-Agent, the retry ladder and the request budget all apply to a stranger's
 * hosting account exactly as they apply to a directory we crawl on purpose. It
 * is not a `SourceAdapter`, because it does not discover businesses; it starts
 * from businesses we already have and goes looking for the rest of their
 * contact details.
 *
 * ## The two paths
 *
 * - **A lead with a website.** Fetch the homepage, read the site's own
 *   navigation for its contact page, fetch up to `MAX_PAGES_PER_SITE` in total.
 *   High confidence by ownership: the business publishes the page.
 * - **A lead with no website.** Search by name and city and evaluate what comes
 *   back. Every candidate goes through the same confidence gate, which merges
 *   almost nothing on this path and is meant to.
 *
 * ## What it counts, and why the rejections are counted too
 *
 * A crawl that reports "42 fields added" and nothing else cannot be audited: a
 * run that found nothing and a run that found plenty and threw it all away look
 * identical. So every candidate page ends in exactly one bucket — merged,
 * suggested, or rejected with a named reason — and the totals are printed.
 */
import {
  RUN_HEARTBEAT_INTERVAL_MS,
  finishRun,
  heartbeatRun,
  reconcileAbandonedRuns,
  saveCrawlState,
  startRun,
  type Db,
} from '@/lib/db';
import { loadQuarantine, type Quarantine } from '@/lib/dedup';
import { HttpError, RequestBudgetExceededError, RobotsDisallowedError } from '../errors.js';
import {
  configFromEnv,
  resolveConfig,
  type ConfigOverrides,
  type ScraperConfig,
} from '../config.js';
import { PoliteFetcher, type FetchImpl } from '../http/fetcher.js';
import { silentLogger, type Logger } from '../logger.js';
import { applyMerge, findingsFrom, queueSuggestions } from './apply.js';
import { assessCandidate } from './confidence.js';
import { contactLinks } from './contact-pages.js';
import { DuckDuckGoHtmlFinder, SearchChallengedError, type CandidateFinder } from './finder.js';
import { readPage } from './page.js';
import { selectTargets, type SelectTargetsOptions } from './targets.js';
import {
  ENRICHMENT_SOURCE_IDS,
  OWN_SITE_SOURCE,
  SEARCH_SOURCE,
  ensureEnrichmentSources,
  leadScopeKey,
} from './sources.js';
import { MAX_PAGES_PER_SITE, MAX_SEARCH_CANDIDATES } from './thresholds.js';
import type {
  ConfidenceVerdict,
  EnrichableField,
  EnrichmentTarget,
  PageEvidence,
  RejectionReason,
} from './types.js';

/** Which paths a run is allowed to take. */
export type EnrichmentPath = 'own-site' | 'search' | 'both';

/**
 * `own-site`, not `both`.
 *
 * FUZZ-22 measured the search path across a full pilot: **111 attempts, zero
 * candidates.** `html.duckduckgo.com` answers 403 or an anti-bot challenge and
 * `lite.duckduckgo.com` does not answer at all, so every one of those requests
 * bought nothing — and they were requests the own-site path, which converted
 * 447 of 600, could have spent. A nationwide run must not repeat that, so the
 * path a permitted provider does not exist for is off unless somebody asks for
 * it by name.
 *
 * `own-site` stays on and stays the default. Re-check
 * `research/2026-08-21-fuzz33-search-providers.md` before turning this back on.
 */
export const DEFAULT_ENRICHMENT_PATH: EnrichmentPath = 'own-site';

export interface EnrichRunOptions {
  /** `null` under `--dry-run`: nothing is opened and nothing is written. */
  readonly db?: Db | null | undefined;
  readonly log?: Logger | undefined;
  readonly config?: ConfigOverrides | undefined;
  readonly dryRun?: boolean | undefined;
  readonly path?: EnrichmentPath | undefined;
  readonly select?: SelectTargetsOptions | undefined;
  /** Stop after this many leads. */
  readonly limit?: number | null | undefined;
  readonly trigger?: string | undefined;
  /** Swapped for a fixture server in the tests. */
  readonly fetchImpl?: FetchImpl | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly random?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Defaults to the DuckDuckGo HTML provider. */
  readonly finder?: CandidateFinder | undefined;
}

/** One page that ended in the review queue, for the run log. */
export interface SuggestionSample {
  readonly leadId: number;
  readonly leadName: string;
  readonly url: string;
  readonly rule: string;
  readonly confidence: number;
  readonly values: number;
}

export interface EnrichSummary {
  readonly runId: number | null;
  readonly status: 'completed' | 'failed';
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly wallTimeMs: number;

  /** Leads that were candidates for enrichment at all. */
  readonly targetsSelected: number;
  /** Leads the crawler asked about — including the ones that answered nothing. */
  readonly leadsProcessed: number;
  /** Leads that gained at least one value. */
  readonly leadsEnriched: number;
  readonly pagesFetched: number;

  readonly pagesMerged: number;
  readonly pagesSuggested: number;
  readonly pagesRejected: number;

  /** How many values were attached, by field. The headline number. */
  readonly fieldsAdded: Readonly<Partial<Record<EnrichableField, number>>>;
  /** Leads that gained their first phone number — the deliverable. */
  readonly leadsGainedFirstPhone: number;
  readonly suggestionsQueued: number;
  /** Every rejection, by named reason. Sums to `pagesRejected` plus the fetch failures. */
  readonly rejections: Readonly<Partial<Record<RejectionReason, number>>>;
  readonly suggestionSamples: readonly SuggestionSample[];

  /** Total score points enrichment added across every lead it touched. */
  readonly scorePointsAdded: number;

  readonly requests: number;
  readonly budget: number;
  readonly budgetRemaining: number;
  readonly rateLimitWaitMs: number;
  readonly stoppedBecause: string | null;
}

/** How many suggested pages the summary names. The counts stay exact. */
export const SUGGESTION_SAMPLE = 20;

/**
 * Run enrichment to completion.
 *
 * Never throws for one bad page: a timeout, a 404, a `robots.txt` disallow and
 * a search provider that refuses to answer are all counted and survived. It
 * stops early only when the request budget is spent or the run is cancelled.
 */
export async function runEnrichment(options: EnrichRunOptions): Promise<EnrichSummary> {
  const dryRun = (options.dryRun ?? options.db === undefined) || options.db === null;
  const db = dryRun ? null : (options.db ?? null);
  const log = (options.log ?? silentLogger).child('enrich');
  const now = options.now ?? ((): Date => new Date());

  const config: ScraperConfig = resolveConfig({
    env: configFromEnv(),
    cli: options.config,
  });

  const startedAt = now();
  if (db !== null) ensureEnrichmentSources(db, startedAt);

  // Same startup reconciliation as `src/scraper/run.ts`: a killed enrichment
  // process leaves `running` behind exactly as a killed crawler does.
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
      : startRun(db, OWN_SITE_SOURCE, {
          trigger: options.trigger ?? 'manual',
          scope: JSON.stringify({
            path: options.path ?? DEFAULT_ENRICHMENT_PATH,
            limit: options.limit ?? null,
            select: options.select ?? {},
          }),
          startedAt,
        });

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

  const path = options.path ?? DEFAULT_ENRICHMENT_PATH;
  const finder = options.finder ?? new DuckDuckGoHtmlFinder(MAX_SEARCH_CANDIDATES);
  // Asking for the blocked path is allowed — it is how the next person
  // re-measures it — but it never happens silently.
  if (path !== 'own-site' && options.finder === undefined) {
    log.warn(
      `--path ${path} will use ${finder.id}, which returned 0 candidates in 111 attempts ` +
        'during the FUZZ-22 pilot (HTTP 403 or an anti-bot challenge on every query). ' +
        'It is off by default for that reason. Pass a permitted provider to re-enable it; ' +
        'see research/2026-08-21-fuzz33-search-providers.md.',
    );
  }
  const tally = new Tally();
  let stoppedBecause: string | null = null;

  // The path restriction has to reach the *selection*, not just the loop:
  // `--path own-site --limit 5` must mean "the five best leads that have a
  // website", not "the five best leads, of which the ones with a website".
  const targets =
    db === null
      ? []
      : selectTargets(db, {
          ...(options.select ?? {}),
          ...(path === 'own-site' ? { withWebsiteOnly: true } : {}),
          ...(path === 'search' ? { withoutWebsiteOnly: true } : {}),
          limit: options.limit ?? options.select?.limit ?? null,
          sourceIds: ENRICHMENT_SOURCE_IDS,
          now: startedAt,
        });

  if (db === null) {
    log.warn('dry run: enrichment reads the lead database, so there is nothing to do');
  }

  const quarantine = db === null ? undefined : loadQuarantine(db);

  // Throttled, for the same reason as in `src/scraper/run.ts`.
  let lastBeatAt = startedAt.getTime();
  const beat = (at: Date): void => {
    if (db === null || runId === null) return;
    if (at.getTime() - lastBeatAt < RUN_HEARTBEAT_INTERVAL_MS) return;
    lastBeatAt = at.getTime();
    heartbeatRun(db, runId, at);
  };

  try {
    for (const target of targets) {
      beat(now());
      if (controller.signal.aborted) {
        stoppedBecause = 'run cancelled';
        break;
      }
      if (http.budgetExhausted()) {
        stoppedBecause = `request budget of ${config.requestBudget} exhausted`;
        break;
      }

      const hasWebsite = target.websites.length > 0;
      const usePath = hasWebsite ? 'own-site' : 'search';
      if (path !== 'both' && path !== usePath) continue;

      const before = target.record.phones.length;
      const sourceId = usePath === 'own-site' ? OWN_SITE_SOURCE : SEARCH_SOURCE;
      const ctx: PathContext = { http, log, quarantine, runId, now, tally, finder };
      let touched = false;
      try {
        touched =
          usePath === 'own-site'
            ? await enrichFromOwnSite(db as Db, target, ctx)
            : await enrichFromSearch(db as Db, target, ctx);
      } catch (error) {
        if (error instanceof RequestBudgetExceededError) {
          stoppedBecause = `request budget of ${config.requestBudget} exhausted`;
          break;
        }
        /* c8 ignore next 3 -- per-page failures are handled below this level */
        log.warn('lead failed', { leadId: target.leadId, error: messageOf(error) });
      }

      if (touched) {
        tally.leadsProcessed += 1;
        if (before === 0 && tally.lastLeadGainedPhone) tally.leadsGainedFirstPhone += 1;
        // Recorded whatever the outcome was, including "its site had nothing on
        // it". `touched` is false only when the crawler never got as far as
        // asking — a search provider that refused — and that is worth retrying.
        saveCrawlState(db as Db, sourceId, leadScopeKey(target.leadId), {
          status: 'done',
          lastRunId: runId,
          seenAt: now(),
        });
      }
      tally.lastLeadGainedPhone = false;
    }
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  const finishedAt = now();
  const stats = http.stats();
  const summary: EnrichSummary = {
    runId,
    status: 'completed',
    dryRun,
    startedAt,
    finishedAt,
    wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
    targetsSelected: targets.length,
    leadsProcessed: tally.leadsProcessed,
    leadsEnriched: tally.enrichedLeads.size,
    pagesFetched: tally.pagesFetched,
    pagesMerged: tally.pagesMerged,
    pagesSuggested: tally.pagesSuggested,
    pagesRejected: tally.pagesRejected,
    fieldsAdded: tally.fieldsAdded,
    leadsGainedFirstPhone: tally.leadsGainedFirstPhone,
    suggestionsQueued: tally.suggestionsQueued,
    rejections: tally.rejections,
    suggestionSamples: tally.suggestionSamples,
    scorePointsAdded: tally.scorePointsAdded,
    requests: stats.requests,
    budget: stats.budget,
    budgetRemaining: stats.budgetRemaining,
    rateLimitWaitMs: stats.rateLimitWaitMs,
    stoppedBecause,
  };

  if (db !== null && runId !== null) {
    finishRun(
      db,
      runId,
      'completed',
      {
        requestsMade: stats.requests,
        pagesFetched: tally.pagesFetched,
        recordsEmitted: tally.pagesMerged,
        leadsUpdated: tally.enrichedLeads.size,
        phonesAdded: tally.fieldsAdded.phone ?? 0,
        notes: JSON.stringify({
          fieldsAdded: tally.fieldsAdded,
          suggestionsQueued: tally.suggestionsQueued,
          rejections: tally.rejections,
          stoppedBecause,
        }),
      },
      finishedAt,
    );
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* The two paths                                                              */
/* -------------------------------------------------------------------------- */

interface PathContext {
  readonly http: PoliteFetcher;
  readonly log: Logger;
  readonly quarantine: Quarantine | undefined;
  readonly runId: number | null;
  readonly now: () => Date;
  readonly tally: Tally;
  readonly finder?: CandidateFinder | undefined;
}

/**
 * The high-confidence path: the lead's own site.
 *
 * The homepage is fetched first and always, because a small business's phone
 * number is in the footer of every page far more often than it is on a page
 * called `/kontakt`. The contact links come out of that same response, so
 * finding the contact page costs no extra request.
 */
async function enrichFromOwnSite(
  db: Db,
  target: EnrichmentTarget,
  ctx: PathContext,
): Promise<boolean> {
  const home = target.websites[0];
  /* c8 ignore next -- the caller only routes here when a website exists */
  if (home === undefined) return false;

  // Attempted, whatever comes back. A site that answers 404, or a `robots.txt`
  // that says no, is a durable fact about this lead — recording the visit is
  // what stops the next run from putting the same unreachable site back at the
  // top of the queue, forever, because its potential gain is still the highest.
  const first = await fetchPage(home, ctx);
  if (first === null) return true;

  handle(db, target, first.evidence, 'own_site', OWN_SITE_SOURCE, ctx);

  const links = contactLinks(first.$, first.evidence.finalUrl, MAX_PAGES_PER_SITE - 1);
  for (const link of links) {
    if (ctx.http.budgetExhausted()) break;
    const next = await fetchPage(link.url, ctx);
    if (next === null) continue;
    ctx.log.debug('contact page', { url: link.url, keyword: link.keyword });
    handle(db, target, next.evidence, 'own_site', OWN_SITE_SOURCE, ctx);
  }
  return true;
}

/**
 * The low-confidence path: search, then let the gate do its job.
 *
 * Note what is *not* here: no ranking of results by name similarity before the
 * gate, no "the first result is probably right" shortcut. Every candidate is
 * fetched and assessed on the same rules, because a shortcut here is exactly
 * how a competitor's phone number ends up on a lead.
 */
async function enrichFromSearch(
  db: Db,
  target: EnrichmentTarget,
  ctx: PathContext,
): Promise<boolean> {
  /* c8 ignore next -- the runner always supplies one */
  if (ctx.finder === undefined) return false;

  let candidates: readonly import('./finder.js').SearchCandidate[];
  try {
    candidates = await ctx.finder.search(target, { http: ctx.http, log: ctx.log });
  } catch (error) {
    if (error instanceof RequestBudgetExceededError) throw error;
    const reason: RejectionReason =
      error instanceof SearchChallengedError ? 'search_unavailable' : 'fetch_failed';
    ctx.tally.reject(reason);
    ctx.log.warn('search unavailable', {
      leadId: target.leadId,
      provider: ctx.finder.id,
      error: messageOf(error),
    });
    return false;
  }

  let fetched = false;
  for (const candidate of candidates) {
    if (ctx.http.budgetExhausted()) break;
    const page = await fetchPage(candidate.url, ctx);
    if (page === null) continue;
    fetched = true;
    handle(db, target, page.evidence, 'discovered', SEARCH_SOURCE, ctx);
  }
  return fetched;
}

/* -------------------------------------------------------------------------- */
/* One page                                                                   */
/* -------------------------------------------------------------------------- */

async function fetchPage(
  url: string,
  ctx: PathContext,
): Promise<{ evidence: PageEvidence; $: import('cheerio').CheerioAPI } | null> {
  try {
    const response = await ctx.http.html(url);
    ctx.tally.pagesFetched += 1;
    return {
      evidence: readPage({
        url,
        finalUrl: response.finalUrl,
        html: response.body,
        $: response.$,
      }),
      $: response.$,
    };
  } catch (error) {
    if (error instanceof RequestBudgetExceededError) throw error;
    const reason: RejectionReason =
      error instanceof RobotsDisallowedError ? 'robots_disallowed' : 'fetch_failed';
    ctx.tally.reject(reason);
    ctx.log.debug('page not read', { url, reason, error: messageOf(error) });
    return null;
  }
}

/** Assess one page and do exactly one of the three things. */
function handle(
  db: Db,
  target: EnrichmentTarget,
  page: PageEvidence,
  origin: 'own_site' | 'discovered',
  sourceId: string,
  ctx: PathContext,
): void {
  const verdict: ConfidenceVerdict = assessCandidate({
    lead: target.record,
    page,
    origin,
    ...(ctx.quarantine === undefined ? {} : { quarantine: ctx.quarantine }),
  });

  if (verdict.tier === 'discard') {
    ctx.tally.reject(verdict.rule);
    ctx.tally.pagesRejected += 1;
    ctx.log.debug('page rejected', {
      leadId: target.leadId,
      url: page.finalUrl,
      rule: verdict.rule,
      reason: verdict.reason,
    });
    return;
  }

  const findings = findingsFrom(target, page);
  if (findings.length === 0) {
    ctx.tally.reject('nothing_to_add');
    ctx.tally.pagesRejected += 1;
    return;
  }

  const options = { sourceId, runId: ctx.runId, now: ctx.now() };

  if (verdict.tier === 'merge') {
    const applied = applyMerge(db, target, page, verdict, findings, options);
    ctx.tally.pagesMerged += 1;
    ctx.tally.enrichedLeads.add(target.leadId);
    ctx.tally.scorePointsAdded += Math.max(0, applied.score - applied.scoreBefore);
    for (const [field, count] of Object.entries(applied.fieldsAdded)) {
      const key = field as EnrichableField;
      ctx.tally.fieldsAdded[key] = (ctx.tally.fieldsAdded[key] ?? 0) + (count ?? 0);
      if (key === 'phone' && (count ?? 0) > 0) ctx.tally.lastLeadGainedPhone = true;
    }
    ctx.log.info('enriched', {
      leadId: target.leadId,
      url: page.finalUrl,
      rule: verdict.rule,
      added: applied.fieldsAdded,
      score: `${applied.scoreBefore} → ${applied.score}`,
    });
    return;
  }

  const queued = queueSuggestions(db, target, page, verdict, findings, options);
  ctx.tally.pagesSuggested += 1;
  ctx.tally.suggestionsQueued += queued;
  if (ctx.tally.suggestionSamples.length < SUGGESTION_SAMPLE) {
    ctx.tally.suggestionSamples.push({
      leadId: target.leadId,
      leadName: target.name,
      url: page.finalUrl,
      rule: verdict.rule,
      confidence: verdict.confidence,
      values: queued,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                   */
/* -------------------------------------------------------------------------- */

class Tally {
  leadsProcessed = 0;
  pagesFetched = 0;
  pagesMerged = 0;
  pagesSuggested = 0;
  pagesRejected = 0;
  suggestionsQueued = 0;
  leadsGainedFirstPhone = 0;
  scorePointsAdded = 0;
  lastLeadGainedPhone = false;
  readonly enrichedLeads = new Set<number>();
  readonly fieldsAdded: Partial<Record<EnrichableField, number>> = {};
  readonly rejections: Partial<Record<RejectionReason, number>> = {};
  readonly suggestionSamples: SuggestionSample[] = [];

  reject(reason: RejectionReason): void {
    this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof HttpError) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
