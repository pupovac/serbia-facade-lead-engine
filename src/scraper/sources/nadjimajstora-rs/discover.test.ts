/**
 * The crawl plan and the record it produces, with no network.
 *
 * The walk itself is short — five listing pages for the whole source — so what
 * is worth pinning down is not resumption but the three-request shape of
 * `extract`: profile, contact tab, and the replayed reveal endpoint. The phone
 * is this source's entire reason for existing, so the tests that matter are the
 * ones about what happens when it stops arriving.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../config.js';
import { MemoryCrawlStateStore } from '../../crawl-state.js';
import { HttpError, StructureChangedError } from '../../errors.js';
import { silentLogger } from '../../logger.js';
import { validateRawLead } from '../../raw-lead.js';
import { SCRAPER_LIB } from '../../run.js';
import { expectFound, type CrawlContext, type DiscoveredItem } from '../../types.js';
import adapter from './index.js';

const BASE = 'https://www.nadjimajstora.rs';
const SHOW_TEL = `${BASE}/master/show_tel/`;
const PROFILE = `${BASE}/gradjevinski-radovi/fasader/srdjan-todic--2298.htm`;
const CONTACT = `${BASE}/gradjevinski-radovi/fasader/srdjan-todic-2298/kontakt.htm`;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

const LISTINGS: ReadonlyMap<string, string> = new Map([
  [`${BASE}/gradjevinski-radovi/fasader.htm?p=1&s=o&st=asc`, 'listing-fasader-p1.html'],
  [`${BASE}/gradjevinski-radovi/fasader.htm?p=2&s=o&st=asc`, 'listing-fasader-p3.html'],
  [`${BASE}/gradjevinski-radovi/izolater.htm?p=1&s=o&st=asc`, 'listing-izolater-p1.html'],
  [`${BASE}/gradjevinski-radovi/izolater.htm?p=2&s=o&st=asc`, 'listing-izolater-p2.html'],
]);

const PAGES: ReadonlyMap<string, string> = new Map([
  [PROFILE, 'profile-srdjan-todic.html'],
  [CONTACT, 'kontakt-srdjan-todic.html'],
]);

interface Harness {
  readonly ctx: CrawlContext;
  readonly state: MemoryCrawlStateStore;
  readonly requested: string[];
  readonly posted: Array<{ url: string; form: Record<string, string> | undefined }>;
}

function harness(
  options: {
    readonly state?: MemoryCrawlStateStore;
    readonly showTel?: (id: string) => string;
    readonly budgetExhausted?: () => boolean;
  } = {},
): Harness {
  const state = options.state ?? new MemoryCrawlStateStore();
  const requested: string[] = [];
  const posted: Array<{ url: string; form: Record<string, string> | undefined }> = [];
  const clock = Date.UTC(2026, 7, 21, 12, 0, 0);

  const text = async (
    url: string,
    init: { form?: Record<string, string> } = {},
  ): Promise<{ body: string; finalUrl: string }> => {
    requested.push(url);
    if (url === SHOW_TEL) {
      posted.push({ url, form: init.form });
      const id = init.form?.id ?? '';
      const reply =
        options.showTel?.(id) ??
        `{"ind":1,"html":"<a href=\\"tel:064588066${id.slice(-1)}\\">064588066${id.slice(-1)}<\\/a>"}`;
      return { body: reply, finalUrl: url };
    }
    throw new HttpError(url, 404, 1, false);
  };

  const html = async (url: string): Promise<{ $: cheerio.CheerioAPI; finalUrl: string }> => {
    requested.push(url);
    const name = LISTINGS.get(url) ?? PAGES.get(url);
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
      municipalities: [],
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

  return { ctx, state, requested, posted };
}

async function collect(ctx: CrawlContext): Promise<DiscoveredItem[]> {
  const items: DiscoveredItem[] = [];
  for await (const item of adapter.discover(ctx)) items.push(item);
  return items;
}

const item = (overrides: Partial<DiscoveredItem> = {}): DiscoveredItem => ({
  url: PROFILE,
  scopeKey: 'category:fasader',
  hints: { masterId: 2298, categorySlug: 'fasader', listingName: 'Srdjan Todić', rating: '10.00' },
  ...overrides,
});

describe('discover', () => {
  it('walks both categories, sending the sort parameters on every page', async () => {
    const test = harness();
    const items = await collect(test.ctx);

    // Page 1 of fasader, then the stand-in short page ends it; then izolater.
    expect(test.requested).toEqual([
      `${BASE}/gradjevinski-radovi/fasader.htm?p=1&s=o&st=asc`,
      `${BASE}/gradjevinski-radovi/fasader.htm?p=2&s=o&st=asc`,
      `${BASE}/gradjevinski-radovi/izolater.htm?p=1&s=o&st=asc`,
      `${BASE}/gradjevinski-radovi/izolater.htm?p=2&s=o&st=asc`,
    ]);
    expect(test.requested.every((url) => url.includes('s=o&st=asc'))).toBe(true);
    // fasader 20 + 16, izolater 20 + 13 — the whole source, and each category
    // ends on its own short page rather than on an error.
    expect(items).toHaveLength(69);
    expect(new Set(items.map((entry) => entry.scopeKey))).toEqual(
      new Set(['category:fasader', 'category:izolater']),
    );
  });

  it('stops a category on the short page and marks the scope done', async () => {
    const test = harness();
    await collect(test.ctx);
    expect(test.state.getScope('category:fasader')).toMatchObject({ status: 'done', cursor: null });
  });

  it('resumes a category after the last page it finished', async () => {
    const state = new MemoryCrawlStateStore();
    state.saveScope('category:fasader', { cursor: '1', status: 'in_progress' });
    const test = harness({ state });
    await collect(test.ctx);

    expect(test.requested[0]).toBe(`${BASE}/gradjevinski-radovi/fasader.htm?p=2&s=o&st=asc`);
  });

  it('keys resumption on the master id, not on either spelling of the slug', () => {
    expect(adapter.resumeKey?.(item())).toBe('master:2298');
  });

  it('stops discovering when the request budget is gone', async () => {
    const test = harness({ budgetExhausted: () => true });
    expect(await collect(test.ctx)).toEqual([]);
    expect(test.requested).toEqual([]);
  });
});

describe('extract', () => {
  it('reads a profile, its contact tab and the reveal endpoint — three requests', async () => {
    const test = harness();
    const [record] = await adapter.extract(item(), test.ctx);

    expect(test.requested).toEqual([PROFILE, CONTACT, SHOW_TEL]);
    expect(test.posted).toEqual([{ url: SHOW_TEL, form: { id: '2298' } }]);
    expect(record).toBeDefined();
  });

  it('emits the record the pipeline expects, phone included', async () => {
    const test = harness({
      showTel: () => '{"ind":1,"html":"<a href=\\"tel:0645880669\\">0645880669<\\/a>"}',
    });
    const [record] = await adapter.extract(item(), test.ctx);
    const validated = validateRawLead(record, adapter.id);

    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.lead).toMatchObject({
      sourceUrl: PROFILE,
      name: 'Srdjan Todić',
      phones: ['0645880669'],
      city: 'Palilula',
      address: 'Pančevački put 196',
    });
  });

  /**
   * The epic's rule, at the only place it can be enforced. These are sole
   * traders; `Srdjan Todić` carries no facade word, so a record that went
   * through the word-scorer would land in `UNCLASSIFIED` and leave the export.
   */
  it('asserts FACADE_CONTRACTOR from the category rather than from the name', async () => {
    const test = harness();
    const [record] = await adapter.extract(item(), test.ctx);

    expect(record?.assertedType).toBe('FACADE_CONTRACTOR');
    expect(record?.assertedTypeReason).toContain('gradjevinski-radovi/fasader');
  });

  it('carries the source category and the master id as provenance', async () => {
    const test = harness();
    const [record] = await adapter.extract(item(), test.ctx);

    expect(record?.categories).toContain('Fasader');
    expect(record?.extra).toMatchObject({ masterId: 2298, categorySlug: 'fasader' });
  });

  /**
   * A tradesman with no number is a fact about them; a reveal endpoint that has
   * stopped answering is a fact about the source, and the difference decides
   * whether a run reports 89 unusable leads or stops and says so.
   */
  it('emits a record without a phone when the endpoint recognises the id and has none', async () => {
    const test = harness({ showTel: () => '{"ind":1,"html":"<a href=\\"tel:\\"><\\/a>"}' });
    const [record] = await adapter.extract(item(), test.ctx);

    expect(record?.phones).toEqual([]);
    expect(record?.extra).toMatchObject({ phoneRecognised: true });
  });

  it('raises once a run has asked many times and never once got a number', async () => {
    const test = harness({ showTel: () => 'null' });

    // The first calls are tolerated: a handful of unlisted tradesmen is normal.
    for (let n = 0; n < 11; n += 1) {
      const [record] = await adapter.extract(item(), test.ctx);
      expect(record?.phones).toEqual([]);
    }
    await expect(adapter.extract(item(), test.ctx)).rejects.toThrow(StructureChangedError);
  });

  it('does not raise on a phoneless master once the run has seen a real number', async () => {
    let call = 0;
    const test = harness({
      showTel: () =>
        (call += 1) === 1
          ? '{"ind":1,"html":"<a href=\\"tel:0645880669\\">0645880669<\\/a>"}'
          : 'null',
    });

    await adapter.extract(item(), test.ctx);
    for (let n = 0; n < 20; n += 1) {
      const [record] = await adapter.extract(item(), test.ctx);
      expect(record?.phones).toEqual([]);
    }
  });

  it('hands the pipeline no links, so the directory’s own contacts cannot leak in', async () => {
    const test = harness();
    const [record] = await adapter.extract(item(), test.ctx);
    expect(record?.links).toEqual([]);
  });
});
