/**
 * The crawl plan, with no network.
 *
 * This source's walk is ~9,830 detail fetches, about three hours, so it will be
 * interrupted — by `--limit`, by the request budget, by a signal — and what
 * matters is whether an interrupted run costs a chunk or costs the whole crawl.
 * These pin down the parts that decide that: the section index is read once for
 * the whole run, the cursor is written on the way out however the walk ended, a
 * resumed run starts after the last record it reached, and a category walked
 * inside the rediscover window costs no request at all.
 *
 * `extract`'s `--city` filter is here too, because it removes records and a
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

const BASE = 'https://www.kompanije.net';
const COUNTRY = `${BASE}/Srbija/`;
const SECTION = `${BASE}/Srbija/d4_GRA%C4%90EVINARSTVO.html`;
const INDUSTRIJA = `${BASE}/Srbija/d6_INDUSTRIJA.html`;
const CATEGORY = `${BASE}/Srbija/l70_Malterisanje.html`;
const MALTER = `${BASE}/Srbija/l197_Proizvodnja-maltera.html`;
const LEGACY = `${BASE}/preduzetnici/preduzetnici.php?delatnost=433100`;
const SCOPE = 'code:43.31|surface:modern';
const HOUR = 60 * 60 * 1000;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

/**
 * Every page the harness will serve, at the URL the real site serves it at.
 *
 * A value that starts with `<` is served as-is; anything else is a fixture
 * filename. That is what lets a test hand over a *modified* section index
 * without a fourth near-identical `.html` file in `__fixtures__`.
 */
const PAGES: ReadonlyMap<string, string> = new Map([
  [COUNTRY, 'country-index-srbija.html'],
  [SECTION, 'section-index-gradjevinarstvo.html'],
  [INDUSTRIJA, 'section-index-industrija.html'],
  [CATEGORY, 'category-l70-malterisanje.html'],
  [MALTER, 'category-l197-proizvodnja-maltera.html'],
  [LEGACY, 'category-legacy-433100.html'],
  [`${BASE}/Srbija/acalend/26011`, 'detail-acalend-sajt-prose.html'],
  [`${BASE}/Srbija/agmax/26017`, 'detail-agmax-company.html'],
  [`${BASE}/Srbija/matis-nis/26021`, 'detail-matis-nis-blank-pib.html'],
  [`${BASE}/Srbija/demitkeramika/70238`, 'detail-l197-proizvodnja-maltera.html'],
  [`${BASE}/Srbija/a-gradjevinski-materijal/205403`, 'detail-l548-gradjevinski-materijal.html'],
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
    readonly queries?: readonly string[];
    readonly pages?: ReadonlyMap<string, string>;
    readonly budgetExhausted?: () => boolean;
  } = {},
): Harness {
  const state = options.state ?? new MemoryCrawlStateStore();
  const pages = options.pages ?? PAGES;
  const requested: string[] = [];
  let clock = Date.UTC(2026, 7, 21, 12, 0, 0);

  const html = async (url: string): Promise<{ $: cheerio.CheerioAPI; finalUrl: string }> => {
    requested.push(url);
    const page = pages.get(url);
    if (page === undefined) throw new HttpError(url, 404, 1, false);
    return { $: cheerio.load(page.startsWith('<') ? page : fixture(page)), finalUrl: url };
  };

  const ctx = {
    sourceId: adapter.id,
    runId: null,
    config: DEFAULTS,
    http: { html, budgetExhausted: options.budgetExhausted ?? ((): boolean => false) },
    log: silentLogger,
    state,
    lib: SCRAPER_LIB,
    scope: {
      municipalities: options.municipalities ?? [],
      // `43.31` alone, so a discovery test does not need five category fixtures.
      queries: options.queries ?? ['43.31'],
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
  it('reads the index chain once, then one page for the whole category', async () => {
    const test = harness();
    const items = await collect(test.ctx);

    expect(test.requested).toEqual([COUNTRY, SECTION, CATEGORY]);
    expect(items).toHaveLength(900);
    expect(items[0]).toMatchObject({
      url: `${BASE}/Srbija/acalend/26011`,
      scopeKey: SCOPE,
      label: 'ACA LAZAREVIĆ PR, ZANATSKA RADNJA ACALEND STUBLINE',
      hints: { recordId: '26011', surface: 'modern', categoryCode: '43.31' },
    });
  });

  it('resolves the category URL off the index instead of building it from a slug', async () => {
    // Nothing in the adapter's tables spells `l70_Malterisanje.html`. An index
    // that renames the slug must send the crawl to the new URL, because that is
    // the failure this indirection exists to survive.
    const renamed = `${BASE}/Srbija/l70_Malterisanje-i-fasadni-radovi.html`;
    const moved = new Map(PAGES);
    moved.set(
      SECTION,
      "<html><body><a class='cat-list' href='./l70_Malterisanje-i-fasadni-radovi.html'>Malterisanje</a></body></html>",
    );
    moved.set(renamed, 'category-l70-malterisanje.html');
    const test = harness({ pages: moved });

    expect(await collect(test.ctx)).toHaveLength(900);
    expect(test.requested).toEqual([COUNTRY, SECTION, renamed]);
  });

  it('resolves the section URL off the country index the same way', async () => {
    // FUZZ-46 spread the crawl over four sections whose slugs carry `Đ`, `Ž`
    // and a Serbian digraph. Reading them removes four ways to 404 a crawl.
    const renamed = `${BASE}/Srbija/d6_INDUSTRIJA-I-PROIZVODNJA.html`;
    const moved = new Map(PAGES);
    moved.set(
      COUNTRY,
      "<html><body><a class='cat-link' href='./d6_INDUSTRIJA-I-PROIZVODNJA.html'>Industrija</a></body></html>",
    );
    moved.set(renamed, 'section-index-industrija.html');
    const test = harness({ pages: moved, queries: ['23.64'] });

    expect(await collect(test.ctx)).toHaveLength(40);
    expect(test.requested).toEqual([COUNTRY, renamed, MALTER]);
  });

  it('walks a code that lives in another section entirely', async () => {
    const test = harness({ queries: ['23.64'] });
    const items = await collect(test.ctx);

    expect(test.requested).toEqual([COUNTRY, INDUSTRIJA, MALTER]);
    expect(items).toHaveLength(40);
    expect(items[0]).toMatchObject({
      scopeKey: 'code:23.64|surface:modern',
      hints: { surface: 'modern', categoryCode: '23.64' },
    });
  });

  it('fetches only the sections the run still needs', async () => {
    // A run resumed after `43.31` completed must not re-read `d4`, and a run
    // that only wants `23.64` must never read `d4` at all.
    const test = harness({ queries: ['23.64', '43.31'] });
    test.state.saveScope(SCOPE, { cursor: null, status: 'done' });
    await collect(test.ctx);
    expect(test.requested).toEqual([COUNTRY, INDUSTRIJA, MALTER]);
  });

  it('marks the category done and clears the cursor when the walk finishes', async () => {
    const test = harness();
    await collect(test.ctx);
    expect(test.state.getScope(SCOPE)).toMatchObject({ status: 'done', cursor: null });
  });

  it('writes down where it stopped when the runner breaks out early', async () => {
    const test = harness();
    await collect(test.ctx, 3);
    // Not `done`: 897 records have not been walked and the next run must not
    // treat the category as fresh. The cursor is the second record, not the
    // third — the generator is suspended *at* the yield of the third and the
    // runner breaks before extracting it, so recording it as reached would
    // lose that company.
    expect(test.state.getScope(SCOPE)).toMatchObject({ status: 'in_progress', cursor: '26013' });
  });

  it('resumes after the last record it reached', async () => {
    const first = harness();
    await collect(first.ctx, 3);

    const second = harness({ state: first.state });
    const items = await collect(second.ctx);
    // 26015 again: it was handed over but never extracted.
    expect(items[0]?.url).toBe(`${BASE}/Srbija/zanatska-radnja-milutinovac/26015`);
    expect(items).toHaveLength(898);
  });

  it('starts the category over when its saved cursor is no longer on the page', async () => {
    const test = harness();
    test.state.saveScope(SCOPE, { cursor: '999999999', status: 'in_progress' });
    // Nothing is lost by this: the framework skips every item whose last scrape
    // is inside the staleness window, so a restarted walk costs one request.
    expect(await collect(test.ctx)).toHaveLength(900);
  });

  it('costs nothing at all inside the rediscover window', async () => {
    const first = harness();
    await collect(first.ctx);

    const second = harness({ state: first.state });
    expect(await collect(second.ctx)).toEqual([]);
    // Not even the section index. A run that finds nothing to do is the run
    // that happens most often, and it should cost the host nothing.
    expect(second.requested).toEqual([]);
  });

  it('re-walks once the window has passed, to find businesses registered since', async () => {
    const first = harness();
    await collect(first.ctx);

    const second = harness({ state: first.state });
    second.advance(25 * HOUR);
    expect(await collect(second.ctx)).toHaveLength(900);
  });

  it('adds the legacy surface only when asked, as a scope of its own', async () => {
    const test = harness({ queries: ['43.31', 'legacy'] });
    const items = await collect(test.ctx);

    expect(test.requested).toEqual([COUNTRY, SECTION, CATEGORY, LEGACY]);
    expect(items).toHaveLength(900 + 852);
    expect(items.at(-1)).toMatchObject({
      scopeKey: 'code:43.31|surface:legacy',
      hints: { surface: 'legacy', categoryCode: '43.31' },
    });
  });

  it('raises when the country index holds no section link at all', async () => {
    const bare = new Map([[COUNTRY, 'category-redesigned.html']]);
    const test = harness({ pages: bare });
    await expect(collect(test.ctx)).rejects.toThrow(StructureChangedError);
  });

  it('raises when the section index holds no activity-code link at all', async () => {
    const bare = new Map(PAGES);
    bare.set(SECTION, 'category-redesigned.html');
    const test = harness({ pages: bare });
    await expect(collect(test.ctx)).rejects.toThrow(StructureChangedError);
  });

  it('raises naming the code when one activity code has lost its link', async () => {
    // A crawl that quietly skipped `43.31` would report a healthy run that is
    // 900 records short, and nothing in the log would say which 900.
    const partial = new Map(PAGES);
    partial.set(
      SECTION,
      "<html><body><a class='cat-list' href='./l74_Ostali-zavrsni-radovi.html'>Ostali završni radovi</a></body></html>",
    );
    const test = harness({ pages: partial });
    await expect(collect(test.ctx)).rejects.toThrow(/l70 \(43\.31\)/);
  });

  it('raises naming the section when a whole section has lost its link', async () => {
    const partial = new Map(PAGES);
    partial.set(
      COUNTRY,
      "<html><body><a class='cat-link' href='./d4_GRA%C4%90EVINARSTVO.html'>Građevinarstvo</a></body></html>",
    );
    const test = harness({ pages: partial, queries: ['23.64'] });
    await expect(collect(test.ctx)).rejects.toThrow(/section links d6/);
  });
});

describe('extract', () => {
  const itemFor = (recordId: string, slug: string): DiscoveredItem => ({
    url: `${BASE}/Srbija/${slug}/${recordId}`,
    scopeKey: SCOPE,
    hints: { recordId, surface: 'modern', categoryCode: '43.31', indexName: '' },
  });

  it('emits one record carrying the page it was read at', async () => {
    const test = harness();
    const records = await adapter.extract(itemFor('26011', 'acalend'), test.ctx);
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceUrl).toBe(`${BASE}/Srbija/acalend/26011`);
    expect(records[0]?.phones).toEqual(['+381.(0)64.3637451']);
  });

  it('honours --city, which the index cannot do for it', async () => {
    const test = harness({ municipalities: [unit('novi-sad')] });
    // Obrenovac, asked for Novi Sad.
    expect(await adapter.extract(itemFor('26011', 'acalend'), test.ctx)).toEqual([]);
  });

  it('keeps a record whose village belongs to a requested municipality', async () => {
    // `Stubline` is a village in Obrenovac, and only the page's own sentence
    // says so. A `--city obrenovac` run has to find it.
    const test = harness({ municipalities: [unit('beograd-obrenovac')] });
    expect(await adapter.extract(itemFor('26011', 'acalend'), test.ctx)).toHaveLength(1);
  });

  it('asserts the store side for a 46.73 record, end to end', async () => {
    const test = harness();
    const records = await adapter.extract(
      {
        url: `${BASE}/Srbija/a-gradjevinski-materijal/205403`,
        scopeKey: 'code:46.73|surface:modern',
        hints: { recordId: '205403', surface: 'modern', categoryCode: '46.73', indexName: '' },
      },
      test.ctx,
    );
    expect(records[0]).toMatchObject({
      assertedType: 'CONSTRUCTION_MATERIAL_STORE',
      activityCode: '4673',
      activityName: 'Trgovina na veliko drvetom i građ materijalom',
    });
  });

  it('asserts nothing for a 71.12 record, whatever its name says', async () => {
    const test = harness();
    const records = await adapter.extract(
      {
        url: `${BASE}/Srbija/demitkeramika/70238`,
        scopeKey: 'code:71.12|surface:modern',
        hints: { recordId: '70238', surface: 'modern', categoryCode: '71.12', indexName: '' },
      },
      test.ctx,
    );
    expect(records[0]?.assertedType).toBeUndefined();
    // The activity code is what segments this record, not its name.
    expect(records[0]?.activityCode).toBe('3832');
  });

  it('refuses an item with no activity code rather than asserting the wrong trade', async () => {
    const test = harness();
    await expect(
      adapter.extract(
        { url: `${BASE}/Srbija/acalend/26011`, scopeKey: SCOPE, hints: {} },
        test.ctx,
      ),
    ).rejects.toThrow(/no known activity code/);
  });
});

describe('resumeKey', () => {
  it('keys on the record id, so a renamed company is not a new one', () => {
    const item: DiscoveredItem = {
      url: `${BASE}/Srbija/acalend/26011`,
      scopeKey: SCOPE,
      hints: { recordId: '26011', surface: 'modern', categoryCode: '43.31', indexName: '' },
    };
    expect(adapter.resumeKey?.(item)).toBe('modern:26011');
    expect(
      adapter.resumeKey?.({ ...item, url: `${BASE}/Srbija/aca-lazarevic-pr-stubline/26011` }),
    ).toBe('modern:26011');
  });

  it('keeps the two surfaces’ id spaces apart', () => {
    const legacy: DiscoveredItem = {
      url: `${BASE}/preduzetnici/p26011_X.htm`,
      scopeKey: 'code:43.31|surface:legacy',
      hints: { recordId: '26011', surface: 'legacy', categoryCode: '43.31', indexName: '' },
    };
    expect(adapter.resumeKey?.(legacy)).toBe('legacy:26011');
  });
});
