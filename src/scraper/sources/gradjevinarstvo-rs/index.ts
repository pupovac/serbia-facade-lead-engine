/**
 * `gradjevinarstvo-rs` — Gradjevinarstvo.rs, the construction trade portal's
 * company register.
 *
 * The second source in `research/sources-contractors.json` and the largest
 * crawlable one in it: **11,291 company pages**, measured off the sitemap, at
 * ~90% phone coverage. It is not a facade directory — it is the whole
 * construction sector, from cement plants to lift servicing — so the facade
 * slice has to be recovered by classification rather than by picking
 * categories, and `src/lib/classify` is what does that.
 *
 * ## Why it is worth a second adapter after `portal-srbija`
 *
 * A different population, reached a different way. `portal-srbija` enumerates
 * *facade categories* and finds the businesses that filed themselves under one.
 * This register enumerates *companies* and asks each what it does, which is the
 * only route to the firm whose page says "Specijalizovana ekipa za izvođenje
 * fasaderskih radova" while its categories say nothing but "Izvođenje
 * građevinskih radova" — `POPOVIĆ` in Kragujevac is exactly that, and no
 * category walk anywhere would have reached it.
 *
 * ## The enumeration is the sitemap, and that is not a shortcut
 *
 * `robots.txt` disallows `/Pretraga/GetFirme*`. That is the endpoint behind the
 * category pages' "Prikaži više" button, so a category page can be read once,
 * for its first twenty companies, and never paged. Rather than build a source
 * with a silent 20-per-category ceiling, this adapter walks
 * `/firme-sitemap` — which the same `robots.txt` advertises — and reads every
 * company. Permitted and complete, instead of permitted and truncated.
 *
 * ## Cost, and why the resume state carries it
 *
 * One request per company: ~11,300 of them, a little over three hours at one
 * per second. That is a real cost and it is paid once. Items carry a 14-day
 * staleness window, so the second run re-fetches almost nothing, and the walk
 * saves its position on every batch — a run stopped by `--limit`, by the
 * request budget or by a signal resumes at the next company id rather than at
 * the first.
 *
 * ## Serbia only
 *
 * The register is regional: `SKUPŠTINA OPŠTINE` in Vukosavlje prints
 * `74470 VUKOSAVLJE, BIH` and a `+387` number. The market is Serbia, so a
 * record whose contact card names another country is not emitted — and the
 * count of those is logged at the end of the walk, because a filter nobody can
 * see is indistinguishable from a parser that lost the records.
 */
import { resolveCityDetailed } from '@/lib/normalize';
import type { Municipality } from '@/lib/geo';
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import { parseFirm, toRawLead } from './parse.js';
import { parseFirmSitemap, type FirmRef } from './sitemap.js';

const BASE_URL = 'https://www.gradjevinarstvo.rs';
const SITEMAP_URL = `${BASE_URL}/firme-sitemap`;

/** One walk over one sitemap, so one scope. */
const SCOPE_KEY = 'sitemap:firme';

/** How often the walk writes down where it got to. */
const CURSOR_EVERY = 50;

/** The country token the register prints for Serbia. */
const SERBIA = 'SRB';

/** Per-run tallies for the things `extract` drops, keyed by the run's context. */
interface Tally {
  foreign: number;
  outOfScope: number;
  withPhone: number;
  emitted: number;
}
const tallies = new WeakMap<CrawlContext, Tally>();

function tallyOf(ctx: CrawlContext): Tally {
  let tally = tallies.get(ctx);
  if (tally === undefined) {
    tally = { foreign: 0, outOfScope: 0, withPhone: 0, emitted: 0 };
    tallies.set(ctx, tally);
  }
  return tally;
}

/** The cursor is a company id, not an index: the sitemap grows between runs. */
function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor === '') return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * `--city` support.
 *
 * The sitemap says nothing about where a company is, so this cannot narrow the
 * crawl — the page has to be fetched before its city is known. It still decides
 * whether the record is *emitted*, because `--city novi-sad` promising a Novi
 * Sad run and delivering the country would be worse than the wasted request.
 */
function cityInScope(city: string | null, scope: readonly Municipality[]): boolean {
  if (scope.length === 0) return true;
  if (city === null) return false;
  const resolution = resolveCityDetailed(city);
  if (!resolution.ok) return false;
  const { cityId, municipalityId } = resolution.match;
  return scope.some(
    (unit) =>
      unit.id === cityId ||
      unit.id === municipalityId ||
      // `--city beograd-vracar` against a page that only says "BEOGRAD".
      (unit.parent_id !== null && (unit.parent_id === cityId || unit.parent_id === municipalityId)),
  );
}

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  const resume = ctx.state.resume(SCOPE_KEY, ctx.scope, ctx.now());
  if (resume.skip) {
    ctx.log.info('company sitemap was walked recently; nothing to discover', { scope: SCOPE_KEY });
    return;
  }

  const after = decodeCursor(resume.cursor);
  const { body, finalUrl } = await ctx.http.text(SITEMAP_URL);
  const { firms, skipped } = parseFirmSitemap(body, BASE_URL);
  ctx.expect(firms, '<loc> entries matching /firme/{id}/{slug}', finalUrl, 'the company sitemap');

  const pending = firms.filter((firm) => firm.id > after);
  ctx.log.info('company sitemap read', {
    url: finalUrl,
    companies: firms.length,
    nonCompanyEntries: skipped,
    resumingAfterId: after === 0 ? null : after,
    pending: pending.length,
  });

  let lastId = after;
  let yielded = 0;
  let complete = false;

  try {
    for (const firm of pending) {
      if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;
      yield toItem(firm);
      lastId = firm.id;
      yielded += 1;
      if (yielded % CURSOR_EVERY === 0) {
        ctx.state.saveScope(SCOPE_KEY, {
          cursor: String(lastId),
          status: 'in_progress',
          at: ctx.now(),
        });
      }
    }
    complete = true;
  } finally {
    // Runs on the way out however the walk ended — exhausted, `--limit`, an
    // abort, a `break` in the runner. Whatever was reached is written down.
    const tally = tallyOf(ctx);
    ctx.state.saveScope(SCOPE_KEY, {
      cursor: complete ? null : String(lastId),
      status: complete ? 'done' : 'in_progress',
      lastError: null,
      at: ctx.now(),
    });
    ctx.log.info('company walk stopped', {
      companiesYielded: yielded,
      lastCompanyId: lastId,
      complete,
      recordsEmitted: tally.emitted,
      withPhone: tally.withPhone,
      skippedForeign: tally.foreign,
      skippedOutOfScopeCity: tally.outOfScope,
    });
  }
}

function toItem(firm: FirmRef): DiscoveredItem {
  return {
    url: firm.url,
    scopeKey: SCOPE_KEY,
    label: firm.slug,
    hints: { firmId: firm.id, slug: firm.slug },
  };
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const { $, finalUrl } = await ctx.http.html(item.url);
  const hints = (item.hints ?? {}) as { firmId?: number; slug?: string };
  const ref: FirmRef = {
    id: hints.firmId ?? 0,
    slug: hints.slug ?? '',
    url: item.url,
  };

  const page = parseFirm($, finalUrl, ctx.expect);
  const tally = tallyOf(ctx);

  // A missing country is kept: the field is printed for every company seen so
  // far, and if the template ever stops printing it, dropping the whole
  // register is the wrong failure. A country that is named and is not Serbia
  // is a foreign company and the market is Serbia only.
  if (page.contact.country !== null && page.contact.country !== SERBIA) {
    tally.foreign += 1;
    ctx.log.debug('company is outside Serbia; not emitted', {
      url: finalUrl,
      country: page.contact.country,
    });
    return [];
  }

  if (!cityInScope(page.contact.city, ctx.scope.municipalities)) {
    tally.outOfScope += 1;
    ctx.log.debug('company is outside the requested cities; not emitted', {
      url: finalUrl,
      city: page.contact.city,
    });
    return [];
  }

  tally.emitted += 1;
  if (page.contact.phones.length > 0) tally.withPhone += 1;

  return [toRawLead(page, finalUrl, ref)];
}

const adapter: SourceAdapter = {
  id: 'gradjevinarstvo-rs',
  name: 'Gradjevinarstvo.rs',
  baseUrl: BASE_URL,
  // Sector-wide. The register holds installers and material yards side by side
  // — `STIROKOOP` manufactures EPS boards, `IZO PRO TEAM` installs insulation —
  // so declaring one type would be a claim the pages do not support.
  leadTypes: ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE'],
  category: 'construction trade portal with company register',
  requiresJs: false,
  // 11,291 pages off one small host is the largest crawl in this project, and
  // the budget has to clear it in one run or the walk never finishes. It is
  // still a fuse: a loop that stops asking for new ids stops here.
  config: { requestBudget: 12_000 },
  // The portal's own address and profiles, so the publisher never ends up
  // attached to a company it lists. `extract` scopes `text` and `links` to the
  // record blocks, which keeps them out already; this is the second lock.
  sourceOwnedEmails: ['office@gradjevinarstvo.rs', 'redakcija@gradjevinarstvo.rs'],
  sourceOwnedProfiles: [
    'https://www.facebook.com/gradjevinarstvo',
    'https://www.twitter.com/gradjevinarstvo',
    'https://www.youtube.com/GradjevinarstvoVideo',
    'https://www.pinterest.com/gradjevinarstvo/',
  ],
  discover,
  extract,
};

export default adapter;
