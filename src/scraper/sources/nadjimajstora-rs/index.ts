/**
 * `nadjimajstora-rs` — Nađi Majstora, the Serbian tradesman directory.
 *
 * A small source that answers the question the pilot could not: **89 profiles,
 * every one of them a facade or insulation installer by the site's own filing,
 * and every one of them with a phone number.** Measured on 2026-08-21, phone
 * coverage over the full two categories is 89/89.
 *
 * That last figure is the reason this adapter exists. FUZZ-40 was opened with
 * the phone mechanism unknown and an explicit instruction: a source that yields
 * names and no numbers is not worth an adapter. It yields numbers.
 *
 * ## Where the phone number lives
 *
 * Not in the profile HTML, and not behind a browser either. The contact tab
 * renders a button, and `/js/main.js` binds it to one request:
 *
 * ```
 * POST https://www.nadjimajstora.rs/master/show_tel/
 * Content-Type: application/x-www-form-urlencoded
 * id=2298
 *
 * {"ind":1,"html":"\n<a href=\"tel:0645880669 \" >0645880669 <\/a><br\/>\n<a href=\"tel:\" ><\/a>","msg":"Show master phone"}
 * ```
 *
 * No cookie, no token, no referer check, no session — the id alone is the whole
 * request, and an unknown id answers `null`. So the number is reachable with
 * `fetch`, and **Playwright is not needed here**, which the issue explicitly
 * left open as an acceptable fallback. Replaying the site's own request is
 * three orders of magnitude cheaper than rendering 89 pages to click a button,
 * and it is the same request a visitor makes.
 *
 * The endpoint is not disallowed: `robots.txt` names `/cgi-bin/`, `/mezimci/`,
 * `/ac/` and one specific profile, and nothing else. The one disallowed profile
 * is a driver in Kikinda, in a category this adapter never walks.
 *
 * ## Cost
 *
 * Three requests per master — profile, contact tab, phone — so 267 for the full
 * two categories, about five minutes at one request per second. Small enough
 * that the staleness window can stay short and the whole source can be
 * re-walked whenever the pilot database wants refreshing.
 *
 * ## Classification is asserted, not inferred
 *
 * These are `preduzetnici` — sole traders listed as `Srdjan Todić`, not as
 * `TERMO FASADE d.o.o.`. There is no facade word in a personal name, so the
 * word-scorer would file most of this source under `UNKNOWN`, which is exactly
 * the 84% loss FUZZ-38 exists to stop. The category is the evidence, so the
 * adapter sets `assertedType` and the pipeline keeps the scorer's opinion
 * beside it for audit rather than acting on it.
 *
 * ## The same tradesman can hold two profiles
 *
 * A master registered in both trades gets two ids and two profiles: `Knauf
 * Profi` is 380 under `fasader` and 395 under `izolater`, with the same two
 * phone numbers on both. 13 of the 89 records are duplicates of this kind, and
 * the adapter emits all of them — merging is `src/lib/dedup`'s job and the
 * strongest possible signal, an identical normalized phone, is right there on
 * both records.
 */
import type { CrawlContext, DiscoveredItem, RawLeadInput, SourceAdapter } from '../../types.js';
import { StructureChangedError } from '../../errors.js';
import { CATEGORIES, categoryBySlug, type TradeCategory } from './categories.js';
import {
  listingUrl,
  parseContact,
  parseListing,
  parseProfile,
  parseShowTel,
  type MasterRef,
} from './parse.js';

const BASE_URL = 'https://www.nadjimajstora.rs';

/** The endpoint `/js/main.js` calls to reveal a number. */
const SHOW_TEL_URL = `${BASE_URL}/master/show_tel/`;

/** The listing renders 20 rows a page, and has since the source was first probed. */
const PAGE_SIZE = 20;

/**
 * A fuse, not an expectation. `fasader` is 3 pages and `izolater` is 2; a
 * source that started answering every page with rows would otherwise walk
 * forever.
 */
const MAX_PAGES = 60;

/**
 * How many masters may come back without a phone before the run treats the
 * reveal endpoint as broken rather than the tradesmen as unreachable.
 *
 * Coverage is 89/89 today. If `show_tel` starts refusing us — a token, a
 * referer check, a rename — every record still parses and the run would report
 * 89 healthy leads with no numbers, which is the one failure this source cannot
 * be allowed to have. So a run that asks this many times and never once gets a
 * number stops and says the structure changed.
 */
const PHONELESS_STREAK_LIMIT = 12;

interface Tally {
  emitted: number;
  withPhone: number;
  phoneNumbers: number;
  /** Consecutive `extract` calls that produced no phone. Reset by any success. */
  phonelessStreak: number;
  noContactTab: number;
  unresolvedPlace: number;
}
const tallies = new WeakMap<CrawlContext, Tally>();

function tallyOf(ctx: CrawlContext): Tally {
  let tally = tallies.get(ctx);
  if (tally === undefined) {
    tally = {
      emitted: 0,
      withPhone: 0,
      phoneNumbers: 0,
      phonelessStreak: 0,
      noContactTab: 0,
      unresolvedPlace: 0,
    };
    tallies.set(ctx, tally);
  }
  return tally;
}

const scopeKeyFor = (slug: string): string => `category:${slug}`;

/** The cursor is the last page finished, so a stopped walk resumes at the next one. */
function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor === '') return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

async function* walkCategory(
  category: TradeCategory,
  ctx: CrawlContext,
): AsyncIterable<DiscoveredItem> {
  const scopeKey = scopeKeyFor(category.slug);
  const resume = ctx.state.resume(scopeKey, ctx.scope, ctx.now());
  if (resume.skip) {
    ctx.log.info('category was walked recently; nothing to discover', { scope: scopeKey });
    return;
  }

  let page = decodeCursor(resume.cursor) + 1;
  let total: number | null = null;
  let seen = 0;
  let complete = false;
  // One master can be listed twice within a category — `Miloš Stojanović` holds
  // four ids under `fasader`. Distinct ids are what the page count is compared
  // against, so a re-listed master does not read as a healthy page.
  const ids = new Set<number>();

  try {
    while (page <= MAX_PAGES) {
      if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;

      const url = listingUrl(BASE_URL, category.slug, page);
      const { $, finalUrl } = await ctx.http.html(url);
      // Page 1 of a category the site advertises must hold rows; a later page
      // running out is how the walk ends.
      const listing = parseListing($, finalUrl, page === 1 ? { expect: ctx.expect } : {});
      if (listing.total !== null) total = listing.total;

      if (listing.items.length === 0) {
        complete = true;
        break;
      }

      for (const item of listing.items) {
        seen += 1;
        ids.add(item.id);
        yield toItem(item, category);
      }

      ctx.state.saveScope(scopeKey, { cursor: String(page), status: 'in_progress', at: ctx.now() });

      // A short page is the last page. Guarding on the counter as well would
      // trust a figure the site does not honour — see `parse.ts`.
      if (listing.items.length < PAGE_SIZE) {
        complete = true;
        break;
      }
      page += 1;
    }
  } finally {
    ctx.state.saveScope(scopeKey, {
      cursor: complete ? null : String(page - 1),
      status: complete ? 'done' : 'in_progress',
      lastError: null,
      at: ctx.now(),
    });
    ctx.log.info('category walk stopped', {
      category: category.slug,
      rowsYielded: seen,
      distinctMasters: ids.size,
      headerTotal: total,
      // The site's own counter runs ahead of what it paginates: `moler` says 456
      // and renders 450. Reported so the gap is visible and not mistaken for loss.
      unrenderedByHeader: total === null ? null : Math.max(0, total - seen),
      pagesRead: page - decodeCursor(resume.cursor) - (complete ? 1 : 0),
      complete,
    });
  }
}

async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  for (const category of CATEGORIES) {
    if (ctx.signal.aborted || ctx.http.budgetExhausted()) return;
    yield* walkCategory(category, ctx);
  }
}

function toItem(master: MasterRef, category: TradeCategory): DiscoveredItem {
  return {
    url: master.url,
    scopeKey: scopeKeyFor(category.slug),
    label: `${master.name} (${category.slug}/${master.id})`,
    hints: {
      masterId: master.id,
      categorySlug: category.slug,
      listingName: master.name,
      rating: master.rating,
    },
  };
}

/** The reveal endpoint, replayed. Returns `null` when it did not recognise the id. */
async function fetchPhones(
  masterId: number,
  ctx: CrawlContext,
): Promise<{ readonly phones: readonly string[]; readonly recognised: boolean }> {
  const { body } = await ctx.http.text(SHOW_TEL_URL, { form: { id: String(masterId) } });
  const parsed = parseShowTel(body);
  if (parsed === null) return { phones: [], recognised: false };
  return { phones: parsed, recognised: true };
}

async function extract(item: DiscoveredItem, ctx: CrawlContext): Promise<readonly RawLeadInput[]> {
  const hints = (item.hints ?? {}) as {
    masterId?: number;
    categorySlug?: string;
    listingName?: string;
    rating?: string | null;
  };
  const category =
    categoryBySlug(hints.categorySlug ?? '') ??
    // An item discovered before a category was renamed still has to extract.
    ({
      slug: hints.categorySlug ?? 'unknown',
      label: hints.categorySlug ?? 'unknown',
      assertion: `listed under gradjevinski-radovi/${hints.categorySlug ?? 'unknown'}`,
      measuredCount: 0,
    } satisfies TradeCategory);

  const { $, finalUrl } = await ctx.http.html(item.url);
  const profile = parseProfile($, finalUrl, ctx.expect);
  const tally = tallyOf(ctx);

  let contact = null;
  if (profile.contactUrl === null) {
    // Not fatal on its own: the address is a bonus and the phone is keyed by an
    // id the profile already gave us. Counted, so a template change that drops
    // the tab everywhere is visible in the run summary.
    tally.noContactTab += 1;
  } else {
    const contactPage = await ctx.http.html(profile.contactUrl);
    contact = parseContact(contactPage.$);
  }

  const masterId = contact?.telId ?? profile.id ?? hints.masterId ?? null;
  const revealed =
    masterId === null ? { phones: [], recognised: false } : await fetchPhones(masterId, ctx);

  if (revealed.phones.length === 0) {
    tally.phonelessStreak += 1;
    if (tally.phonelessStreak >= PHONELESS_STREAK_LIMIT && tally.withPhone === 0) {
      throw new StructureChangedError({
        sourceId: 'nadjimajstora-rs',
        url: SHOW_TEL_URL,
        selector: 'POST master/show_tel/ → {"ind":1,"html":"<a href=\'tel:…\'>"}',
        expected: `a phone number for at least one of the first ${PHONELESS_STREAK_LIMIT} masters — coverage was 89/89 on 2026-08-21, so none at all means the reveal endpoint changed, not that the tradesmen are unlisted`,
      });
    }
  } else {
    tally.phonelessStreak = 0;
    tally.withPhone += 1;
    tally.phoneNumbers += revealed.phones.length;
  }

  if (contact !== null && contact.place === null) tally.unresolvedPlace += 1;
  tally.emitted += 1;

  const name = profile.name;
  // The ticked services are the only free text these profiles carry, and they
  // are what a reviewer reads to tell a `Termoizolacija` crew from a `Drenaža`
  // one. They ride as categories, alongside the trade the site filed them
  // under. Only the ticked ones: the page prints the whole trade vocabulary and
  // greys out what the tradesman declined, so the unticked rows are the
  // opposite of a claim.
  const categories = [category.label, ...profile.occupations];

  return [
    {
      sourceUrl: finalUrl,
      name,
      phones: [...revealed.phones],
      ...(contact?.place === undefined || contact.place === null ? {} : { city: contact.place }),
      ...(contact?.address === undefined || contact.address === null
        ? {}
        : { address: contact.address }),
      categories,
      ...(contact?.openingHours === undefined || contact.openingHours === null
        ? {}
        : { openingHours: contact.openingHours }),
      assertedType: 'FACADE_CONTRACTOR',
      assertedTypeReason: category.assertion,
      // Deliberately narrow: the profile page is mostly site chrome, and the
      // only text that belongs to this business is its name and its services.
      // Handing the pipeline the whole page would attach the directory's own
      // switchboard and social profiles to every tradesman on it.
      text: [name, profile.trade, ...profile.occupations].filter((x) => x !== null).join('\n'),
      links: [],
      extra: {
        masterId,
        categorySlug: category.slug,
        occupations: profile.occupations,
        // Everything on the page, ticked or not — so a reviewer can see what
        // this tradesman was offered and turned down, not just what they took.
        occupationVocabulary: profile.offeredVocabulary,
        rating: profile.rating ?? hints.rating ?? null,
        addedOn: profile.addedOn,
        contactUrl: profile.contactUrl,
        // The site's inconsistent third address line, kept verbatim and never
        // trusted as a place — it is a settlement for some masters and a second
        // street for others.
        residenceExtraLine: contact?.extraLine ?? null,
        phoneSource: 'POST /master/show_tel/',
        phoneRecognised: revealed.recognised,
      },
    },
  ];
}

const adapter: SourceAdapter = {
  id: 'nadjimajstora-rs',
  name: 'Nađi Majstora',
  baseUrl: BASE_URL,
  // Tradesmen only. There is no material-yard category on this site, and a
  // record from here is never a stovarište.
  leadTypes: ['FACADE_CONTRACTOR'],
  category: 'tradesman directory, pre-filtered by trade',
  // The reveal button's request is replayable with `fetch` — see the note above.
  requiresJs: false,
  // 89 masters × 3 requests, plus listing pages and slack for growth. Small,
  // and a ceiling on a small Apache host that has no protection of its own.
  config: { requestBudget: 600 },
  // No `sourceOwnedEmails` or `sourceOwnedProfiles`: the directory publishes
  // neither an address nor a social profile anywhere in the pages this adapter
  // reads — grepped across every fixture, zero of each. Listing plausible ones
  // would be invention, and `extract` hands the pipeline no links at all
  // regardless, so there is nothing for a publisher's own contact to leak into.
  discover,
  extract,
  /**
   * The master id, not the URL. The listing spells a profile
   * `srdjan-todic--2298.htm` and the page's own tabs spell it
   * `srdjan-todic-2298`; a slug also changes when a tradesman edits their name.
   * The id is what stays.
   */
  resumeKey(item: DiscoveredItem): string {
    const hints = (item.hints ?? {}) as { masterId?: number };
    return hints.masterId === undefined ? item.url : `master:${hints.masterId}`;
  },
};

export default adapter;
