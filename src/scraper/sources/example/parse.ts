/**
 * `example` — parsing. Pure functions of the response body.
 *
 * Nothing here fetches, and nothing here normalizes. That is the whole reason
 * this file is separate from `index.ts`: parsing is what breaks when a source
 * redesigns its markup, so it has to be testable against a saved snapshot,
 * without a network and without a database.
 *
 * Copy this file when you write a real adapter. The three habits worth copying:
 *
 * 1. **Assert what the source guarantees.** The listing container and the name
 *    on a detail page are asserted with `expect(...)`; a phone number is not,
 *    because plenty of real listings simply have none. Getting that line right
 *    is what makes `StructureChangedError` mean something.
 * 2. **Emit raw strings.** `064/123-4567`, `Beograd — Voždovac`,
 *    `www.termofasade.rs`. The pipeline canonicalizes; an adapter that pre-cleans
 *    a value is re-implementing `src/lib` and will disagree with it.
 * 3. **Carry the block's text and links.** They are what lets the shared
 *    extractors find the obfuscated email and the Facebook page nobody thought
 *    to model as a field.
 */
import type { CheerioAPI } from 'cheerio';
import type { RawLeadInput, ScrapedLink } from '../../types.js';

/** `expect` from `CrawlContext`, narrowed to what a parser needs. */
export type Expect = <T>(
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string,
) => T;

export interface ListingItem {
  /** Absolute URL of the detail page. */
  readonly url: string;
  /** What the listing already knew — passed through so `extract` need not re-read it. */
  readonly name: string;
  readonly city: string | null;
  readonly phone: string | null;
}

export interface ListingPage {
  readonly items: readonly ListingItem[];
  /** Absolute URL of the next page, or `null` on the last one. */
  readonly nextUrl: string | null;
}

function textOf(scope: ReturnType<CheerioAPI>, selector: string): string | null {
  const value = scope.find(selector).first().text().trim();
  return value === '' ? null : value;
}

/**
 * One listing page → the items on it, plus where the next page is.
 *
 * The container assertion is the important line. A redesign that renames
 * `li.firma-kartica` leaves a page that is still a 200 full of companies, and a
 * parser without this line would report a healthy run that found nothing.
 */
export function parseListing($: CheerioAPI, pageUrl: string, expect: Expect): ListingPage {
  const cards = $('ul.lista-firmi li.firma-kartica').toArray();
  expect(cards, 'ul.lista-firmi li.firma-kartica', pageUrl, 'one or more company cards');

  const items: ListingItem[] = [];
  for (const element of cards) {
    const card = $(element);
    const href = card.find('h2.firma-naziv a').attr('href');
    const name = card.find('h2.firma-naziv a').text().trim();
    // A card without a link is a card we cannot follow; the container assertion
    // already proved the page is intact, so this one is skipped, not fatal.
    if (href === undefined || name === '') continue;
    items.push({
      url: new URL(href, pageUrl).toString(),
      name,
      city: textOf(card, 'p.firma-mesto'),
      phone: textOf(card, 'p.firma-telefon'),
    });
  }

  const next = $('nav.paginacija a.sledeca').attr('href');
  return {
    items,
    nextUrl: next === undefined ? null : new URL(next, pageUrl).toString(),
  };
}

/** Every anchor inside the record block, for the shared contact extractors. */
function linksIn($: CheerioAPI, scope: ReturnType<CheerioAPI>, pageUrl: string): ScrapedLink[] {
  return scope
    .find('a[href]')
    .toArray()
    .map((element) => {
      const href = $(element).attr('href') ?? '';
      const text = $(element).text().trim();
      // Relative hrefs are resolved; `mailto:` and `tel:` are left alone.
      const absolute =
        /^(https?:)?\/\//i.test(href) || href.startsWith('/')
          ? new URL(href, pageUrl).toString()
          : href;
      return { href: absolute, ...(text === '' ? {} : { text }) };
    });
}

/**
 * One detail page → one raw record.
 *
 * Note what is *not* done: the two phone fields are handed over as the source
 * printed them, the city keeps its em dash, the website keeps its `www.` and
 * its `http://`. Every one of those is a `src/lib` decision.
 */
export function parseDetail(
  $: CheerioAPI,
  pageUrl: string,
  expect: Expect,
  hints: Partial<ListingItem> = {},
): RawLeadInput {
  const article = $('article.firma-detalj').first();
  expect(
    article.length === 0 ? null : article,
    'article.firma-detalj',
    pageUrl,
    'the company block',
  );

  const name = article.find('h1.firma-naziv').first().text().trim();
  expect(name, 'h1.firma-naziv', pageUrl, 'the company name');

  const phones = article
    .find('dd.telefon')
    .toArray()
    .map((element) => $(element).text().trim())
    .filter((value) => value !== '');
  if (phones.length === 0 && hints.phone != null) phones.push(hints.phone);

  const categories = (textOf(article, 'p.firma-delatnost') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const website = article.find('dd.sajt a').attr('href') ?? textOf(article, 'dd.sajt');
  const emails = article
    .find('dd.email')
    .toArray()
    .map((element) => $(element).text().trim())
    .filter((value) => value !== '');

  return {
    sourceUrl: pageUrl,
    name,
    phones,
    emails,
    website,
    city: textOf(article, 'dd.grad') ?? hints.city ?? null,
    address: textOf(article, 'dd.adresa'),
    postalCode: textOf(article, 'dd.postanski-broj'),
    taxId: textOf(article, 'dd.pib'),
    registrationNumber: textOf(article, 'dd.maticni-broj'),
    openingHours: textOf(article, 'dd.radno-vreme'),
    description: textOf(article, 'div.firma-opis'),
    categories,
    // The block's text and links, not the whole page: the site's own footer
    // phone number is not this company's phone number.
    text: article.text(),
    links: linksIn($, article, pageUrl),
  };
}
