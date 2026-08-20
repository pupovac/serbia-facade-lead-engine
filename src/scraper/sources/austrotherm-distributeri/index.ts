/**
 * `austrotherm-distributeri` — Austrotherm Srbija's published dealer list.
 *
 * The highest yield-per-request source in the store registry, and the one this
 * project's cost policy is built for: **one GET returns the whole dataset.** No
 * pagination, no JavaScript, no API, no key, no paid call — 292 Serbian
 * businesses with a phone number on 290 of them, in a single 266 kB document.
 *
 * The segment fit is what makes it the top-ranked store source rather than
 * merely the cheapest. These are not shops in general: a yard on Austrotherm's
 * distributor list is, by definition, a business that already stocks and
 * resells expanded polystyrene facade insulation to exactly the customers our
 * panel targets.
 *
 * ## Why there is only one item
 *
 * `discover` yields a single `DiscoveredItem` — the page — and `extract` turns
 * it into every record on it. The two-phase split still earns its keep: the
 * scope's `rediscoverAfterMs` decides whether the page is worth re-reading at
 * all, and `--limit` is applied per record by the runner, so a capped run still
 * stops where it was told to. What it does not do is invent per-dealer URLs
 * that this source does not have. Provenance is per record and must be
 * re-openable: every record carries `/distributeri`, because that is genuinely
 * the page it was read at.
 *
 * ## Politeness
 *
 * A source that needs one request should never cost more than a handful. The
 * delay is doubled over the default and the request budget is cut to 25, which
 * is a fuse rather than a plan — the crawl spends two (robots.txt and the
 * page). Both overrides make the crawl gentler than the environment asks for,
 * which is the only direction an adapter is allowed to move them.
 *
 * `robots.txt` is quoted verbatim in this directory's README; nothing in it
 * matches `/distributeri`.
 */
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import { parseDealerList, type ParseOptions } from './parse.js';

const BASE_URL = 'https://www.austrotherm.rs';
const DEALERS_URL = `${BASE_URL}/distributeri`;

/** One page, so one scope. The key is stable so resume state survives a rename. */
const SCOPE_KEY = 'page:distributeri';

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  // `resume`, not `getScope().cursor`: a completed scope is not "nothing left
  // to do", it is "re-read this once it has had time to gain a dealer".
  const resume = ctx.state.resume(SCOPE_KEY, ctx.scope, ctx.now());
  if (resume.skip) {
    ctx.log.info('dealer list was walked recently; nothing to discover', { scope: SCOPE_KEY });
    return;
  }

  yield {
    url: DEALERS_URL,
    scopeKey: SCOPE_KEY,
    label: 'Austrotherm distributeri (cela lista)',
  };

  // There is no second page to leave a cursor for, so the scope is done the
  // moment its one item has been handed over.
  ctx.state.saveScope(SCOPE_KEY, { cursor: null, status: 'done', at: ctx.now() });
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const { $, finalUrl } = await ctx.http.html(item.url);

  const options: ParseOptions = {
    municipalities: ctx.scope.municipalities,
    resolveMunicipality: (name) => ctx.lib.geo.findMunicipalityByName(name),
  };
  const { leads, stats } = parseDealerList($, finalUrl, ctx.expect, options);

  // The skip counts are the point of this line. A source that quietly halves
  // looks exactly like a source that got smaller, and these numbers are what
  // tell the two apart in the run log.
  ctx.log.info('dealer list parsed', {
    url: finalUrl,
    rows: stats.rows,
    emitted: stats.emitted,
    withPhone: stats.withPhone,
    ...stats.skipped,
  });

  return leads;
}

const adapter: SourceAdapter = {
  id: 'austrotherm-distributeri',
  name: 'Austrotherm Srbija — Distributeri',
  baseUrl: BASE_URL,
  // Distributors and yards. The registry records `has_contractors: false` for
  // this source and the page bears that out — every row is a point of sale.
  leadTypes: ['CONSTRUCTION_MATERIAL_STORE'],
  category: 'manufacturer_distributor_list',
  requiresJs: false,
  config: { requestDelayMs: 3000, requestBudget: 25 },
  // Austrotherm's own addresses and profiles, so the manufacturer never ends up
  // attached to one of its dealers.
  sourceOwnedEmails: ['office@austrotherm.rs', 'info@austrotherm.rs'],
  sourceOwnedProfiles: [
    'https://www.facebook.com/Austrotherm.rs/',
    'https://www.instagram.com/austrothermsrb/',
    'https://www.linkedin.com/company/austrotherm-srbija',
    'https://www.youtube.com/channel/UCTa4taNQVpGFI3xukmCWhfw',
  ],
  discover,
  extract,
};

export default adapter;
