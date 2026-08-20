/**
 * `austrotherm-distributeri` — parsing. A pure function of the response body.
 *
 * The whole source is one static document: Austrotherm Srbija's dealer list,
 * every entry inlined, no pagination and no JavaScript. So there is no listing
 * / detail split to model — there is one page and, at the last measured pass,
 * 292 Serbian businesses on it.
 *
 * Three things about this page decide the shape of everything below.
 *
 * 1. **The list is not only Serbian.** A `Distributeri CRNA GORA` row sits
 *    mid-alphabet at position 69 of 325, and Montenegrin entries continue
 *    *interleaved* after it — 62 Serbian rows before that heading and 228
 *    after. Splitting the list on the heading is the obvious reading and it is
 *    wrong. The country calling code on the phone line is the reliable signal,
 *    with the postal code as the fallback for the handful of rows that print no
 *    phone at all.
 * 2. **The map template leaves debris in the list.** The first two `div.dealer`
 *    blocks are the widget's own empty prototypes — no name, `data-latitude=0`.
 *    They are skipped, and counted, so "two rows dropped" never quietly becomes
 *    "two hundred".
 * 3. **The page publishes coordinates, not a maps link.** `data-latitude` /
 *    `data-longitude` are on every real row. Those go into the record's
 *    modelled `latitude` / `longitude`, and the Google Maps URL the store sheet
 *    wants is written from them — see `mapsUrlFor`.
 */
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import type { RawLeadInput } from '../../types.js';

/** `expect` from `CrawlContext`, narrowed to what a parser needs. */
export type Expect = <T>(
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string,
) => T;

/** The dealer list container. Asserted — an empty match here is a redesign. */
export const DEALER_SELECTOR = '#dealers-list div.dealer';
const NAME_SELECTOR = '.header .text.hl';
const ADDRESS_SELECTOR = '.header .text.address';
const DETAILS_SELECTOR = '[data-details]';
/** Not a CSS selector; the text shape the phone lives in, named for the error message. */
const PHONE_SELECTOR = `${DEALER_SELECTOR} ${DETAILS_SELECTOR} (text "T +381 …")`;

/**
 * A phone line, as this page prints it: `T +381 (0)18 469 40 13`.
 *
 * Anchored on the `T` prefix on purpose. One row prints a fax on the same line
 * behind an `F` (`… 414 847 F +381 (0)63 106 20 39`) and a fax is not the
 * number a salesperson dials. The captured run stops at the first character
 * that cannot be part of a number, which is what keeps `ili 414 849` and the
 * `F` that follows it out of the field. The whole line still reaches the record
 * as `text`, so `src/lib` can read anything this deliberately does not.
 */
const PHONE_LINE = /\bT\s*(\+38\d[\d()\s./-]*\d)/g;

/** The separator row: a name and a rule of dashes where the address belongs. */
const SEPARATOR_ADDRESS = /^-{3,}$/;

/** Serbian postal codes run 1xxxx–3xxxx; Montenegro's run 8xxxx. */
const RS_POSTAL = { min: 10_000, max: 39_999 } as const;
const ME_POSTAL = { min: 80_000, max: 89_999 } as const;

/**
 * Why a row on the page did not become a record.
 *
 * Reported rather than swallowed: a run that silently halves is the failure
 * this project cannot have, and these counts are what make the difference
 * between "the page shrank" and "the parser broke" visible in the run log.
 */
export type SkipReason = 'template' | 'separator' | 'foreign' | 'unknown-country' | 'out-of-scope';

export interface ParseStats {
  /** Every `div.dealer` on the page, debris included. */
  readonly rows: number;
  /** Rows that became records. */
  readonly emitted: number;
  /** Emitted records carrying at least one phone string. */
  readonly withPhone: number;
  readonly skipped: Readonly<Record<SkipReason, number>>;
}

export interface ParsedDealerList {
  readonly leads: readonly RawLeadInput[];
  readonly stats: ParseStats;
}

export interface ParsedAddress {
  readonly address: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
}

/** `Municipality`-shaped, minus the fields a scope filter does not read. */
export interface ScopeMunicipality {
  readonly id: string;
}

export interface ParseOptions {
  /**
   * `--city`, already resolved. Empty means the whole country.
   *
   * The filter is deliberately one-sided: a row is dropped only when its city
   * resolves to a municipality outside the set. A row whose city does not
   * resolve at all is kept, because `--city beograd` must not silently discard
   * a Belgrade yard whose address this page spells in a way `src/lib/geo` has
   * not seen.
   */
  readonly municipalities?: readonly ScopeMunicipality[] | undefined;
  /** `ctx.lib.geo.findMunicipalityByName`. Injected so the parser stays pure. */
  readonly resolveMunicipality?: ((name: string) => ScopeMunicipality | undefined) | undefined;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * `Mramorsko brdo bb, 18000 Niš` → street, postal code, city.
 *
 * Every fallback here is a row that actually exists on the page rather than a
 * defensive guess: `11300, Smederevo Smederevo` leads with its postal code,
 * `Babin Lug 5e, Babin Lug 5e Vinča` has none, and `114306 Beograd - Grocka`
 * has a six-digit typo for `11430`. The typo is preserved, not corrected — the
 * record carries what the source published and `src/lib` decides what it means.
 */
export function parseAddressLine(line: string): ParsedAddress | null {
  const value = collapse(line).replace(/,\s*$/, '');
  if (value === '' || SEPARATOR_ADDRESS.test(value)) return null;

  const trailing = value.match(/^(.*?),\s*(\d{4,6})\s+(.+)$/);
  if (trailing !== null) {
    return {
      address: trailing[1]?.trim() || null,
      postalCode: trailing[2] ?? null,
      city: trailing[3]?.trim() || null,
    };
  }

  const leading = value.match(/^(\d{4,6}),?\s+(.+)$/);
  if (leading !== null) {
    return { address: null, postalCode: leading[1] ?? null, city: leading[2]?.trim() || null };
  }

  const comma = value.lastIndexOf(',');
  if (comma > 0) {
    return {
      address: value.slice(0, comma).trim() || null,
      postalCode: null,
      city: value.slice(comma + 1).trim() || null,
    };
  }

  return { address: value, postalCode: null, city: null };
}

/**
 * Which country a row belongs to.
 *
 * The phone's calling code first, because it is the only signal on this page
 * that the `Distributeri CRNA GORA` heading cannot mislead. Postal code second,
 * for the two Serbian and one Montenegrin rows that print no phone.
 */
export function countryOf(
  phones: readonly string[],
  postalCode: string | null,
): 'RS' | 'ME' | null {
  for (const phone of phones) {
    const code = phone.match(/^\+(38\d)/)?.[1];
    if (code === '381') return 'RS';
    if (code === '382') return 'ME';
  }
  if (postalCode !== null && /^\d{5}$/.test(postalCode)) {
    const numeric = Number(postalCode);
    if (numeric >= RS_POSTAL.min && numeric <= RS_POSTAL.max) return 'RS';
    if (numeric >= ME_POSTAL.min && numeric <= ME_POSTAL.max) return 'ME';
  }
  return null;
}

/** A `data-latitude` / `data-longitude` attribute → a usable number, or null. */
function coordinate(value: string | undefined, limit: number): number | null {
  if (value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  return Math.abs(numeric) > limit ? null : numeric;
}

/**
 * The Google Maps URL for a row, from the coordinates the page publishes.
 *
 * This source does not print a maps link; it prints `data-latitude` and
 * `data-longitude` on every real row, which is strictly better data. The store
 * sheet wants a link a salesperson can tap, and `maps.google.com/?q=lat,lon` is
 * that link with nothing added — the coordinates as published, in URL form. The
 * numbers themselves also travel on the record's `latitude` / `longitude`, so
 * nothing downstream has to take this URL's word for anything.
 *
 * The `?q=` form rather than the `?api=1&query=` one, deliberately.
 * `src/lib/contact` owns what a Google Maps link means, and it reads `q`,
 * `destination`, `daddr`, `ll` and `center` — not `query` — then canonicalizes
 * whatever it read to `https://www.google.com/maps/search/?api=1&query=…`. So
 * this hands it a URL it can actually parse and lets it produce the canonical
 * form, instead of an adapter deciding the canonical form for itself. (That the
 * extractor cannot re-read its own output is a round-trip gap in
 * `src/lib/contact`, raised with the Data Engineer rather than patched here.)
 */
export function mapsUrlFor(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null) return null;
  return `https://maps.google.com/?q=${latitude},${longitude}`;
}

interface DealerRow {
  readonly index: number;
  readonly name: string;
  readonly addressLine: string;
  readonly details: string;
  readonly phones: readonly string[];
  readonly address: ParsedAddress | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

function readRow($: CheerioAPI, element: Element, index: number): DealerRow {
  const block: Cheerio<Element> = $(element);
  const details = collapse(block.find(DETAILS_SELECTOR).first().text());
  const addressLine = collapse(block.find(ADDRESS_SELECTOR).first().text());
  return {
    index,
    name: collapse(block.find(NAME_SELECTOR).first().text()),
    addressLine,
    details,
    phones: [...details.matchAll(PHONE_LINE)].map((match) => collapse(match[1] ?? '')),
    address: parseAddressLine(addressLine),
    latitude: coordinate(block.attr('data-latitude'), 90),
    longitude: coordinate(block.attr('data-longitude'), 180),
  };
}

/**
 * The whole page → the Serbian dealer records on it.
 *
 * The three assertions are what stand between this source and the failure mode
 * the framework exists to prevent: a healthy 200 whose markup no longer matches,
 * reported as a successful run that found nothing.
 *
 * - the dealer container, because the page guarantees a dealer list;
 * - at least one row with a name, because an all-empty list is the map widget's
 *   template surviving where the data used to be;
 * - a phone on **most** Serbian rows, because 290 of 292 carried one at the
 *   last pass. A page that keeps its markup but moves the number behind an
 *   `href` — the trap NaVidiku sets — would otherwise return 292 phoneless
 *   leads and look like a working crawl.
 */
export function parseDealerList(
  $: CheerioAPI,
  pageUrl: string,
  expect: Expect,
  options: ParseOptions = {},
): ParsedDealerList {
  const elements = $(DEALER_SELECTOR).toArray();
  expect(elements, DEALER_SELECTOR, pageUrl, 'one or more dealer blocks');

  const rows = elements.map((element, index) => readRow($, element, index));
  const named = rows.filter((row) => row.name !== '');
  expect(named, `${DEALER_SELECTOR} ${NAME_SELECTOR}`, pageUrl, 'dealer rows carrying a name');

  const skipped: Record<SkipReason, number> = {
    template: rows.length - named.length,
    separator: 0,
    foreign: 0,
    'unknown-country': 0,
    'out-of-scope': 0,
  };

  const serbian: DealerRow[] = [];
  for (const row of named) {
    if (row.address === null) {
      skipped.separator += 1;
      continue;
    }
    const country = countryOf(row.phones, row.address.postalCode);
    if (country === 'RS') serbian.push(row);
    else if (country === 'ME') skipped.foreign += 1;
    else skipped['unknown-country'] += 1;
  }

  const withPhone = serbian.filter((row) => row.phones.length > 0);
  expect(
    withPhone.length * 2 >= serbian.length ? withPhone : null,
    PHONE_SELECTOR,
    pageUrl,
    `a phone line on most Serbian rows — 290 of 292 at the last research pass, ` +
      `${withPhone.length} of ${serbian.length} here`,
  );

  const leads: RawLeadInput[] = [];
  for (const row of serbian) {
    if (!inScope(row, options)) {
      skipped['out-of-scope'] += 1;
      continue;
    }
    leads.push(toRawLead(row, pageUrl));
  }

  return {
    leads,
    stats: {
      rows: rows.length,
      emitted: leads.length,
      withPhone: leads.filter((lead) => (lead.phones ?? []).length > 0).length,
      skipped,
    },
  };
}

function inScope(row: DealerRow, options: ParseOptions): boolean {
  const wanted = options.municipalities ?? [];
  const resolve = options.resolveMunicipality;
  if (wanted.length === 0 || resolve === undefined) return true;

  const city = row.address?.city;
  if (city === null || city === undefined) return true;
  const match = resolve(city);
  // Unresolvable stays in: a filter is not a place to lose a lead.
  if (match === undefined) return true;
  return wanted.some((municipality) => municipality.id === match.id);
}

/**
 * One row → one raw record.
 *
 * Note what is not done. The phone keeps its `(0)` and its spacing, the city
 * keeps its diacritics, the six-digit postal code keeps its typo, and the
 * name is passed through in the page's own upper case. `src/lib` owns every one
 * of those decisions, and an adapter that pre-cleans a value is re-implementing
 * a rule that already exists and will disagree with it.
 */
function toRawLead(row: DealerRow, pageUrl: string): RawLeadInput {
  const mapsUrl = mapsUrlFor(row.latitude, row.longitude);
  return {
    sourceUrl: pageUrl,
    name: row.name,
    phones: [...row.phones],
    city: row.address?.city ?? null,
    address: row.address?.address ?? null,
    postalCode: row.address?.postalCode ?? null,
    latitude: row.latitude,
    longitude: row.longitude,
    socials: mapsUrl === null ? [] : [mapsUrl],
    // Not a claim about this business's trade, but about the list it is on:
    // an Austrotherm distributor is a yard that already stocks and resells EPS
    // facade insulation. That is the signal `src/lib/classify` should see.
    categories: ['Austrotherm distributer', 'EPS / stiropor', 'građevinski materijal'],
    // The row's own text, not the page's: the manufacturer's head-office number
    // in the footer is not this dealer's number.
    text: [row.name, row.addressLine, row.details].filter((part) => part !== '').join('\n'),
    links: [],
    extra: {
      dealerIndex: row.index,
      country: 'RS',
      detailsLine: row.details,
      addressLine: row.addressLine,
      // Recorded because the URL above is derived, not published — the page
      // gives coordinates and this is where they came from.
      ...(mapsUrl === null ? {} : { googleMapsUrlDerivedFrom: 'data-latitude/data-longitude' }),
    },
  };
}
