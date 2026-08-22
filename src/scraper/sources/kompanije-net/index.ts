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
  parseCompany,
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
 * The `GRAĐEVINARSTVO` section index, which is where the category slugs live.
 *
 * The slugs carry diacritics and have changed shape before, so they are read
 * off this page rather than hard-coded — the stable half is the `l<id>_` prefix
 * and that is what the lookup keys on.
 */
const SECTION_INDEX_URL = `${BASE_URL}/Srbija/d4_GRA%C4%90EVINARSTVO.html`;

/** The legacy sole-trader index, addressed by the six-digit activity code. */
const legacyIndexUrl = (code: string): string =>
  `${BASE_URL}/preduzetnici/preduzetnici.php?delatnost=${code}`;

/** How often a category walk writes down where it got to. */
const CURSOR_EVERY = 100;

interface Tally {
  emitted: number;
  withPhone: number;
  withRegistrationNumber: number;
  withTaxId: number;
  withWebsite: number;
  outOfScopeCity: number;
  codeMismatch: number;
}

const tallies = new WeakMap<CrawlContext, Tally>();

function tallyOf(ctx: CrawlContext): Tally {
  let tally = tallies.get(ctx);
  if (tally === undefined) {
    tally = {
      emitted: 0,
      withPhone: 0,
      withRegistrationNumber: 0,
      withTaxId: 0,
      withWebsite: 0,
      outOfScopeCity: 0,
      codeMismatch: 0,
    };
    tallies.set(ctx, tally);
  }
  return tally;
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

/** Fetch the section index once per run and resolve every wanted category URL. */
async function modernCategoryUrls(
  ctx: CrawlContext,
  categories: readonly ActivityCategory[],
): Promise<Map<string, string>> {
  const { $, finalUrl } = await ctx.http.html(SECTION_INDEX_URL);
  const byListId = parseSectionIndex($, finalUrl);
  ctx.expect(
    byListId.size === 0 ? null : [...byListId.keys()],
    'a.cat-list[href*="/l<id>_"]',
    finalUrl,
    'the GRAĐEVINARSTVO activity-code index',
  );

  const missing = categories.filter((category) => !byListId.has(category.listId));
  if (missing.length > 0) {
    ctx.expect(
      null,
      missing.map((category) => `${category.listId} (${category.code})`).join(', '),
      finalUrl,
      'a category link for every activity code this adapter crawls',
    );
  }
  ctx.log.info('activity-code index read', {
    url: finalUrl,
    categoriesOnPage: byListId.size,
    crawling: categories.map((category) => `${category.listId}=${category.code}`),
  });
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

  // The section index is only worth fetching if some modern category is
  // actually due a walk. A second run the same afternoon should cost zero
  // requests, not one — the difference matters because a run that finds
  // nothing to do is exactly the run that happens most often.
  const needsSectionIndex =
    surfaces.includes('modern') &&
    categories.some(
      (category) => !ctx.state.resume(scopeKeyOf(category, 'modern'), ctx.scope, ctx.now()).skip,
    );
  const modernUrls: Map<string, string> = needsSectionIndex
    ? await modernCategoryUrls(ctx, categories)
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
    const tally = tallyOf(ctx);
    ctx.log.info('kompanije-net walk stopped', {
      recordsEmitted: tally.emitted,
      withPhone: tally.withPhone,
      withRegistrationNumber: tally.withRegistrationNumber,
      withTaxId: tally.withTaxId,
      withWebsite: tally.withWebsite,
      skippedOutOfScopeCity: tally.outOfScopeCity,
      activityCodeMismatches: tally.codeMismatch,
    });
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
  const tally = tallyOf(ctx);

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
  // Not a reason to drop it — the page's own code is the one that reaches the
  // record — but a count worth seeing, because a steady rate of these means the
  // index and the detail pages are different vintages of the same register.
  if (page.activityCode !== null && page.activityCode !== category.sifra) {
    tally.codeMismatch += 1;
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
  // The five core codes are contractor trades. The store-side codes (46.73,
  // 47.52, 46.74) are the same adapter shape and a separate issue, which is why
  // only one type is declared here.
  leadTypes: ['FACADE_CONTRACTOR'],
  category: 'APR-derived national business directory, indexed by KD-2010 activity code',
  requiresJs: false,
  // The ceiling this adapter will accept, sized for ~9,830 core-code detail
  // pages plus five index fetches. It does *not* raise anything on its own:
  // `resolveConfig` takes the **smaller** of adapter and environment, so the
  // 5,000 default still wins and a full crawl needs `--budget 12000` on the
  // command line. What this line does is refuse a budget larger than one full
  // walk — a fuse for a discovery loop that stops terminating.
  //
  // `requestDelayMs` is deliberately left alone: the framework default of 1.5 s
  // is already gentler than the ≤1 req/s this source was cleared for, and an
  // adapter may only ask for gentler, never faster.
  config: { requestBudget: 12_000 },
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
