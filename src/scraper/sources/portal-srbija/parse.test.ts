/**
 * `portal-srbija` — the fixture test.
 *
 * Every fixture is a real page saved from www.portal-srbija.com on 2026-08-20,
 * byte for byte, malformed markup included. No network, no database: the diff
 * of a fixture is exactly what changed on the source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { StructureChangedError } from '../../errors.js';
import { expectFound } from '../../types.js';
import {
  citySlugOf,
  parseDetail,
  parseListing,
  type DetailLocation,
  type Expect,
} from './parse.js';

const BASE = 'https://www.portal-srbija.com';

function fixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );
}

const assert: Expect = (value, selector, url, expected) =>
  expectFound('portal-srbija', value, selector, url, expected);

const NATIONAL = `${BASE}/radovi-na-visini`;
const CITY = `${BASE}/termo-izolacija-zvucna-izolacija-novi-sad`;

describe('citySlugOf', () => {
  it('strips the category prefix, and rejects the category root', () => {
    expect(citySlugOf('radovi-na-visini-novi-sad', 'radovi-na-visini')).toBe('novi-sad');
    expect(
      citySlugOf('radovi-na-visini-rakovica-miljakovac-kanarevo-brdo-resnik', 'radovi-na-visini'),
    ).toBe('rakovica-miljakovac-kanarevo-brdo-resnik');
    expect(citySlugOf('radovi-na-visini', 'radovi-na-visini')).toBeNull();
    expect(citySlugOf('hidroizolacija-nis', 'radovi-na-visini')).toBeNull();
  });
});

describe('parseListing — national category page', () => {
  const page = (): ReturnType<typeof parseListing> =>
    parseListing(fixture('listing-national-radovi-na-visini.html'), NATIONAL, assert, {
      categorySlug: 'radovi-na-visini',
      requireItems: true,
    });

  it('reads every company block, raw', () => {
    const listing = page();
    expect(listing.heading).toBe('Radovi na visini');
    expect(listing.items).toHaveLength(6);

    expect(listing.items[0]).toEqual({
      url: `${BASE}/visinski-radovi-beograd-vertical-system`,
      name: 'Visinski radovi Beograd - Vertical System',
      city: 'Beograd',
      address: 'Banovo Brdo',
      // Exactly as printed. `+381…` is `src/lib/phone`'s business.
      phones: ['063 645131'],
      description: expect.stringContaining('DEMIT FASADE') as unknown as string,
    });

    // Two numbers on one block, both kept, in page order.
    expect(listing.items[1]?.phones).toEqual(['011 3048515', '011 3048516']);
    // Every block on this page carries at least one phone — the reason this
    // source was ranked first.
    expect(listing.items.filter((item) => item.phones.length > 0)).toHaveLength(6);
  });

  it('reads the city pages the source says exist', () => {
    const listing = page();
    // The source's own `dl.dl_nei` list, not slugs composed from the geo
    // dataset — composing them is what produced FUZZ-8's deterministic 500s.
    expect(listing.locations.map((location) => location.citySlug)).toEqual([
      'novi-beograd',
      'rakovica-miljakovac-kanarevo-brdo-resnik',
      'savski-venac',
      'banovo-brdo',
      'kac',
      'novi-sad',
      'kraljevo',
    ]);
    expect(listing.locations[0]).toEqual({
      slug: 'radovi-na-visini-novi-beograd',
      citySlug: 'novi-beograd',
      label: 'Radovi na visini Novi Beograd',
      url: `${BASE}/radovi-na-visini-novi-beograd`,
    });
  });

  it('raises StructureChangedError when the company blocks are renamed', () => {
    // `listing-redesigned.html` is the same healthy 200, full of companies,
    // with `div.general` renamed. A parser that returned `[]` here would report
    // a successful run with zero leads — the silent failure this error exists
    // to prevent.
    const call = (): unknown =>
      parseListing(fixture('listing-redesigned.html'), NATIONAL, assert, {
        categorySlug: 'radovi-na-visini',
        requireItems: true,
      });
    expect(call).toThrow(StructureChangedError);

    try {
      call();
    } catch (error) {
      const detail = (error as StructureChangedError).detail;
      expect(detail.sourceId).toBe('portal-srbija');
      expect(detail.selector).toBe('div.general');
      expect(detail.url).toBe(NATIONAL);
    }
  });

  it('raises when the page is not a category page at all', () => {
    // A detail page has the heading but no location taxonomy — the marker that
    // makes a page a category listing.
    expect(() =>
      parseListing(fixture('detail-termodom.html'), NATIONAL, assert, {
        categorySlug: 'radovi-na-visini',
        requireItems: false,
      }),
    ).toThrow(StructureChangedError);
  });
});

describe('parseListing — city page', () => {
  const page = (): ReturnType<typeof parseListing> =>
    parseListing(fixture('listing-city-termo-izolacija-novi-sad.html'), CITY, assert, {
      categorySlug: 'termo-izolacija-zvucna-izolacija',
      requireItems: false,
    });

  it('reads the companies only this city page has', () => {
    const listing = page();
    expect(listing.heading).toBe('Termo izolacija, zvučna izolacija Novi Sad');
    expect(listing.items).toHaveLength(12);
    expect(listing.items.map((item) => item.name)).toContain('Izomonter');
    expect(listing.items.every((item) => item.city === 'Novi Sad')).toBe(true);
    // The separator comma the template prints after the city is not part of it.
    expect(listing.items[0]?.city).toBe('Novi Sad');
  });

  it('carries the whole category taxonomy, not just this city', () => {
    // A city page links every sibling city too, so discovery could seed from
    // any page of a category. It seeds from the national one for determinism.
    expect(page().locations.length).toBe(78);
  });

  it('does not raise on a city page with no companies', () => {
    // A filtered view returning nothing is a legitimate answer. Proven here
    // with the redesigned markup, which is the strongest form of "no blocks
    // matched": `requireItems: false` returns an empty page instead of raising.
    const listing = parseListing(fixture('listing-redesigned.html'), CITY, assert, {
      categorySlug: 'radovi-na-visini',
      requireItems: false,
    });
    expect(listing.items).toEqual([]);
  });
});

describe('parseDetail', () => {
  const hints = {
    listingUrl: CITY,
    categorySlug: 'termo-izolacija-zvucna-izolacija',
    categoryName: 'Termo izolacija, zvučna izolacija',
    citySlug: 'novi-sad',
  };

  it('adds the email the listing page never has', () => {
    const url = `${BASE}/bartolomeo-blok`;
    const record = parseDetail(fixture('detail-bartolomeo-blok.html'), url, assert, {
      ...hints,
      listing: { name: 'Bartolomeo blok', city: 'Novi Sad', phones: ['021 553484'] },
    });

    expect(record.name).toBe('Bartolomeo blok');
    expect(record.sourceUrl).toBe(url);
    // Portal Srbija publishes no email on any listing page. This one exists
    // only because the detail page was fetched.
    expect(record.emails).toEqual(['bartolomeoblok@neobee.net']);
    // Both printings of the same number, raw. `src/lib/phone` collapses them.
    expect(record.phones).toEqual([
      '021 553484',
      '064 4577747',
      '+381 21 553484',
      '+381 64 4577747',
    ]);
    expect(record.city).toBe('Novi Sad');
    expect(record.address).toBe('Jaše Ignjatovića 2');
    // The crawl category first, then the company's own "Povezane kategorije".
    expect(record.categories).toEqual([
      'Termo izolacija, zvučna izolacija',
      'Kamen, granit, mermer',
      'Završni radovi, restauracije',
    ]);
    expect(record.extra).toMatchObject({
      categorySlug: 'termo-izolacija-zvucna-izolacija',
      citySlug: 'novi-sad',
      listingUrl: CITY,
    });
  });

  it('reads a labelled website and every branch of a chain', () => {
    const record = parseDetail(fixture('detail-termodom.html'), `${BASE}/termodom`, assert, hints);

    // `div.web_psn a.web_site_psn` is the one place this source names a link
    // as the company's own site.
    expect(record.website).toBe('http://www.termodom.rs');
    expect(record.emails).toEqual(['office@termodom.rs']);
    expect(record.city).toBe('Beograd Borča, Krnjača, Kotež');

    const locations = (record.extra as { locations?: DetailLocation[] }).locations ?? [];
    expect(locations).toHaveLength(13);
    expect(locations[3]).toEqual({
      city: 'Novi Sad',
      address: 'Novosadski put 10',
      phones: ['+381 21 824428'],
    });
    // One record per company, with every branch number on it — thirteen
    // branches in eleven area codes, all callable from one lead.
    expect(record.phones).toHaveLength(14);
    expect(record.phones).toContain('+381 18 4542790');
  });

  it('keeps a company that has neither email nor website', () => {
    const record = parseDetail(fixture('detail-izomonter.html'), `${BASE}/izomonter`, assert, {
      ...hints,
      listing: { name: 'Izomonter', city: 'Novi Sad', phones: ['021 6364211'] },
    });
    expect(record.emails).toEqual([]);
    expect(record.website).toBeNull();
    // A name, a city and a phone is a good lead.
    expect(record.name).toBe('Izomonter');
    expect(record.city).toBe('Novi Sad');
    expect(record.phones).toContain('021 6364211');
  });

  it('carries the block links, and only the block', () => {
    const record = parseDetail(fixture('detail-termodom.html'), `${BASE}/termodom`, assert, hints);
    const hrefs = (record.links ?? []).map((link) => link.href);

    expect(hrefs).toContain('mailto:office@termodom.rs');
    expect(hrefs).toContain('http://www.termodom.rs');
    expect(hrefs).toContain('tel:0113470505');
    // The directory's own navigation and its advertisers sit outside
    // `div.prezentacija`, so neither reaches the lead.
    expect(hrefs).not.toContain(`${BASE}/blog`);
    expect(hrefs.some((href) => href.includes('/kontakt'))).toBe(false);
  });

  it('raises StructureChangedError when the presentation block is gone', () => {
    expect(() =>
      parseDetail(fixture('listing-city-termo-izolacija-novi-sad.html'), `${BASE}/x`, assert),
    ).toThrow(StructureChangedError);
  });
});
