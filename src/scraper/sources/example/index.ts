/**
 * `example` — the reference adapter.
 *
 * It is a complete, working source: paginated listing pages, detail pages,
 * a `robots.txt` that disallows one path, resume state, and the failure that
 * matters (`StructureChangedError`). The only thing unusual about it is where
 * it points — a local fixture server rather than a real host — which is what
 * lets it run green in CI with no network access.
 *
 * **Copy this directory to start a new source.** Nothing outside it needs
 * editing: `loadAdapters()` finds any directory here whose `index.ts`
 * default-exports a `SourceAdapter`.
 *
 * The two-phase shape is the part to imitate. `discover` walks listing pages
 * and saves its cursor **after each page**, so a run that dies on page 40
 * resumes on page 40 rather than page 1. `extract` fetches one detail page and
 * returns raw records. Neither of them fetches directly, canonicalizes a phone,
 * decides a lead's type or writes anything.
 */
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import { parseDetail, parseListing, type ListingItem } from './parse.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

/** Where the fixture site lives. A real adapter would hard-code its host here. */
const BASE_URL = process.env.EXAMPLE_SOURCE_BASE_URL ?? '';

/** The listing this source paginates over. One scope; a real source has many. */
const CATEGORY_PATH = '/firme/fasaderi';
const SCOPE_KEY = 'category:fasaderi';

/**
 * A convenience only the example needs: with no `EXAMPLE_SOURCE_BASE_URL` set,
 * it serves its own fixtures for the length of the crawl, so
 * `npm run scrape -- --source example --dry-run` works from a clean checkout.
 */
async function resolveBase(
  ctx: CrawlContext,
): Promise<{ base: string; server: FixtureServer | null }> {
  if (BASE_URL !== '') return { base: BASE_URL, server: null };
  const server = await startFixtureServer();
  ctx.log.info('serving the bundled fixture site', { url: server.url });
  return { base: server.url, server };
}

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  const { base, server } = await resolveBase(ctx);
  try {
    // Resume where the last run stopped — or start over, when the last run
    // finished and the listing has had time to gain new entries. `resume`
    // decides which; the cursor it hands back is opaque to everything outside
    // this adapter, and here it happens to be the next page's URL.
    const resume = ctx.state.resume(SCOPE_KEY, ctx.scope, ctx.now());
    if (resume.skip) {
      ctx.log.info('listing was crawled recently; nothing to discover', { scope: SCOPE_KEY });
      return;
    }

    let pageUrl: string | null = resume.cursor ?? `${base}${CATEGORY_PATH}`;
    let page = 0;

    while (pageUrl !== null) {
      const { $, finalUrl } = await ctx.http.html(pageUrl);
      const listing = parseListing($, finalUrl, ctx.expect);
      page += 1;
      ctx.log.debug('listing page parsed', { url: finalUrl, items: listing.items.length });

      for (const item of listing.items) {
        yield {
          url: item.url,
          scopeKey: SCOPE_KEY,
          label: item.name,
          hints: { ...item },
        };
      }

      pageUrl = listing.nextUrl;
      // Saved after every page, not at the end: a crawl that dies mid-run has
      // still recorded where it got to.
      ctx.state.saveScope(SCOPE_KEY, {
        cursor: pageUrl,
        status: pageUrl === null ? 'done' : 'in_progress',
        at: ctx.now(),
      });
    }

    ctx.log.info('discovery complete', { pages: page });
  } finally {
    await server?.close();
  }
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const { $, finalUrl } = await ctx.http.html(item.url);
  return [parseDetail($, finalUrl, ctx.expect, (item.hints ?? {}) as Partial<ListingItem>)];
}

const adapter: SourceAdapter = {
  id: 'example',
  name: 'Primer direktorijum (reference adapter)',
  baseUrl: BASE_URL === '' ? 'http://127.0.0.1' : BASE_URL,
  leadTypes: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
  category: 'reference adapter (local fixtures)',
  requiresJs: false,
  // The fixture site's robots.txt asks for a 1s crawl-delay and the framework
  // honours it; this says the same thing in the adapter, which is where a real
  // source's README-documented rate limit belongs.
  config: { requestDelayMs: 1000 },
  // Every listing carries the directory's own footer contact. Declaring it here
  // keeps it off every lead the source produces.
  sourceOwnedEmails: [],
  // The fixture server picks a fresh port on every run, so an item's URL is not
  // stable across runs — the same situation a source that decorates its links
  // with a session or tracking parameter creates. `resumeKey` is what makes an
  // item's identity survive it; without this line every item would look new on
  // every run and the crawl would never actually be incremental.
  resumeKey: (item) => new URL(item.url).pathname,
  discover,
  extract,
};

export default adapter;
