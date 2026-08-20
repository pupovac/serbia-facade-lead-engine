/**
 * The adapter end to end, through the real run loop.
 *
 * The fetcher is faked and the extract is seeded into a temporary cache, so
 * this exercises discovery, the release check, the scope walk, resume state and
 * extraction without DuckDB, S3 or a database — the same constraint the fixture
 * tests run under, applied to the parts a parser test cannot reach.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSource } from '../../run.js';
import { StructureChangedError } from '../../errors.js';
import { MemoryCrawlStateStore } from '../../crawl-state.js';
import { silentLogger } from '../../logger.js';
import { expectFound, type CrawlContext } from '../../types.js';
import type { FetchImpl } from '../../http/fetcher.js';
import adapter from './index.js';
import { listUrl, parseKeys, partUrl, RELEASE } from './dataset.js';
import { extractSql } from './query.js';
import { cachePaths, queryHash } from './warehouse.js';

const listing = await readFile(
  fileURLToPath(new URL('./__fixtures__/list-objects.xml', import.meta.url)),
  'utf8',
);
const extract = await readFile(
  fileURLToPath(new URL('./__fixtures__/extract-sample.ndjson', import.meta.url)),
  'utf8',
);

const ok = (body: string): Response => new Response(body, { status: 200 });
const notFound = (): Response => new Response('', { status: 404 });

/** robots.txt is a 404 on this bucket, which the framework reads as allow-all. */
function fetcher(body: string = listing): FetchImpl {
  return async (url: string) => {
    if (url.endsWith('/robots.txt')) return notFound();
    if (url.startsWith(listUrl().split('?')[0] ?? '')) return ok(body);
    throw new Error(`unexpected request: ${url}`);
  };
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'overture-adapter-'));
  process.env.OVERTURE_CACHE_DIR = cacheDir;

  // Seed the cache the way a previous run would have left it, under the hash of
  // the query this release's parts produce.
  const paths = cachePaths(RELEASE, cacheDir);
  await mkdir(join(cacheDir, RELEASE), { recursive: true });
  await writeFile(paths.data, extract, 'utf8');
  await writeFile(
    paths.manifest,
    JSON.stringify({
      release: RELEASE,
      queryHash: queryHash(extractSql(parseKeys(listing).map(partUrl))),
      parts: 16,
      rows: 16,
      fetchedAt: '2026-08-20T00:00:00.000Z',
      durationMs: 1,
      bytes: extract.length,
    }),
    'utf8',
  );
});

afterEach(async () => {
  delete process.env.OVERTURE_CACHE_DIR;
  await rm(cacheDir, { recursive: true, force: true });
});

describe('the overture-places adapter', () => {
  it('emits one record per place in the extract, off a cache, with one request', async () => {
    const summary = await runSource({
      adapter,
      dryRun: true,
      fetchImpl: fetcher(),
      sleep: async () => {},
    });

    expect(summary.status).toBe('completed');
    expect(summary.recordsEmitted).toBe(16);
    expect(summary.recordsRejected).toBe(0);
    expect(summary.recordsWithPhone).toBe(13);
    // One ListObjectsV2 call. The parquet scan did not happen — the cache
    // answered it, which is the whole point of the cache.
    expect(summary.requests).toBe(1);
  });

  it('walks every municipality, so a run records the units it found nothing in', async () => {
    // `runSource` keeps its state store to itself, so discovery is driven
    // directly here — this is the one assertion that needs to read the scope
    // rows back, and the per-municipality yield is what the issue asks to be
    // written to the database.
    const state = new MemoryCrawlStateStore();
    const completed: string[] = [];
    const saveScope = state.saveScope.bind(state);
    state.saveScope = (key, update): void => {
      if (update?.status === 'done') completed.push(key);
      saveScope(key, update);
    };

    const ctx = {
      sourceId: adapter.id,
      config: { userAgent: 'serbia-facade-lead-engine/0.1 (+mailto:test@example.com)' },
      http: {
        robotsVerdict: async () => ({ allowed: true, rule: 'no robots.txt rule matched' }),
        text: async () => ({ body: listing }),
      },
      log: silentLogger,
      state,
      scope: { municipalities: [], rediscoverAfterMs: 0, since: null },
      now: () => new Date('2026-08-20T00:00:00Z'),
      expect: (value: unknown, selector: string, url: string, expected?: string) =>
        expectFound(adapter.id, value, selector, url, expected),
    } as unknown as CrawlContext;

    const scopes = new Set<string>();
    for await (const item of adapter.discover(ctx)) scopes.add(item.scopeKey);

    // 145 local self-government units plus the unassigned bucket, three arms
    // each — every one recorded, not only the ones that yielded something.
    expect(completed).toHaveLength((145 + 1) * 3);
    expect(scopes.size).toBeLessThan(completed.length);
    expect(completed).toContain('mun:sjenica|arm:store-category');

    const novisad = state.getScope('mun:novi-sad|arm:store-category');
    expect(JSON.parse(novisad?.cursor ?? '{}')).toMatchObject({
      municipalityId: 'novi-sad',
      arm: 'store-category',
      records: 1,
      withPhone: 1,
    });

    const empty = state.getScope('mun:sjenica|arm:store-category');
    expect(JSON.parse(empty?.cursor ?? '{}')).toMatchObject({ records: 0, withPhone: 0 });
  });

  it('fails loudly when the pinned release is gone instead of reporting zero places', async () => {
    const empty =
      '<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>';
    const summary = await runSource({
      adapter,
      dryRun: true,
      fetchImpl: fetcher(empty),
      sleep: async () => {},
    }).catch((error: unknown) => error);

    expect(summary).toBeInstanceOf(StructureChangedError);
    expect((summary as StructureChangedError).message).toContain('overture-places');
  });
});
