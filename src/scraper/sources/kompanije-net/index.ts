/**
 * `kompanije-net` — Kompanije.net Srbija, the APR-derived national business
 * directory, indexed by KD-2010 activity code.
 *
 * ## Why this source, and why it is different from the others
 *
 * Every other contractor source in the registry is a *marketing* surface: a
 * business is in it because it chose to advertise. This one is register-derived
 * and indexed by the activity code the state filed the business under, so being
 * listed required nothing of the business at all. That is what makes it reach
 * **preduzetnici** — the sole traders who are most of Serbia's fasaderi, who
 * have no website to scrape and no directory listing to find, and whom APR's
 * own open data does not cover because that dataset is privredna društva only.
 *
 * FUZZ-41 counted 9,830 records under the five core contractor codes against
 * 2,290 active companies in the same codes in APR open data. The ~7,540
 * difference is the sole-trader population, and it is the project's largest
 * structural coverage gap.
 *
 * ## The enumeration is the point
 *
 * There is no search box to drive, no name to resolve and no pagination to
 * walk. One category page — `/Srbija/l70_Malterisanje.html`, 138 kB — holds
 * every one of its 900 detail links. So discovery is one request per category
 * and extraction is one request per record: about 9,830 fetches for the core
 * five, a little under three hours at the framework's 1.5 s spacing. That is
 * paid once; items carry the 14-day staleness window and the second run
 * re-fetches almost nothing.
 *
 * ## Two surfaces
 *
 * The modern `/Srbija/<slug>/<id>` section reaches record id 382240; the legacy
 * `/preduzetnici/` index tops out near 335903. They are snapshots of different
 * vintages and the markup of their detail pages is identical, so one parser
 * serves both and every record records which surface it came from. The modern
 * surface is the crawl; the legacy one is opt-in (`--query legacy`) because
 * name-level comparison on `43.31` puts at most ~36% of its 852 records outside
 * the modern index, and settling that properly means matching on matični broj
 * after fetching both — a second 8,000-request crawl that should be spent on a
 * measured gap rather than on a suspected one. See the README.
 *
 * ## What this adapter does not do
 *
 * It does not treat `Status:` as a liveness filter. That field exists only on
 * the company layout, so filtering on it would silently drop every sole trader
 * — the population this source exists for. Freshness is unmeasured for sole
 * traders and the site's footer reads "© Kompanije.net 2014", so every number
 * here needs first-call verification; the record carries `status` and matični
 * broj so that judgement can be made downstream against APR open data instead
 * of guessed at here.
 */
import { resolveCityDetailed } from '@/lib/normalize';
import type { Municipality } from '@/lib/geo';
import { ScraperError } from '../../errors.js';
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import {
  CATEGORIES,
  scopeKeyOf,
  selectCategories,
  selectSurfaces,
  type ActivityCategory,
  type Surface,
} from './categories.js';
import {
  assertionFor,
  parseCompany,
  parseCountryIndex,
  parseLegacyCategory,
  parseModernCategory,
  parseSectionIndex,
  toRawLead,
  type CategoryEntry,
} from './parse.js';

const BASE_URL = 'https://www.kompanije.net';

/** Activity code → category, for re-attaching an item's category in `extract`. */
const CATEGORY_BY_CODE = new Map(CATEGORIES.map((category) => [category.code, category]));

/**
 * The country index, which is where the *section* slugs live.
 *
 * FUZZ-45 addressed one section directly — `d4_GRA%C4%90EVINARSTVO.html`, every
 * construction trade in one page. FUZZ-46's six codes sit in four different
 * sections (`d4`, `d6 INDUSTRIJA`, `d20 TRGOVINA-NA-VELIKO`, `d24 USLUŽNE-
 * DELATNOSTI`), and their slugs carry `Đ`, `Ž` and a Serbian digraph. Reading
 * them off this page costs one request per run and removes four hard-coded
 * strings that could each 404 a five-hour crawl.
 */
const COUNTRY_INDEX_URL = `${BASE_URL}/Srbija/`;

/** The legacy sole-trader index, addressed by the six-digit activity code. */
const legacyIndexUrl = (code: string): string =>
  `${BASE_URL}/preduzetnici/preduzetnici.php?delatnost=${code}`;

/** How often a category walk writes down where it got to. */
const CURSOR_EVERY = 100;

/**
 * What a run counted, per activity code.
 *
 * Per code and not just per run, because that is the shape the question is
 * asked in: `41.20` and `46.73` are company-heavy and their phone fill and dead
 * -record rate are not the crawl's average. A single total would hide exactly
 * the difference the numbers are being collected to see.
 */
interface Tally {
  emitted: number;
  withPhone: number;
  withRegistrationNumber: number;
  withTaxId: number;
  withWebsite: number;
  withActivityCode: number;
  outOfScopeCity: number;
  /** The page states a different code than the index filed the record under. */
  codeMismatch: number;
  /** The category asserts a type and the page's own code withdrew the evidence. */
  assertionSuppressed: number;
}

function emptyTally(): Tally {
  return {
    emitted: 0,
    withPhone: 0,
    withRegistrationNumber: 0,
    withTaxId: 0,
    withWebsite: 0,
    withActivityCode: 0,
    outOfScopeCity: 0,
    codeMismatch: 0,
    assertionSuppressed: 0,
  };
}

const tallies = new WeakMap<CrawlContext, Map<string, Tally>>();

function tallyOf(ctx: CrawlContext, code: string): Tally {
  let byCode = tallies.get(ctx);
  if (byCode === undefined) {
    byCode = new Map<string, Tally>();
    tallies.set(ctx, byCode);
  }
  let tally = byCode.get(code);
  if (tally === undefined) {
    tally = emptyTally();
    byCode.set(code, tally);
  }
  return tally;
}

/** Every per-code tally plus the run total, for the closing log line. */
function tallyReport(ctx: CrawlContext): Record<string, unknown> {
  const byCode = tallies.get(ctx) ?? new Map<string, Tally>();
  const total = emptyTally();
  const perCode: Record<string, Tally> = {};
  for (const [code, tally] of byCode) {
    perCode[code] = tally;
    for (const key of Object.keys(total) as (keyof Tally)[]) total[key] += tally[key];
  }
  return { total, perCode };
}

/**
 * `--city` support.
 *
 * The index says nothing about where a business is — only its name — so this
 * cannot narrow the crawl and the page has to be fetched before its place is
 * known. It still decides whether the record is *emitted*, because
 * `--city novi-sad` promising a Novi Sad run and delivering the country would
 * be worse than the wasted request. Both the place and the municipality are
 * tried: a sole trader in `Stubline` belongs to `Obrenovac`, and `--city
 * obrenovac` should find them.
 */
function inScope(
  place: string | null,
  municipality: string | null,
  scope: readonly Municipality[],
): boolean {
  if (scope.length === 0) return true;
  return [place, municipality].some((value) => {
    if (value === null) return false;
    const resolution = resolveCityDetailed(value);
    if (!resolution.ok) return false;
    const { cityId, municipalityId } = resolution.match;
    return scope.some(
      (unit) =>
        unit.id === cityId ||
        unit.id === municipalityId ||
        (unit.parent_id !== null &&
          (unit.parent_id === cityId || unit.parent_id === municipalityId)),
    );
  });
}

/** What the item hints carry from the index to `extract`. */
interface ItemHints extends Readonly<Record<string, unknown>> {
  readonly recordId: string;
  readonly surface: Surface;
  readonly categoryCode: string;
  readonly indexName: string;
}

function toItem(
  entry: CategoryEntry,
  category: ActivityCategory,
  surface: Surface,
): DiscoveredItem {
  const hints: ItemHints = {
    recordId: entry.recordId,
    surface,
    categoryCode: category.code,
    indexName: entry.name,
  };
  return {
    url: entry.url,
    scopeKey: scopeKeyOf(category, surface),
    label: entry.name === '' ? entry.url : entry.name,
    hints,
  };
}

/**
 * Resolve every wanted category's page URL: country index, then one section
 * index per section the run actually needs.
 *
 * Two requests for a core-five run, five for the widened six — against 13,095
 * detail fetches. Both hops assert loudly, and the second one names the codes
 * that went missing: a crawl that quietly skipped `71.12` would report a
 * healthy run 3,286 records short and nothing in the log would say which.
 */
async function modernCategoryUrls(
  ctx: CrawlContext,
  categories: readonly ActivityCategory[],
): Promise<Map<string, string>> {
  const country = await ctx.http.html(COUNTRY_INDEX_URL);
  const sectionUrls = parseCountryIndex(country.$, country.finalUrl);
  ctx.expect(
    sectionUrls.size === 0 ? null : [...sectionUrls.keys()],
    'a.cat-link[href*="/d<id>_"]',
    country.finalUrl,
    'the country index of activity sections',
  );

  const sectionIds = [...new Set(categories.map((category) => category.sectionId))];
  const missingSections = sectionIds.filter((id) => !sectionUrls.has(id));
  if (missingSections.length > 0) {
    ctx.expect(
      null,
      `section links ${missingSections.join(', ')}`,
      country.finalUrl,
      'a section link for every activity code this run crawls',
    );
  }

  const byListId = new Map<string, string>();
  for (const sectionId of sectionIds) {
    const sectionUrl = sectionUrls.get(sectionId) as string;
    const { $, finalUrl } = await ctx.http.html(sectionUrl);
    const inSection = parseSectionIndex($, finalUrl);
    ctx.expect(
      inSection.size === 0 ? null : [...inSection.keys()],
      'a.cat-list[href*="/l<id>_"]',
      finalUrl,
      `the ${sectionId} activity-code index`,
    );
    for (const [listId, url] of inSection) if (!byListId.has(listId)) byListId.set(listId, url);
    ctx.log.info('activity-code index read', {
      url: finalUrl,
      section: sectionId,
      categoriesOnPage: inSection.size,
      crawling: categories
        .filter((category) => category.sectionId === sectionId)
        .map((category) => `${category.listId}=${category.code}`),
    });
  }

  const missing = categories.filter((category) => !byListId.has(category.listId));
  if (missing.length > 0) {
    ctx.expect(
      null,
      missing.map((category) => `${category.listId} (${category.code})`).join(', '),
      country.finalUrl,
      'a category link for every activity code this adapter crawls',
    );
  }
  return byListId;
}

/**
 * Walk one category on one surface.
 *
 * The whole category arrives in a single response — there is no pagination —
 * so the cursor is a position *within* that list rather than a next-page URL:
 * the record id last yielded. A resumed walk re-reads the one index page and
 * skips forward to it. If that id is no longer on the page the walk starts
 * over, which costs nothing: the framework skips every item whose last scrape
 * is inside the staleness window.
 */
async function* walkCategory(
  ctx: CrawlContext,
  category: ActivityCategory,
  surface: Surface,
  indexUrl: string,
): AsyncIterable<DiscoveredItem> {
  const scopeKey = scopeKeyOf(category, surface);
  const resume = ctx.state.resume(scopeKey, ctx.scope, ctx.now());
  if (resume.skip) {
    ctx.log.info('category walked recently; nothing to discover', { scope: scopeKey });
    return;
  }

  const { $, finalUrl } = await ctx.http.html(indexUrl);
  const entries =
    surface === 'modern' ? parseModernCategory($, finalUrl) : parseLegacyCategory($, finalUrl);
  ctx.expect(
    entries,
    surface === 'modern' ? "a.cat-list[href$='/<id>']" : "a[href$='.htm'][href*='/p<id>_']",
    finalUrl,
    `company links in ${category.code} ${category.name}`,
  );

  const resumeAt = resume.cursor;
  const startIndex =
    resumeAt === null ? 0 : entries.findIndex((entry) => entry.recordId === resumeAt) + 1;
  const pending = entries.slice(startIndex);

  ctx.log.info('category index read', {
    url: finalUrl,
    scope: scopeKey,
    surface,
    companies: entries.length,
    measuredByResearch:
      surface === 'modern' ? category.measuredRecords : category.measuredLegacyRecords,
    resumingAfterRecordId: resumeAt,
    pending: pending.length,
  });

  let lastId = resumeAt;
  let yielded = 0;
  let complete = false;
  try {
    for (const entry of pending) {
      if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;
      yield toItem(entry, category, surface);
      lastId = entry.recordId;
      yielded += 1;
      if (yielded % CURSOR_EVERY === 0) {
        ctx.state.saveScope(scopeKey, { cursor: lastId, status: 'in_progress', at: ctx.now() });
      }
    }
    complete = true;
  } finally {
    // Runs however the walk ended — exhausted, `--limit`, an abort, a `break`
    // in the runner. Whatever was reached is written down.
    ctx.state.saveScope(scopeKey, {
      cursor: complete ? null : lastId,
      status: complete ? 'done' : 'in_progress',
      lastError: null,
      at: ctx.now(),
    });
  }
}

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  const categories = selectCategories(ctx.scope.queries);
  const surfaces = selectSurfaces(ctx.scope.queries);

  // The index chain is only worth fetching if some modern category is
  // actually due a walk. A second run the same afternoon should cost zero
  // requests, not two — the difference matters because a run that finds
  // nothing to do is exactly the run that happens most often.
  const needsSectionIndex =
    surfaces.includes('modern') &&
    categories.some(
      (category) => !ctx.state.resume(scopeKeyOf(category, 'modern'), ctx.scope, ctx.now()).skip,
    );
  const modernUrls: Map<string, string> = needsSectionIndex
    ? await modernCategoryUrls(
        ctx,
        // Only the categories that still need walking decide which sections are
        // fetched. A resumed run that has three of six codes left should not
        // re-read the other three's section index.
        categories.filter(
          (category) =>
            !ctx.state.resume(scopeKeyOf(category, 'modern'), ctx.scope, ctx.now()).skip,
        ),
      )
    : new Map();

  try {
    for (const category of categories) {
      for (const surface of surfaces) {
        if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;
        const indexUrl =
          surface === 'modern'
            ? modernUrls.get(category.listId)
            : legacyIndexUrl(category.legacyCode);
        // `undefined` only when the section index was skipped because every
        // modern scope is fresh; `walkCategory` would return without a request
        // anyway, so there is nothing to do and nothing to say.
        if (indexUrl === undefined) continue;
        yield* walkCategory(ctx, category, surface, indexUrl);
      }
    }
  } finally {
    ctx.log.info('kompanije-net walk stopped', tallyReport(ctx));
  }
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const hints = (item.hints ?? {}) as Partial<ItemHints>;
  const surface: Surface = hints.surface ?? 'modern';
  // The category is the record's provenance and the whole basis of
  // `assertedType`, so it is taken from the item that discovery produced and
  // never guessed at. An item without it is a bug in this adapter, not a page
  // that lost a field, and it should say so rather than assert the wrong trade.
  const category = CATEGORY_BY_CODE.get(hints.categoryCode ?? '');
  if (category === undefined) {
    throw new ScraperError(
      `kompanije-net: item ${item.url} carries no known activity code ` +
        `(hint: ${String(hints.categoryCode)})`,
    );
  }

  const { $, finalUrl } = await ctx.http.html(item.url);
  const page = parseCompany($, finalUrl, ctx.expect);
  const tally = tallyOf(ctx, category.code);

  if (!inScope(page.place, page.municipality, ctx.scope.municipalities)) {
    tally.outOfScopeCity += 1;
    ctx.log.debug('record is outside the requested cities; not emitted', {
      url: finalUrl,
      place: page.place,
      municipality: page.municipality,
    });
    return [];
  }

  // The index filed this record under one code and the page prints another.
  // Not a reason to drop it — both are kept, the page's on the lead and the
  // index's in `extra` — but a count worth seeing, because a steady rate of
  // these means the index and the detail pages are different vintages of the
  // same register. It is also what withdraws an assertion; see `assertionFor`.
  if (page.activityCode !== null && page.activityCode !== category.sifra) {
    tally.codeMismatch += 1;
    if (category.assertedType !== null && assertionFor(page, category) === null) {
      tally.assertionSuppressed += 1;
    }
    ctx.log.debug('record activity code differs from the category it was found in', {
      url: finalUrl,
      category: category.sifra,
      page: page.activityCode,
    });
  }

  tally.emitted += 1;
  if (page.phones.length > 0) tally.withPhone += 1;
  if (page.registrationNumber !== null) tally.withRegistrationNumber += 1;
  if (page.taxId !== null) tally.withTaxId += 1;
  if (page.website !== null) tally.withWebsite += 1;
  if (page.activityCode !== null) tally.withActivityCode += 1;

  return [
    toRawLead(page, finalUrl, {
      recordId: hints.recordId ?? finalUrl,
      surface,
      category,
    }),
  ];
}

const adapter: SourceAdapter = {
  id: 'kompanije-net',
  name: 'Kompanije.net — Srbija',
  baseUrl: BASE_URL,
  // The five core codes are contractor trades; `46.73 Trgovina na veliko drvetom
  // i građevinskim materijalom` is buyer group 2 by definition of the code, so
  // this adapter now yields both. The other two store codes (`47.52` l483,
  // 2,166 records; `46.74` l549, 925) stay parked — nobody has asked for them.
  leadTypes: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
  category: 'APR-derived national business directory, indexed by KD-2010 activity code',
  requiresJs: false,
  // The ceiling this adapter will accept, sized for one complete walk of every
  // code in the table: ~9,830 core + 13,095 widened + 880 adjacent detail
  // pages, plus the index chain and headroom. It does *not* raise anything on
  // its own:
  // `resolveConfig` takes the **smaller** of adapter and environment, so the
  // 5,000 default still wins and a full core+widened crawl needs
  // `--budget 25000` on the command line. What this line does is refuse a
  // budget larger than one full walk — a fuse for a discovery loop that stops
  // terminating.
  //
  // `requestDelayMs` is deliberately left alone: the framework default of 1.5 s
  // is already gentler than the ≤1 req/s this source was cleared for, and an
  // adapter may only ask for gentler, never faster.
  config: { requestBudget: 26_000 },
  // The site publishes no email of its own — its footer carries region links
  // and a `kontakt.php` form — and the record block holds no anchors at all,
  // so there is nothing here for a lead to inherit.
  discover,
  extract,
  // The slug half of `/Srbija/<slug>/26011` is derived from the company name
  // and changes when the register's name does; the id does not. Keying resume
  // on the id keeps a renamed company from looking like a new one on every run,
  // and the surface prefix keeps the two indexes' id spaces apart.
  resumeKey: (item) => {
    const hints = (item.hints ?? {}) as Partial<ItemHints>;
    if (hints.recordId === undefined) return item.url;
    return `${hints.surface ?? 'modern'}:${hints.recordId}`;
  },
};

export default adapter;
