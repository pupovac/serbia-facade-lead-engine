/**
 * `portal-srbija` — Portal Srbija, the national business directory.
 *
 * Ranked first for phone yield in `research/sources-contractors.json`: ~100% of
 * listing rows carry a phone, and the whole source is static HTML with no
 * pagination and no JavaScript.
 *
 * ## How it is crawled
 *
 * The site has no pagination at all. Its unit of listing is a page per
 * (category × city), and the national page of a category is **not** the union
 * of its city pages — FUZZ-8 measured 60 companies nationally against 108 over
 * the national page plus 49 city pages, i.e. 48 firms reachable only through a
 * city. So the national page is the seed and the city pages are the
 * enumeration, and both are crawled.
 *
 * Which city pages exist is the source's answer, not ours: every category page
 * links each of its city-scoped variants from `dl.dl_nei`, so `discover` reads
 * that list instead of composing `<category>-<grad>` out of the municipality
 * dataset. `geography.ts` explains why that distinction matters — the composed
 * form asks for pages that do not exist and gets a deterministic 500 for its
 * trouble. The dataset still orders and filters the list, so `--city` works and
 * a truncated run has covered the largest cities.
 *
 * ## Two phases, and why the second one is worth its request
 *
 * The listing already carries name, address and phone, so `extract` could have
 * been free. It is not, because the detail page carries what the listing has
 * no field for. Measured over 26 companies on 2026-08-20:
 *
 * | Detail page adds        | Companies |
 * | ----------------------- | --------- |
 * | an email address        | 8 / 26    |
 * | an external website link| 13 / 26   |
 * | at least one new phone  | 15 / 26   |
 * | more than one location  | 12 / 26   |
 *
 * The listing publishes **no email anywhere on the site**, so those eight are
 * eight emails that otherwise do not exist. One extra request per company buys
 * them, and the 14-day item staleness window means a re-run pays it for almost
 * nobody.
 *
 * ## Scopes
 *
 * One discovery scope per page, so a run that dies mid-sweep resumes at the
 * city it stopped on rather than at the first category:
 *
 * - `category:<slug>` — the national page. Its cursor holds the city slugs the
 *   page linked, so a resumed run does not have to re-fetch it to know what is
 *   left to do.
 * - `category:<slug>|city:<citySlug>` — one city page.
 */
import { HttpError, RequestBudgetExceededError, StructureChangedError } from '../../errors.js';
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import { CATEGORIES, type Category } from './categories.js';
import { cityTextInScope, planLocations } from './geography.js';
import { parseDetail, parseListing, type ListingItem, type LocationLink } from './parse.js';

const BASE_URL = 'https://www.portal-srbija.com';

const nationalScopeKey = (category: Category): string => `category:${category.slug}`;
const cityScopeKey = (category: Category, citySlug: string): string =>
  `category:${category.slug}|city:${citySlug}`;

/**
 * The city slugs of a category, stored on the national scope's cursor.
 *
 * The cursor is the adapter's own opaque value, and this is the useful thing to
 * put in it here: the list is the work queue, and re-deriving it costs a
 * request against a page whose only other purpose was already served.
 */
function encodeCursor(locations: readonly LocationLink[]): string {
  return JSON.stringify(locations.map((location) => location.citySlug));
}

function decodeCursor(
  cursor: string | null | undefined,
  category: Category,
): LocationLink[] | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .map((citySlug) => ({
        slug: `${category.slug}-${citySlug}`,
        citySlug,
        label: citySlug,
        url: `${BASE_URL}/${category.slug}-${citySlug}`,
      }));
  } catch {
    // A cursor we cannot read is a cursor we ignore; the page gets re-fetched.
    return null;
  }
}

function toItem(
  item: ListingItem,
  category: Category,
  citySlug: string | null,
  listingUrl: string,
): DiscoveredItem {
  return {
    url: item.url,
    scopeKey: citySlug === null ? nationalScopeKey(category) : cityScopeKey(category, citySlug),
    label: item.name,
    hints: {
      listingUrl,
      categorySlug: category.slug,
      categoryName: category.name,
      citySlug,
      listing: item,
    },
  };
}

/**
 * Anything that ends the whole run rather than this page.
 *
 * A structural failure is the source having changed and must stay loud; the
 * budget and an abort are the framework stopping us. Everything else — a 500 on
 * one city page, a timeout — costs that page and nothing more.
 */
function isFatal(error: unknown): boolean {
  return error instanceof StructureChangedError || error instanceof RequestBudgetExceededError;
}

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  const scope = ctx.scope.municipalities;
  // The same company is filed under several categories — `bartolomeo-blok` is
  // in three — and its detail page is one page whatever route reached it.
  // Yielding it once keeps `itemsDiscovered` a count of companies rather than
  // of sightings; the framework would skip the repeats as fresh regardless.
  const seen = new Set<string>();
  let pagesRead = 0;
  let pagesFailed = 0;

  for (const category of CATEGORIES) {
    if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;

    const nationalKey = nationalScopeKey(category);
    const resume = ctx.state.resume(nationalKey, ctx.scope, ctx.now());
    let locations: readonly LocationLink[] | null = resume.skip
      ? decodeCursor(ctx.state.getScope(nationalKey)?.cursor, category)
      : null;

    if (locations === null) {
      const url = `${BASE_URL}/${category.slug}`;
      try {
        const { $, finalUrl } = await ctx.http.html(url);
        const page = parseListing($, finalUrl, ctx.expect, {
          categorySlug: category.slug,
          requireItems: true,
        });
        pagesRead += 1;
        ctx.log.debug('national category page parsed', {
          url: finalUrl,
          companies: page.items.length,
          cityPages: page.locations.length,
        });

        for (const item of page.items) {
          // The national page mixes the whole country together, so a `--city`
          // run keeps only the rows whose own city string is in scope.
          if (!cityTextInScope(item.city, scope)) continue;
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          yield toItem(item, category, null, finalUrl);
        }

        locations = page.locations;
        ctx.state.saveScope(nationalKey, {
          cursor: encodeCursor(page.locations),
          status: 'done',
          lastError: null,
          at: ctx.now(),
        });
      } catch (error) {
        if (isFatal(error)) throw error;
        pagesFailed += 1;
        ctx.state.saveScope(nationalKey, {
          status: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
          at: ctx.now(),
        });
        ctx.log.warn('category page failed; skipping its city pages this run', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    for (const entry of planLocations(locations, scope)) {
      if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;

      const cityKey = cityScopeKey(category, entry.link.citySlug);
      if (ctx.state.resume(cityKey, ctx.scope, ctx.now()).skip) continue;

      try {
        const { $, finalUrl } = await ctx.http.html(entry.link.url);
        const page = parseListing($, finalUrl, ctx.expect, {
          categorySlug: category.slug,
          requireItems: false,
        });
        pagesRead += 1;
        if (page.items.length === 0) {
          // Legitimate for a filtered view, and not a structural failure: the
          // national page of this same template parsed cards minutes ago.
          ctx.log.info('city page has no companies', { url: finalUrl });
        }

        for (const item of page.items) {
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          yield toItem(item, category, entry.link.citySlug, finalUrl);
        }

        ctx.state.saveScope(cityKey, {
          cursor: null,
          status: 'done',
          lastError: null,
          at: ctx.now(),
        });
      } catch (error) {
        if (isFatal(error)) throw error;
        pagesFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        ctx.state.saveScope(cityKey, { status: 'failed', lastError: message, at: ctx.now() });
        // FUZZ-8 saw deterministic 500s on composed city slugs. This adapter
        // only asks for slugs the source itself links, so a 500 here is news —
        // logged with its URL, and retried on the next run because the scope
        // stays `failed`.
        ctx.log.warn('city page failed', {
          url: entry.link.url,
          status: error instanceof HttpError ? error.status : undefined,
          error: message,
        });
      }
    }
  }

  ctx.log.info('discovery complete', {
    listingPages: pagesRead,
    listingPagesFailed: pagesFailed,
    companies: seen.size,
  });
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const { $, finalUrl } = await ctx.http.html(item.url);
  const hints = (item.hints ?? {}) as Parameters<typeof parseDetail>[3];
  return [parseDetail($, finalUrl, ctx.expect, hints)];
}

const adapter: SourceAdapter = {
  id: 'portal-srbija',
  name: 'Portal Srbija',
  baseUrl: BASE_URL,
  // The nine categories are facade-selected, but sector pages mix installers
  // and material yards freely — `termodom` is a stovarište filed under termo
  // izolacija. Declaring one lead type would be a claim the pages do not
  // support; `src/lib/classify` decides per company.
  leadTypes: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
  category: 'national business directory (category + city taxonomy)',
  requiresJs: false,
  // Slower than the 1.5s default. This is a small Serbian directory serving
  // 150 KB static pages off one host, and a full sweep is ~350 listing pages
  // plus a detail page per company; there is nothing to gain by going faster.
  // robots.txt asks for no `Crawl-delay`, so this number is ours to choose.
  config: { requestDelayMs: 2000 },
  // The directory publishes no email address and no social profile on either
  // page shape — verified against the saved fixtures — so there is nothing of
  // its own to keep off a lead.
  sourceOwnedEmails: [],
  sourceOwnedProfiles: [],
  discover,
  extract,
};

export default adapter;
