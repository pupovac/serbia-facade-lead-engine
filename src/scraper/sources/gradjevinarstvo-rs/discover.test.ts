/**
 * The crawl plan, with no network.
 *
 * What is specific to this source is that the walk is long enough to be
 * interrupted — three hours of it — so the things worth pinning down are the
 * ones that decide whether an interrupted run costs a chunk or costs the whole
 * crawl: the cursor is written on the way out however the walk ended, a resumed
 * run starts after the last company it reached, and a finished walk inside the
 * rediscover window costs nothing at all.
 *
 * `extract`'s two filters are here too, because both remove records and a
 * filter that removes the wrong ones looks exactly like a parser bug.
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

const BASE = 'https://www.gradjevinarstvo.rs';
const SITEMAP = `${BASE}/firme-sitemap`;
const HOUR = 60 * 60 * 1000;
const SCOPE = 'sitemap:firme';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

/** The four saved company pages, at the URLs the sitemap gives them. */
const PAGES: ReadonlyMap<string, string> = new Map([
  [`${BASE}/firme/5143/popovic`, 'firma-popovic.html'],
  [`${BASE}/firme/1222/rolomatik`, 'firma-rolomatik.html'],
  [`${BASE}/firme/19066/izo-pro-team`, 'firma-izo-pro-team.html'],
  [`${BASE}/firme/3370/skupstina-opstine`, 'firma-skupstina-opstine.html'],
]);

interface Harness {
  readonly ctx: CrawlContext;
  readonly state: MemoryCrawlStateStore;
  readonly requested: string[];
  advance(ms: number): void;
}

function harness(
  options: {
    readonly state?: MemoryCrawlStateStore;
    readonly municipalities?: readonly Municipality[];
    readonly sitemap?: string;
    readonly budgetExhausted?: () => boolean;
  } = {},
): Harness {
  const state = options.state ?? new MemoryCrawlStateStore();
  const requested: string[] = [];
  let clock = Date.UTC(2026, 7, 20, 12, 0, 0);

  const text = async (url: string): Promise<{ body: string; finalUrl: string }> => {
    requested.push(url);
    if (url !== SITEMAP) throw new HttpError(url, 404, 1, false);
    return { body: options.sitemap ?? fixture('firme-sitemap.xml'), finalUrl: url };
  };

  const html = async (url: string): Promise<{ $: cheerio.CheerioAPI; finalUrl: string }> => {
    requested.push(url);
    const name = PAGES.get(url);
    if (name === undefined) throw new HttpError(url, 404, 1, false);
    return { $: cheerio.load(fixture(name)), finalUrl: url };
  };

  const ctx = {
    sourceId: adapter.id,
    runId: null,
    config: DEFAULTS,
    http: { text, html, budgetExhausted: options.budgetExhausted ?? ((): boolean => false) },
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

async function collect(ctx: CrawlContext, stopAfter?: number): Promise<DiscoveredItem[]> {
  const items: DiscoveredItem[] = [];
  for await (const item of adapter.discover(ctx)) {
    items.push(item);
    // The runner breaks out of its `for await` on `--limit` and on the request
    // budget. Doing the same here is what exercises the generator's `finally`.
    if (stopAfter !== undefined && items.length >= stopAfter) break;
  }
  return items;
}

function unit(id: string): Municipality {
  const municipality = getMunicipalityById(id);
  if (municipality === undefined) throw new Error(`no municipality ${id}`);
  return municipality;
}

describe('discover', () => {
  it('walks the sitemap in company-id order, one request for the whole plan', async () => {
    const test = harness();
    const items = await collect(test.ctx);

    expect(test.requested).toEqual([SITEMAP]);
    expect(items).toHaveLength(10);
    expect(items[0]?.url).toBe(`${BASE}/firme/1003/alba`);
    expect(items.map((item) => (item.hints as { firmId: number }).firmId)).toEqual([
      1003, 1004, 1009, 1010, 1011, 1014, 1015, 1017, 1018, 1019,
    ]);
  });

  it('marks the scope done and clears the cursor when the walk finishes', async () => {
    const test = harness();
    await collect(test.ctx);
    expect(test.state.getScope(SCOPE)).toMatchObject({ status: 'done', cursor: null });
  });

  it('writes down where it stopped when the runner breaks out early', async () => {
    const test = harness();
    await collect(test.ctx, 3);
    // Not `done`: the register has not been walked, and the next run must not
    // treat it as fresh. The cursor is `1004` rather than `1009` on purpose —
    // the generator is suspended *at* the yield of 1009, and the runner breaks
    // before extracting it (`--limit` and the budget are both checked before
    // the fetch). Recording 1009 as reached would lose that company.
    expect(test.state.getScope(SCOPE)).toMatchObject({ status: 'in_progress', cursor: '1004' });
  });

  it('resumes after the last company it reached', async () => {
    const first = harness();
    await collect(first.ctx, 3);

    const second = harness({ state: first.state });
    const items = await collect(second.ctx);
    // 1009 again: it was handed over but never extracted.
    expect(items[0]?.url).toBe(`${BASE}/firme/1009/alm`);
    expect(items).toHaveLength(8);
  });

  it('costs nothing at all inside the rediscover window', async () => {
    const first = harness();
    await collect(first.ctx);

    const second = harness({ state: first.state });
    expect(await collect(second.ctx)).toEqual([]);
    expect(second.requested).toEqual([]);
  });

  it('re-walks once the window has passed, to find companies added since', async () => {
    const first = harness();
    await collect(first.ctx);

    const second = harness({ state: first.state });
    second.advance(25 * HOUR);
    expect(await collect(second.ctx)).toHaveLength(10);
  });

  it('raises when the sitemap holds no company at all', async () => {
    const test = harness({ sitemap: fixture('firme-sitemap-empty.xml') });
    await expect(collect(test.ctx)).rejects.toThrow(StructureChangedError);
  });
});

describe('extract', () => {
  const itemFor = (id: number, slug: string): DiscoveredItem => ({
    url: `${BASE}/firme/${id}/${slug}`,
    scopeKey: SCOPE,
    hints: { firmId: id, slug },
  });

  it('emits one record carrying the page it was read at', async () => {
    const test = harness();
    const records = await adapter.extract(itemFor(5143, 'popovic'), test.ctx);
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceUrl).toBe(`${BASE}/firme/5143/popovic`);
    expect(records[0]?.phones).toEqual(['034 364 282', '064 6409 640']);
  });

  it('does not emit a company outside Serbia', async () => {
    const test = harness();
    // A Bosnian municipal body with three +387 numbers. The register is
    // regional; the market is not.
    expect(await adapter.extract(itemFor(3370, 'skupstina-opstine'), test.ctx)).toEqual([]);
  });

  it('honours --city, which the sitemap cannot do for it', async () => {
    const test = harness({ municipalities: [unit('novi-sad')] });
    // Kragujevac, asked for Novi Sad.
    expect(await adapter.extract(itemFor(5143, 'popovic'), test.ctx)).toEqual([]);
  });

  it('keeps a company in a requested city', async () => {
    const test = harness({ municipalities: [unit('kragujevac')] });
    expect(await adapter.extract(itemFor(5143, 'popovic'), test.ctx)).toHaveLength(1);
  });
});
