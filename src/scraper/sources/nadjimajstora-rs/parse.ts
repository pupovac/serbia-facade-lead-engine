/**
 * `nadjimajstora-rs` — parsing listings, profiles, contact tabs and the phone
 * endpoint's reply. Pure functions of a body; nothing here fetches.
 *
 * ## Three traps this source sets, in the order they bite
 *
 * **1. Single-quoted attributes.** The listing prints
 * `<a href='…' class='Master-Item '>`. Any scraper matching `class="…"` finds
 * an empty page and reports a healthy run with zero leads. Parsing with cheerio
 * makes the quoting a non-issue — the fixture is kept anyway, because "we use a
 * real parser" is a claim a test should hold us to.
 *
 * **2. Page 1 is sorted differently from pages 2+.** The pager links
 * `?p=N&s=o&st=asc`, but the bare category URL sorts by rating *descending*.
 * Fetching page 1 bare and pages 2+ with the pager's parameters walks two
 * different orderings of the same list: measured on `fasader`, that returns 56
 * rows holding **36** distinct masters — a silent 36% loss that looks exactly
 * like a small source. `listingUrl` always sends the sort parameters, page 1
 * included.
 *
 * **3. The header count is not the number of rows the site will render.**
 * `moler` prints `1 - 20 od 456` and paginates 450. The difference is the
 * site's own bookkeeping, not a parser fault, so the walk stops on an empty
 * page and reports the gap rather than asserting equality and failing forever.
 *
 * ## The address field is three slots, two of them undivided
 *
 * The `Prebivalište` box prints street, place and a free-text line, but only
 * puts a `<br/>` before the last one — street and place arrive in a single text
 * node separated by whitespace:
 *
 * ```html
 * <p>
 *   Knez mihajla 5
 *                  Paraćin <br/>
 *   Paracin       </p>
 * ```
 *
 * There is no markup to split on, so the split is done on meaning: the place is
 * whichever known Serbian place name the chunk *ends* with, and whatever
 * precedes it is the street. The vocabulary comes from `src/lib/geo` —
 * municipalities and settlements both, because a Belgrade tradesman writes
 * `Sremčica` or `Karaburma` where the site's own dropdown would have said
 * `Čukarica` or `Palilula`. Over the 89 profiles in the two categories this
 * resolves 89 to a municipality; feeding the undivided chunk to the city
 * resolver instead does not.
 *
 * The third slot is free text the tradesmen fill inconsistently — a settlement
 * for some, a second street for others (`Tošin bunar 123` under a profile whose
 * place is `Novi Beograd`). It is kept verbatim in `extra`, and never trusted
 * as a place.
 */
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { municipalities } from '@/lib/geo';
import { settlements } from '@/lib/normalize';
import { foldForComparison, normalizeWhitespace } from '@/lib/text/fold.js';

/** `expect` from `CrawlContext`, narrowed to what a parser needs. */
export type Expect = <T>(
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string,
) => T;

/** A profile the listing pointed at. */
export interface MasterRef {
  /** The site's own master id — the key everything else is addressed by. */
  readonly id: number;
  readonly url: string;
  /** The name as the listing printed it. */
  readonly name: string;
  /** The average rating, as printed. Not a lead signal; kept for the record. */
  readonly rating: string | null;
}

export interface ListingPage {
  readonly items: readonly MasterRef[];
  /** The `od N` figure the page prints, when it prints one. */
  readonly total: number | null;
  /** The `1 - 20` range, for the log line. */
  readonly from: number | null;
  readonly to: number | null;
}

export interface ProfilePage {
  /** The site's master id, from the `ID:` line or, failing that, the URL. */
  readonly id: number | null;
  readonly name: string;
  /** The trade line under the name, e.g. `Fasader, Novi Sad`. */
  readonly trade: string | null;
  /**
   * The services this tradesman actually offers — the **ticked** boxes only.
   *
   * The page renders the whole vocabulary of the trade on every profile and
   * marks the selected ones with `.check.checked`; an unticked row is a grey
   * circle, which is the site saying "this one, no". Reading the list without
   * the class would have every fasader claiming all seven facade services,
   * including the ones they declined.
   */
  readonly occupations: readonly string[];
  /** Every box on the page, ticked or not — the trade's full vocabulary. */
  readonly offeredVocabulary: readonly string[];
  readonly rating: string | null;
  /** `12.05.2021.`, as printed. */
  readonly addedOn: string | null;
  /** Absolute URL of the contact tab, taken from the page's own nav. */
  readonly contactUrl: string | null;
}

export interface ContactPage {
  readonly address: string | null;
  /** The place name, matched against `src/lib/geo`. */
  readonly place: string | null;
  /** The free-text third line, verbatim, place or not. */
  readonly extraLine: string | null;
  readonly openingHours: string | null;
  /** `data-id` on the reveal button — the id to ask the phone endpoint for. */
  readonly telId: number | null;
}

const MASTER_ID = /-(\d+)\.html?$/i;

/**
 * The `1 - 20 od 56` line.
 *
 * The digit classes deliberately exclude whitespace. Allowing it lets the last
 * group run past the counter into whatever number the page prints next —
 * `izolater` reads `1 - 20 od 33` followed by a rating, and a whitespace-
 * tolerant pattern returns a total of 3312.
 */
const COUNTER = /(\d[\d.]*)\s*-\s*(\d[\d.]*)\s+od\s+(\d[\d.]*)/i;

/** Any Unicode letter. A name without one is the site's empty template. */
const HAS_LETTER = /\p{L}/u;

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = normalizeWhitespace(value);
  return trimmed === '' ? null : trimmed;
}

function digits(value: string): number | null {
  const parsed = Number(value.replace(/[^\d]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The master id out of a profile URL.
 *
 * The same master is reachable at two spellings — `srdjan-todic--2298.htm` from
 * the listing (the doubled dash is an empty city slug) and `srdjan-todic-2298`
 * from the page's own tabs. The id is the part that does not vary, which is why
 * it and not the URL is what this source resumes on.
 */
export function masterIdFrom(url: string): number | null {
  const path = url.split('?')[0] ?? url;
  const match = MASTER_ID.exec(path);
  return match?.[1] === undefined ? null : digits(match[1]);
}

/** A category listing page URL. The sort parameters are not optional — see the note above. */
export function listingUrl(baseUrl: string, slug: string, page: number): string {
  return `${baseUrl}/gradjevinski-radovi/${slug}.htm?p=${page}&s=o&st=asc`;
}

/**
 * One listing page.
 *
 * `expectItems` is the caller's call rather than this function's: page 1 of a
 * category the site says has 56 masters must hold rows, and page 4 of the same
 * category legitimately holds none. Asserting unconditionally would make the
 * end of every walk a structural failure.
 */
export function parseListing(
  $: CheerioAPI,
  url: string,
  options: { readonly expect?: Expect | undefined } = {},
): ListingPage {
  const anchors = $('a.Master-Item').toArray();
  if (options.expect !== undefined) {
    options.expect(anchors, 'a.Master-Item', url, 'the profile rows of a category listing');
  }

  const items: MasterRef[] = [];
  for (const anchor of anchors) {
    const href = text($(anchor).attr('href'));
    if (href === null) continue;
    const absolute = new URL(href, url).toString();
    const id = masterIdFrom(absolute);
    // A row whose href carries no id cannot be addressed at the phone endpoint,
    // which is the whole point of this source. Counted by the caller, not kept.
    if (id === null) continue;
    const name = text($(anchor).find('.Master-Name').text());
    if (name === null) continue;
    items.push({ id, url: absolute, name, rating: text($(anchor).find('.Master-Votes').text()) });
  }

  const counter = COUNTER.exec($('body').text());
  return {
    items,
    total: counter?.[3] === undefined ? null : digits(counter[3]),
    from: counter?.[1] === undefined ? null : digits(counter[1]),
    to: counter?.[2] === undefined ? null : digits(counter[2]),
  };
}

/**
 * The profile page — the record's canonical URL and its services checklist.
 *
 * The name is asserted, and it carries more weight than it looks. **An unknown
 * profile slug answers `200` with the template fully rendered and every field
 * blank** — not a 404. So "the name is empty" is this source's only signal that
 * a URL went nowhere, and without the assertion a mistyped slug would produce a
 * nameless record instead of an error. It was found exactly that way: a guessed
 * izolater URL returned `<h1> - </h1>`, `ID: `, and a rating of 9.3.
 *
 * The id is *not* asserted, because the URL always carries it too and the
 * caller has two more fallbacks. A blank `ID:` on a page whose name parsed is a
 * missing field, not a redesign.
 */
export function parseProfile($: CheerioAPI, url: string, expect: Expect): ProfilePage {
  // Not merely non-empty: the blank template renders `<h1> - </h1>`, which
  // trims to `-` and would sail through an emptiness check as a lead named `-`.
  // A tradesman's name has letters in it.
  const heading = text($('.Master-Title h1').first().text());
  const name = expect(
    heading !== null && HAS_LETTER.test(heading) ? heading : null,
    '.Master-Title h1',
    url,
    'the tradesman’s name on a profile page — note that an unknown slug returns 200 with a blank template whose heading is `-`, so a name with no letters in it means the URL went nowhere',
  );

  const idText = text($('.Master-Title .PibId').first().text());
  const id = (idText === null ? null : digits(idText)) ?? masterIdFrom(url);

  const occupations: string[] = [];
  const offeredVocabulary: string[] = [];
  for (const item of $('.Master-Home-Contents-Occupations-Item h4').toArray()) {
    const value = text($(item).text());
    if (value === null) continue;
    offeredVocabulary.push(value);
    if ($(item).find('.check').hasClass('checked')) occupations.push(value);
  }

  const contactHref = $('.Master-Nav-Tabs a')
    .toArray()
    .map((anchor) => $(anchor).attr('href'))
    .find((href) => href !== undefined && /\/kontakt\.html?$/i.test(href));

  return {
    id,
    name,
    trade: text($('.Master-Title h3').first().text()),
    occupations,
    offeredVocabulary,
    rating: text($('.Master-Vote h3').first().text()),
    addedOn: text($('.Master-Date-Added strong').first().text()),
    contactUrl: contactHref === undefined ? null : new URL(contactHref, url).toString(),
  };
}

/** Every place name `src/lib/geo` knows, longest first so `Novi Sad` beats `Sad`. */
const PLACE_VOCABULARY: ReadonlyArray<{ readonly name: string; readonly folded: string }> = (() => {
  const names = new Set<string>();
  for (const unit of municipalities) {
    names.add(unit.name_sr);
    names.add(unit.name_ascii);
  }
  for (const settlement of settlements) names.add(settlement.name);
  return [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ name, folded: foldForComparison(name) }));
})();

/**
 * Split `Knez mihajla 5 Paraćin` into its street and its place.
 *
 * Returns the place as `null` when the chunk ends in nothing recognisable,
 * which is the honest answer for a line that is only a street.
 */
export function splitPlaceLine(line: string): {
  readonly street: string | null;
  readonly place: string | null;
} {
  const value = normalizeWhitespace(line);
  if (value === '') return { street: null, place: null };
  const folded = foldForComparison(value);
  for (const candidate of PLACE_VOCABULARY) {
    if (folded === candidate.folded) return { street: null, place: value };
    if (folded.endsWith(` ${candidate.folded}`)) {
      // Fold and original agree on length: `foldForComparison` maps characters
      // one-for-one apart from whitespace, which is already collapsed here.
      const cut = value.length - candidate.name.length;
      return { street: text(value.slice(0, cut)), place: text(value.slice(cut)) };
    }
  }
  return { street: value, place: null };
}

/** The contact tab — address, opening hours, and the id the phone button carries. */
export function parseContact($: CheerioAPI): ContactPage {
  const boxFor = (heading: string): Cheerio<Element> | null => {
    for (const box of $('.Master-Contact-Box-Contents').toArray()) {
      if (foldForComparison($(box).find('h3').first().text()) === foldForComparison(heading)) {
        return $(box);
      }
    }
    return null;
  };

  const residence = boxFor('Prebivalište');
  const lines: string[] = [];
  if (residence !== null) {
    const html = residence.find('p').first().html() ?? '';
    for (const chunk of html.split(/<br\s*\/?>/i)) {
      const value = text($('<div>').html(chunk).text());
      if (value !== null) lines.push(value);
    }
  }

  let address: string | null = null;
  let place: string | null = null;
  const unused: string[] = [];
  for (const line of lines) {
    const split = splitPlaceLine(line);
    if (split.place !== null && place === null) {
      place = split.place;
      address ??= split.street;
    } else if (split.street !== null && address === null && place === null) {
      address = split.street;
    } else {
      unused.push(line);
    }
  }

  const hours = boxFor('Radno vreme');
  const telId = text($('#show-tel').first().attr('data-id'));

  return {
    address,
    place,
    extraLine: unused.length === 0 ? null : unused.join(', '),
    openingHours: hours === null ? null : text(hours.find('p').first().text()),
    telId: telId === null ? null : digits(telId),
  };
}

/** The `master/show_tel/` reply. `ind` is the site's own ok flag. */
export interface ShowTelReply {
  readonly ind?: number;
  readonly html?: string;
  readonly msg?: string;
}

/**
 * The phone numbers out of the reveal endpoint's reply.
 *
 * The payload is a fragment of two `tel:` anchors, the second usually empty —
 * a master may register a second number and most do not. Both the `href` and
 * the anchor text carry the number; the `href` is read, the text is the
 * fallback for the day one of them is dropped.
 *
 * An unknown id answers with the JSON literal `null`, which is why the caller
 * gets `null` back here rather than an empty list: "this master has no number"
 * and "this endpoint did not recognise the request" are different facts and
 * only one of them is a source change.
 */
export function parseShowTel(body: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const reply = parsed as ShowTelReply;
  if (reply.ind !== 1 || typeof reply.html !== 'string') return null;

  const $ = cheerio.load(reply.html);
  const numbers: string[] = [];
  for (const anchor of $('a').toArray()) {
    const href = $(anchor).attr('href') ?? '';
    const fromHref = href.replace(/^tel:/i, '');
    const value = text(fromHref) ?? text($(anchor).text());
    if (value !== null && !numbers.includes(value)) numbers.push(value);
  }
  return numbers;
}
