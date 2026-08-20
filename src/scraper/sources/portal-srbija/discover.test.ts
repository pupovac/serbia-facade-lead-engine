/**
 * `discover` over the saved pages — the crawl plan, with no network.
 *
 * `run.test.ts` already proves the framework's resume machinery against the
 * reference adapter. What is specific to this source, and what breaks quietly
 * if it is wrong, is the plan: national page as the seed, its own `dl.dl_nei`
 * list as the enumeration, one scope per page, a dead page costing one page,
 * and a second run inside the rediscover window costing nothing at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import type { Municipality } from '@/lib/geo';
import { getMunicipalityById } from '@/lib/geo';
import { DEFAULTS } from '../../config.js';
import { MemoryCrawlStateStore } from '../../crawl-state.js';
import { HttpError, StructureChangedError } from '../../errors.js';
import { silentLogger } from '../../logger.js';
import { SCRAPER_LIB } from '../../run.js';
import { expectFound, type CrawlContext, type DiscoveredItem } from '../../types.js';
import adapter from './index.js';

const BASE = 'https://www.portal-srbija.com';
const HOUR = 60 * 60 * 1000;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

/**
 * One whole real category: the national page and all seven city pages it
 * links, saved on 2026-08-20. Anything not here is a 404, which is what the
 * eight categories with no fixture get — and what proves a dead category costs
 * one request rather than the run.
 */
const SITE: ReadonlyMap<string, string> = new Map(
  [
    ['radovi-na-visini', 'listing-national-radovi-na-visini.html'],
    ...[
      'kac',
      'kraljevo',
      'novi-sad',
      'novi-beograd',
      'savski-venac',
      'banovo-brdo',
      'rakovica-miljakovac-kanarevo-brdo-resnik',
    ].map((city) => [`radovi-na-visini-${city}`, `listing-city-radovi-na-visini-${city}.html`]),
  ].map(([path, file]) => [`${BASE}/${path as string}`, file as string]),
);

/**
 * One served page answers 500 every time, overriding `SITE`. Portal Srbija
 * really does 500 on some slugs — FUZZ-8 found 14 deterministic ones — so a
 * city page that fails has to cost that page and nothing else.
 */
const BROKEN = `${BASE}/radovi-na-visini-novi-beograd`;

interface Harness {
  readonly ctx: CrawlContext;
  readonly state: MemoryCrawlStateStore;
  readonly requested: string[];
  /** Advance the clock the resume windows are measured against. */
  advance(ms: number): void;
}

function harness(
  options: {
    readonly state?: MemoryCrawlStateStore;
    readonly municipalities?: readonly Municipality[];
    readonly serve?: (url: string) => string | null;
  } = {},
): Harness {
  const state = options.state ?? new MemoryCrawlStateStore();
  const requested: string[] = [];
  let clock = Date.UTC(2026, 7, 20, 12, 0, 0);

  const html = async (url: string): Promise<{ $: cheerio.CheerioAPI; finalUrl: string }> => {
    requested.push(url);
    if (url === BROKEN) throw new HttpError(url, 500, 4, true);
    const custom = options.serve?.(url);
    const name = custom ?? SITE.get(url);
    if (name === undefined || name === null) throw new HttpError(url, 404, 1, false);
    return { $: cheerio.load(fixture(name)), finalUrl: url };
  };

  const ctx = {
    sourceId: adapter.id,
    runId: null,
    config: DEFAULTS,
    // Only the two members `discover` reaches for; the real `PoliteFetcher` is
    // exercised by `http/fetcher.test.ts`.
    http: { html, budgetExhausted: () => false },
    log: silentLogger,
    state,
    lib: SCRAPER_LIB,
    scope: {
      municipalities: options.municipalities ?? [],
      queries: [],
      limit: null,
      stalenessMs: DEFAULTS.stalenessMs,
      rediscoverAfterMs: DEFAULTS.rediscoverAfterMs,
      since: null,
    },
    signal: new AbortController().signal,
    now: () => new Date(clock),
    dryRun: true,
    expect: (value: unknown, selector: string, url: string, expected?: string) =>
      expectFound(adapter.id, value, selector, url, expected),
  } as unknown as CrawlContext;

  return {
    ctx,
    state,
    requested,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function collect(ctx: CrawlContext): Promise<DiscoveredItem[]> {
  const items: DiscoveredItem[] = [];
  for await (const item of adapter.discover(ctx)) items.push(item);
  return items;
}

function unit(id: string): Municipality {
  const municipality = getMunicipalityById(id);
  if (municipality === undefined) throw new Error(`no municipality ${id}`);
  return municipality;
}

describe('discover', () => {
  it('crawls the national page and then the city pages it links', async () => {
    const test = harness();
    const items = await collect(test.ctx);

    expect(test.requested).toContain(`${BASE}/radovi-na-visini`);
    // The city pages come from `dl.dl_nei`, in dataset crawl order, and the
    // national page is requested before any of them.
    expect(test.requested.filter((url) => url.startsWith(`${BASE}/radovi-na-visini-`))).toEqual([
      `${BASE}/radovi-na-visini-kac`,
      `${BASE}/radovi-na-visini-novi-sad`,
      `${BASE}/radovi-na-visini-novi-beograd`,
      `${BASE}/radovi-na-visini-banovo-brdo`,
      `${BASE}/radovi-na-visini-kraljevo`,
      `${BASE}/radovi-na-visini-rakovica-miljakovac-kanarevo-brdo-resnik`,
      `${BASE}/radovi-na-visini-savski-venac`,
    ]);

    // Six companies from eight pages. This category is well under the national
    // page's 60-row cap, so its city pages are genuinely a subset — which is
    // exactly why every one of them still has to be visited on a category that
    // is not. What matters here is that a company on four of those pages is
    // yielded once.
    expect(items).toHaveLength(6);
    expect(new Set(items.map((item) => item.url)).size).toBe(items.length);
    expect(items.filter((item) => item.url.endsWith('/szr-ns-vertical-limits'))).toHaveLength(1);

    const national = items.find((item) => item.url.endsWith('/braca-glisic'));
    expect(national?.scopeKey).toBe('category:radovi-na-visini');
    expect(national?.hints).toMatchObject({
      categorySlug: 'radovi-na-visini',
      categoryName: 'Radovi na visini',
      citySlug: null,
    });
    // Every company here was on the national page first, so every scope key is
    // the national one — the city pages confirmed them rather than adding any.
    expect(new Set(items.map((item) => item.scopeKey))).toEqual(
      new Set(['category:radovi-na-visini']),
    );
  });

  it('survives a dead category and a 500 on one city page', async () => {
    const test = harness();
    await collect(test.ctx);

    // Eight of the nine categories 404 here. Each costs one request and marks
    // its scope failed so the next run tries again.
    expect(test.state.getScope('category:hidroizolacija')?.status).toBe('failed');
    expect(test.state.getScope('category:hidroizolacija')?.lastError).toContain('404');
    expect(test.state.getScope('category:radovi-na-visini')?.status).toBe('done');

    const broken = test.state.getScope('category:radovi-na-visini|city:novi-beograd');
    expect(broken?.status).toBe('failed');
    expect(broken?.lastError).toContain('500');
    // The pages after it were still crawled.
    expect(test.requested).toContain(`${BASE}/radovi-na-visini-kraljevo`);
  });

  it('finds nothing and asks for nothing on a second run inside the window', async () => {
    const first = harness();
    await collect(first.ctx);

    const second = harness({ state: first.state });
    second.advance(2 * HOUR);
    const items = await collect(second.ctx);

    expect(items).toEqual([]);
    // Not one request: the national scope's cursor holds the city list, so the
    // page does not have to be re-read to know the cities are done. Only the
    // scopes that failed are retried.
    expect(second.requested).toEqual([
      // The eight categories with no page here 404ed on the first run, so they
      // are `failed` scopes and are tried again — that is the point of the
      // status.
      `${BASE}/termo-izolacija-zvucna-izolacija`,
      `${BASE}/zavrsni-radovi-restauracije`,
      `${BASE}/ciscenje-fasada-skidanje-grafita`,
      `${BASE}/hidroizolacija`,
      `${BASE}/sanacije-gradjevinskih-objekata`,
      `${BASE}/grubi-gradjevinski-radovi`,
      // The one city page that 500ed. Its seven siblings and the national page
      // completed, so nothing re-reads them — and the city list came off the
      // national scope's cursor rather than off a second request for the page.
      `${BASE}/radovi-na-visini-novi-beograd`,
      `${BASE}/proizvodnja-stiropora`,
      `${BASE}/za-gradjevinske-radove`,
    ]);
  });

  it('re-walks the listings once the rediscover window has passed', async () => {
    const first = harness();
    await collect(first.ctx);

    const second = harness({ state: first.state });
    second.advance(25 * HOUR);
    const items = await collect(second.ctx);

    // Re-walking a listing is how a newly listed business is ever found, so it
    // happens again — the same companies, ready for the item staleness window
    // to decide whether any detail page is worth re-fetching.
    expect(second.requested).toContain(`${BASE}/radovi-na-visini`);
    expect(second.requested).toContain(`${BASE}/radovi-na-visini-kraljevo`);
    expect(items).toHaveLength(6);
  });

  it('keeps a --city run inside its city', async () => {
    const test = harness({ municipalities: [unit('kraljevo')] });
    const items = await collect(test.ctx);

    expect(test.requested).toEqual([
      `${BASE}/termo-izolacija-zvucna-izolacija`,
      `${BASE}/zavrsni-radovi-restauracije`,
      `${BASE}/ciscenje-fasada-skidanje-grafita`,
      `${BASE}/hidroizolacija`,
      `${BASE}/sanacije-gradjevinskih-objekata`,
      `${BASE}/grubi-gradjevinski-radovi`,
      `${BASE}/radovi-na-visini`,
      `${BASE}/radovi-na-visini-kraljevo`,
      `${BASE}/proizvodnja-stiropora`,
      `${BASE}/za-gradjevinske-radove`,
    ]);
    // The national page is still read — it is where the city list lives — but
    // its Belgrade and Novi Sad rows are not this run's business.
    expect(items.every((item) => !item.url.endsWith('/braca-glisic'))).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.hints?.categorySlug === 'radovi-na-visini')).toBe(true);
  });

  it('stops the run when the national listing stops parsing', async () => {
    const test = harness({
      serve: (url) => (url === `${BASE}/radovi-na-visini` ? 'listing-redesigned.html' : null),
    });
    await expect(collect(test.ctx)).rejects.toThrow(StructureChangedError);
  });
});
