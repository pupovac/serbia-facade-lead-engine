/**
 * Run orchestration, end to end, against the reference adapter.
 *
 * The whole contract is exercised here — pagination, robots, resume state,
 * staleness, the zod boundary, the failure policy, `--dry-run` — over a local
 * fixture server. Nothing reaches the network, which is what lets it run in CI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getCrawlState, openTestDatabase, type Db } from '@/lib/db';
import { StructureChangedError } from './errors.js';
import { runSource, type RunOptions, type RunSummary } from './run.js';
import { ITEM_PREFIX } from './crawl-state.js';
import { startFixtureServer, type FixtureServer } from './sources/example/fixture-server.js';
import exampleAdapter from './sources/example/index.js';
import type { DiscoveredItem, SourceAdapter } from './types.js';

const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let site: FixtureServer;

beforeEach(async () => {
  db = openTestDatabase();
  site = await startFixtureServer();
});

afterEach(async () => {
  closeDatabase(db);
  await site.close();
});

/** The example adapter, pointed at this test's fixture server. */
function adapterFor(server: FixtureServer, overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    ...exampleAdapter,
    baseUrl: server.url,
    async *discover(ctx) {
      const resume = ctx.state.resume('category:fasaderi', ctx.scope, ctx.now());
      if (resume.skip) return;
      let pageUrl: string | null = resume.cursor ?? `${server.url}/firme/fasaderi`;
      while (pageUrl !== null) {
        const { $, finalUrl } = await ctx.http.html(pageUrl);
        const { parseListing } = await import('./sources/example/parse.js');
        const listing = parseListing($, finalUrl, ctx.expect);
        for (const item of listing.items) {
          yield { url: item.url, scopeKey: 'category:fasaderi', hints: { ...item } };
        }
        pageUrl = listing.nextUrl;
        ctx.state.saveScope('category:fasaderi', {
          cursor: pageUrl,
          status: pageUrl === null ? 'done' : 'in_progress',
          at: ctx.now(),
        });
      }
    },
    ...overrides,
  };
}

/** No sleeping and no jitter: politeness is asserted in the fetcher's own tests. */
function run(options: Partial<RunOptions> & { adapter: SourceAdapter }): Promise<RunSummary> {
  return runSource({
    db,
    config: { requestDelayMs: 0 },
    sleep: async () => {},
    random: () => 0.5,
    ...options,
  });
}

describe('runSource', () => {
  it('crawls both listing pages and writes every lead', async () => {
    const summary = await run({ adapter: adapterFor(site) });

    expect(summary.status).toBe('completed');
    expect(summary.itemsDiscovered).toBe(6);
    expect(summary.itemsExtracted).toBe(6);
    expect(summary.recordsEmitted).toBe(6);
    expect(summary.recordsRejected).toBe(0);
    // The primary deliverable, counted honestly: one of the six has no phone.
    expect(summary.recordsWithPhone).toBe(5);
    expect(summary.leadsCreated).toBe(6);
    expect(summary.itemsFailed).toBe(0);

    const leads = db.$client.prepare('select name, city_id, classification from leads').all();
    expect(leads).toHaveLength(6);
    expect(leads).toContainEqual({
      name: 'Građevinski centar Niš',
      city_id: 'nis',
      classification: 'CONSTRUCTION_MATERIAL_STORE',
    });
  });

  it('records the run, its scope and its statistics', async () => {
    const summary = await run({ adapter: adapterFor(site), trigger: 'scheduled' });

    const row = db.$client
      .prepare('select * from crawl_runs where id = ?')
      .get(summary.runId) as Record<string, unknown>;

    expect(row.status).toBe('completed');
    expect(row.trigger).toBe('scheduled');
    expect(row.records_emitted).toBe(6);
    expect(row.leads_created).toBe(6);
    expect(row.requests_made).toBe(summary.requests);
    expect(row.finished_at).not.toBeNull();
  });

  it('asks robots.txt before anything else, and only once', async () => {
    await run({ adapter: adapterFor(site) });

    expect(site.requests[0]).toBe('/robots.txt');
    expect(site.requests.filter((path) => path === '/robots.txt')).toHaveLength(1);
  });

  it('resumes discovery from the stored cursor', async () => {
    // A first run that stops after page one, exactly as a crash would leave it.
    await run({ adapter: adapterFor(site), scope: { limit: 3 } });
    const afterFirst = getCrawlState(db, 'example', 'scope:category:fasaderi');
    expect(afterFirst?.cursor).toBe(`${site.url}/firme/fasaderi?strana=2`);

    site.reset();
    const second = await run({ adapter: adapterFor(site) });

    // Page one is never re-fetched; the three items already scraped are skipped.
    expect(site.requests).not.toContain('/firme/fasaderi');
    expect(second.itemsSkippedFresh).toBe(0);
    expect(second.recordsEmitted).toBe(3);
  });

  it('skips items scraped inside the staleness window on a second run', async () => {
    await run({ adapter: adapterFor(site) });
    site.reset();

    // The everyday incremental shape: re-walk the listing (cheap, finds new
    // businesses), skip every detail page already scraped (expensive).
    const second = await run({
      adapter: adapterFor(site),
      scope: { rediscoverAfterMs: 0, stalenessMs: 14 * DAY },
    });

    expect(second.itemsDiscovered).toBe(6);
    expect(second.itemsSkippedFresh).toBe(6);
    expect(second.itemsExtracted).toBe(0);
    // Two listing pages and a fresh robots.txt — and not one detail page.
    expect(site.requests.filter((path) => path.startsWith('/firme/fasaderi'))).toHaveLength(2);
    expect(
      site.requests.filter(
        (path) => path.startsWith('/firme/') && !path.startsWith('/firme/fasaderi'),
      ),
    ).toEqual([]);
  });

  it('re-visits an item once it goes stale', async () => {
    await run({ adapter: adapterFor(site) });

    const second = await run({
      adapter: adapterFor(site),
      scope: { rediscoverAfterMs: 0, stalenessMs: 0 },
    });

    expect(second.itemsSkippedFresh).toBe(0);
    expect(second.itemsExtracted).toBe(6);
    // Updated, never re-inserted.
    expect(second.leadsCreated).toBe(0);
    expect(second.leadsUpdated).toBe(6);
    expect(db.$client.prepare('select count(*) as n from leads').get()).toEqual({ n: 6 });
  });

  it('re-walks a finished listing on a later run, so new entries are found', async () => {
    // The trap this guards: a completed scope that never re-opens reports zero
    // items discovered, calls the run successful, and quietly stops producing
    // leads the moment the first crawl finishes.
    const first = await run({ adapter: adapterFor(site) });
    expect(first.itemsDiscovered).toBe(6);
    site.reset();

    const later = await run({ adapter: adapterFor(site), scope: { rediscoverAfterMs: 0 } });

    expect(later.itemsDiscovered).toBe(6);
    expect(site.requests).toContain('/firme/fasaderi');
  });

  it('leaves a freshly finished listing alone', async () => {
    await run({ adapter: adapterFor(site) });
    site.reset();

    const second = await run({ adapter: adapterFor(site), scope: { rediscoverAfterMs: DAY } });

    expect(second.itemsDiscovered).toBe(0);
    expect(second.requests).toBe(0);
    // Not one listing page re-read, and no leads touched.
    expect(site.requests).toEqual([]);
    expect(second.leadsUpdated).toBe(0);
  });

  it('keys item freshness by resumeKey, not by a URL that moves', async () => {
    // The example overrides `resumeKey` to the path, because its fixture server
    // takes a new port each run — the same shape as a source that decorates
    // links with a session id. Without it nothing would ever look already-seen.
    await run({ adapter: adapterFor(site) });
    const moved = await startFixtureServer();
    try {
      const second = await run({
        adapter: adapterFor(moved),
        scope: { rediscoverAfterMs: 0, stalenessMs: 14 * DAY },
      });

      expect(moved.url).not.toBe(site.url);
      expect(second.itemsDiscovered).toBe(6);
      expect(second.itemsSkippedFresh).toBe(6);
      expect(second.itemsExtracted).toBe(0);
    } finally {
      await moved.close();
    }
  });

  it('stores a per-item last_scraped_at', async () => {
    await run({ adapter: adapterFor(site) });

    const item = getCrawlState(db, 'example', `${ITEM_PREFIX}/firme/termo-fasade-novi-sad`);
    expect(item?.status).toBe('done');
    expect(item?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('stops at the record limit', async () => {
    const summary = await run({ adapter: adapterFor(site), scope: { limit: 2 } });

    expect(summary.recordsEmitted).toBe(2);
    expect(summary.stoppedBecause).toContain('limit of 2');
    expect(db.$client.prepare('select count(*) as n from leads').get()).toEqual({ n: 2 });
  });

  it('stops at the request budget instead of hammering the host', async () => {
    const summary = await run({ adapter: adapterFor(site), config: { requestBudget: 3 } });

    expect(summary.requests).toBeLessThanOrEqual(3);
    expect(summary.stoppedBecause).toContain('budget');
    expect(summary.status).toBe('completed');
  });

  describe('--dry-run', () => {
    it('discovers and extracts, and writes nothing', async () => {
      const summary = await runSource({
        adapter: adapterFor(site),
        db,
        dryRun: true,
        config: { requestDelayMs: 0 },
        sleep: async () => {},
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.itemsExtracted).toBe(6);
      expect(summary.recordsEmitted).toBe(6);
      expect(summary.recordsWithPhone).toBe(5);
      // Nothing at all, in any table the run would otherwise touch.
      expect(summary.runId).toBeNull();
      for (const table of ['leads', 'lead_phones', 'raw_records', 'crawl_runs', 'crawl_state']) {
        expect(db.$client.prepare(`select count(*) as n from ${table}`).get()).toEqual({ n: 0 });
      }
    });
  });

  describe('failure policy', () => {
    it('survives one failing item and keeps crawling', async () => {
      const adapter = adapterFor(site, {
        async extract(item, ctx) {
          if (item.url.endsWith('stovariste-gradnja-plus')) throw new Error('HTTP 500');
          return exampleAdapter.extract(item, ctx);
        },
      });

      const summary = await run({ adapter });

      expect(summary.status).toBe('completed');
      expect(summary.itemsFailed).toBe(1);
      expect(summary.itemsExtracted).toBe(5);
      expect(summary.recordsEmitted).toBe(5);
      // The URL is in the summary — a failure nobody can locate is not reported.
      expect(summary.failures[0]?.url).toContain('stovariste-gradnja-plus');
      expect(summary.failures[0]?.message).toContain('HTTP 500');
    });

    it('marks a failed item so the next run comes back to it', async () => {
      const adapter = adapterFor(site, {
        async extract(item, ctx) {
          if (item.url.endsWith('stovariste-gradnja-plus')) throw new Error('HTTP 500');
          return exampleAdapter.extract(item, ctx);
        },
      });
      await run({ adapter });

      const failed = getCrawlState(db, 'example', `${ITEM_PREFIX}/firme/stovariste-gradnja-plus`);
      expect(failed?.status).toBe('failed');
      expect(failed?.lastError).toContain('HTTP 500');
    });

    it('reports a record that fails validation instead of dropping it', async () => {
      const adapter = adapterFor(site, {
        async extract(item, ctx) {
          if (!item.url.endsWith('demit-fasade-beograd')) return exampleAdapter.extract(item, ctx);
          return [{ sourceUrl: item.url, name: '' }];
        },
      });

      const summary = await run({ adapter });

      expect(summary.recordsRejected).toBe(1);
      expect(summary.recordsEmitted).toBe(5);
      const rejected = db.$client
        .prepare("select validation_error from raw_records where status = 'rejected'")
        .get() as { validation_error: string };
      expect(rejected.validation_error).toContain('name');
    });

    it('fails the run when the listing structure changes', async () => {
      // A healthy 200 full of companies that no longer matches the selector.
      const redesigned = await startFixtureServer({ redesigned: true });
      try {
        await expect(run({ adapter: adapterFor(redesigned) })).rejects.toThrow(
          StructureChangedError,
        );

        const row = db.$client.prepare('select status, error from crawl_runs').get() as {
          status: string;
          error: string;
        };
        // The run row is closed as failed before the error is re-thrown.
        expect(row.status).toBe('failed');
        expect(row.error).toContain('ul.lista-firmi li.firma-kartica');
        expect(db.$client.prepare('select count(*) as n from leads').get()).toEqual({ n: 0 });
      } finally {
        await redesigned.close();
      }
    });

    it('fails the run when a detail page structure changes', async () => {
      const adapter = adapterFor(site, {
        async extract(item: DiscoveredItem, ctx) {
          // The selector a real adapter would have; the page no longer has it.
          ctx.expect(null, 'h1.firma-naziv--v2', item.url, 'the company name');
          return [];
        },
      });

      await expect(run({ adapter })).rejects.toThrow(StructureChangedError);
    });

    it('tolerates a lone structural failure once other items have parsed', async () => {
      let seen = 0;
      const adapter = adapterFor(site, {
        async extract(item, ctx) {
          seen += 1;
          if (seen === 3) ctx.expect(null, 'dd.telefon', item.url, 'a phone');
          return exampleAdapter.extract(item, ctx);
        },
      });

      const summary = await run({ adapter, structureErrorLimit: 3 });

      expect(summary.status).toBe('completed');
      expect(summary.itemsFailed).toBe(1);
      expect(summary.failures[0]?.kind).toBe('structure');
      expect(summary.recordsEmitted).toBe(5);
    });
  });

  it('runs the shipped example adapter unmodified, on its own fixture server', async () => {
    // Every other test here points the adapter at this file's server so it can
    // assert on the request log. This one runs what actually ships — including
    // the fixture site it serves for itself when no base URL is configured.
    const summary = await runSource({
      adapter: exampleAdapter,
      db,
      config: { requestDelayMs: 0 },
      sleep: async () => {},
    });

    expect(summary.status).toBe('completed');
    expect(summary.recordsEmitted).toBe(6);
    expect(summary.recordsWithPhone).toBe(5);
    expect(summary.leadsCreated).toBe(6);
  });

  it('inserts a minimal sources row for an adapter the registry never listed', async () => {
    await run({ adapter: adapterFor(site) });

    const source = db.$client.prepare('select * from sources where id = ?').get('example') as {
      name: string;
      has_contractors: number;
      has_stores: number;
    };
    expect(source.name).toContain('Primer direktorijum');
    expect(source.has_contractors).toBe(1);
    expect(source.has_stores).toBe(1);
  });
});
