/**
 * `austrotherm-distributeri` — the fixture test.
 *
 * `__fixtures__/distributeri.html` is the real page, saved byte-for-byte on
 * 2026-08-20. Everything here runs against it: no network, no database, and the
 * headline numbers this source is worth (292 Serbian rows, 290 with a phone)
 * are asserted rather than described, so the day they change the test says so.
 *
 * The three failure fixtures matter as much as the happy path. Each is a
 * healthy 200 full of dealers that this parser must refuse to read as "no
 * dealers here".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { StructureChangedError } from '../../errors.js';
import { expectFound } from '../../types.js';
import { rawLeadSchema } from '../../raw-lead.js';
import {
  countryOf,
  mapsUrlFor,
  parseAddressLine,
  parseDealerList,
  type Expect,
  type ScopeMunicipality,
} from './parse.js';

const URL_ = 'https://www.austrotherm.rs/distributeri';

function fixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );
}

const assert: Expect = (value, selector, url, expected) =>
  expectFound('austrotherm-distributeri', value, selector, url, expected);

const page = (): cheerio.CheerioAPI => fixture('distributeri.html');

describe('parseDealerList — the saved page', () => {
  it('reads every Serbian dealer and accounts for every row it did not', () => {
    const { leads, stats } = parseDealerList(page(), URL_, assert);

    expect(stats).toEqual({
      rows: 325,
      emitted: 292,
      withPhone: 290,
      skipped: {
        // The map widget's two empty prototypes.
        template: 2,
        // The `Distributeri CRNA GORA` rule-of-dashes row.
        separator: 1,
        // +382 numbers, interleaved through the list rather than grouped.
        foreign: 30,
        'unknown-country': 0,
        'out-of-scope': 0,
      },
    });
    expect(leads).toHaveLength(292);
  });

  it('emits the first dealer exactly as the page publishes it', () => {
    const { leads } = parseDealerList(page(), URL_, assert);

    expect(leads[0]).toEqual({
      sourceUrl: URL_,
      name: '21 MAJ',
      // Raw: the `(0)` and the spacing are `src/lib/phone`'s to remove.
      phones: ['+381 (0)18 469 40 13'],
      city: 'Niš',
      address: 'Mramorsko brdo bb',
      postalCode: '18000',
      latitude: 43.305177,
      longitude: 21.775493,
      socials: ['https://maps.google.com/?q=43.305177,21.775493'],
      categories: ['Austrotherm distributer', 'EPS / stiropor', 'građevinski materijal'],
      text: '21 MAJ\nMramorsko brdo bb, 18000 Niš\nT +381 (0)18 469 40 13',
      links: [],
      extra: {
        dealerIndex: 2,
        country: 'RS',
        detailsLine: 'T +381 (0)18 469 40 13',
        addressLine: 'Mramorsko brdo bb, 18000 Niš',
        googleMapsUrlDerivedFrom: 'data-latitude/data-longitude',
      },
    });
  });

  it('every record passes the zod boundary', () => {
    const { leads } = parseDealerList(page(), URL_, assert);
    for (const lead of leads) {
      const parsed = rawLeadSchema.safeParse({ sourceId: 'austrotherm-distributeri', ...lead });
      expect(parsed.success, `${lead.name}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('carries coordinates and a Google Maps link on all but one record', () => {
    const { leads } = parseDealerList(page(), URL_, assert);
    const located = leads.filter((lead) => lead.latitude != null && lead.longitude != null);

    expect(located).toHaveLength(291);
    for (const lead of located) {
      expect(lead.socials).toEqual([
        `https://maps.google.com/?q=${lead.latitude},${lead.longitude}`,
      ]);
    }

    // `src/lib/contact` is what turns that link into a `google_maps` contact,
    // and it canonicalizes it back to `?api=1&query=lat,lon` — the shape the
    // store sheet reads. This side only publishes the coordinates.

    // One row was published at 0,0 — Null Island, not Zrenjanin. An unplaced
    // dealer gets no coordinates and no link rather than a link to the ocean.
    const unplaced = leads.filter((lead) => lead.latitude == null);
    expect(unplaced.map((lead) => lead.name)).toEqual(['OGREV']);
    expect(unplaced[0]?.socials).toEqual([]);
    expect(unplaced[0]?.extra).not.toHaveProperty('googleMapsUrlDerivedFrom');
  });

  it('keeps the two Serbian rows whose phone field is unusable, without a phone', () => {
    const { leads } = parseDealerList(page(), URL_, assert);
    const phoneless = leads.filter((lead) => (lead.phones ?? []).length === 0);

    // `T Kršumlija` is a malformed phone field, not a phone. The row is still a
    // named yard at a known address, so it is emitted — with no number rather
    // than with a coerced one.
    expect(phoneless.map((lead) => lead.name).sort()).toEqual(['AGROPROM', 'KARLA']);
    expect(phoneless.find((lead) => lead.name === 'AGROPROM')?.text).toContain('T Kršumlija');
  });

  it('reads the phone but not the fax off a row that prints both', () => {
    const { leads } = parseDealerList(page(), URL_, assert);
    const dekor = leads.find((lead) => lead.name === 'DEKOR LUX');

    expect(dekor?.phones).toEqual(['+381 (0)14 414 847']);
    // The whole line still travels, so `src/lib` can read what this did not.
    expect(dekor?.text).toContain('F +381 (0)63 106 20 39');
  });

  it('drops Montenegro on the calling code, not on the section heading', () => {
    const { leads } = parseDealerList(page(), URL_, assert);

    expect(leads.some((lead) => lead.name === 'Distributeri CRNA GORA')).toBe(false);
    for (const lead of leads) {
      for (const phone of lead.phones ?? []) expect(phone.startsWith('+381')).toBe(true);
    }
    // The heading sits at row 69 of 325 and 229 Serbian rows follow it — which
    // is exactly why it is not the boundary.
    const indexes = leads.map((lead) => Number(lead.extra?.dealerIndex));
    expect(indexes.filter((index) => index > 69)).toHaveLength(229);
    expect(indexes.filter((index) => index < 69)).toHaveLength(63);
  });

  it('reads the rows whose address line does not follow the house shape', () => {
    const { leads } = parseDealerList(page(), URL_, assert);
    const byName = (name: string): (typeof leads)[number] | undefined =>
      leads.find((lead) => lead.name === name);

    expect(byName('TEHNO PAN')).toMatchObject({
      address: null,
      postalCode: '11300',
      city: 'Smederevo Smederevo',
    });
    expect(byName('ANĐELKOVIĆ AL')).toMatchObject({
      address: 'Babin Lug 5e',
      postalCode: null,
      city: 'Babin Lug 5e Vinča',
    });
    // A six-digit typo for 11430, preserved rather than corrected.
    expect(byName('NOVA ŠUMADIJA')).toMatchObject({
      postalCode: '114306',
      city: 'Beograd - Grocka',
    });
  });
});

describe('parseDealerList — --city scope', () => {
  const nis: ScopeMunicipality = { id: 'nis' };
  const resolveMunicipality = (name: string): ScopeMunicipality | undefined =>
    name.replace(/š/gi, 's').toLowerCase().trim() === 'nis' ? nis : { id: `other:${name}` };

  it('keeps only the requested municipality', () => {
    const { leads, stats } = parseDealerList(page(), URL_, assert, {
      municipalities: [nis],
      resolveMunicipality,
    });

    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((lead) => lead.city === 'Niš')).toBe(true);
    expect(stats.emitted + stats.skipped['out-of-scope']).toBe(292);
  });

  it('keeps a row whose city does not resolve, rather than losing the lead', () => {
    const { leads } = parseDealerList(page(), URL_, assert, {
      municipalities: [nis],
      resolveMunicipality: (name) => (name === 'Niš' ? nis : undefined),
    });

    expect(leads.some((lead) => lead.city !== 'Niš')).toBe(true);
  });

  it('filters nothing when no city was asked for', () => {
    const { stats } = parseDealerList(page(), URL_, assert, {
      municipalities: [],
      resolveMunicipality,
    });

    expect(stats.emitted).toBe(292);
  });
});

describe('parseDealerList — the source changing under us', () => {
  it('raises when the dealer list is rebuilt with different markup', () => {
    expect(() => parseDealerList(fixture('distributeri-redesigned.html'), URL_, assert)).toThrow(
      StructureChangedError,
    );
  });

  it('raises when only the map widget templates are left', () => {
    expect(() => parseDealerList(fixture('distributeri-template-only.html'), URL_, assert)).toThrow(
      StructureChangedError,
    );
  });

  it('raises when the numbers move behind tel: links and the text empties out', () => {
    // The NaVidiku trap: the markup still matches, the rows still have names,
    // and a parser without the phone-coverage assertion would report three
    // healthy phoneless leads instead of a broken source.
    expect(() =>
      parseDealerList(fixture('distributeri-phones-behind-links.html'), URL_, assert),
    ).toThrow(StructureChangedError);
  });

  it('names the page and the selector so the fix starts from a fact', () => {
    try {
      parseDealerList(fixture('distributeri-redesigned.html'), URL_, assert);
      expect.unreachable('expected a StructureChangedError');
    } catch (error) {
      expect(error).toBeInstanceOf(StructureChangedError);
      const detail = (error as StructureChangedError).detail;
      expect(detail.sourceId).toBe('austrotherm-distributeri');
      expect(detail.url).toBe(URL_);
      expect(detail.selector).toBe('#dealers-list div.dealer');
    }
  });
});

describe('parseAddressLine', () => {
  it.each([
    [
      'Mramorsko brdo bb, 18000 Niš',
      { address: 'Mramorsko brdo bb', postalCode: '18000', city: 'Niš' },
    ],
    [
      'Ćirila i Metodija br. 7, 18320 Dimitrovgrad',
      { address: 'Ćirila i Metodija br. 7', postalCode: '18320', city: 'Dimitrovgrad' },
    ],
    [
      'Cijevna bb (Petrovačka magistrala), 81000 Podgorica, Golubovci',
      {
        address: 'Cijevna bb (Petrovačka magistrala)',
        postalCode: '81000',
        city: 'Podgorica, Golubovci',
      },
    ],
    [
      '11300, Smederevo Smederevo',
      { address: null, postalCode: '11300', city: 'Smederevo Smederevo' },
    ],
    [
      'Babin Lug 5e, Babin Lug 5e Vinča',
      { address: 'Babin Lug 5e', postalCode: null, city: 'Babin Lug 5e Vinča' },
    ],
    [
      'Smederevski put 22 b, 114306 Beograd - Grocka',
      { address: 'Smederevski put 22 b', postalCode: '114306', city: 'Beograd - Grocka' },
    ],
    ['Kneza Miloša bb', { address: 'Kneza Miloša bb', postalCode: null, city: null }],
  ])('reads %s', (line, expected) => {
    expect(parseAddressLine(line)).toEqual(expected);
  });

  it('reports the separator row and the empty template as not an address', () => {
    expect(parseAddressLine('------------------------------------,')).toBeNull();
    expect(parseAddressLine(',  ')).toBeNull();
  });
});

describe('countryOf', () => {
  it('trusts the calling code over everything else', () => {
    expect(countryOf(['+381 (0)18 469 40 13'], '81000')).toBe('RS');
    expect(countryOf(['+382 20 123 456'], '18000')).toBe('ME');
  });

  it('falls back to the postal code when there is no phone', () => {
    expect(countryOf([], '18430')).toBe('RS');
    expect(countryOf([], '84325')).toBe('ME');
  });

  it('admits it does not know rather than guessing Serbia', () => {
    expect(countryOf([], null)).toBeNull();
    expect(countryOf([], '114306')).toBeNull();
    expect(countryOf([], '99999')).toBeNull();
  });
});

describe('mapsUrlFor', () => {
  it('builds a link from a coordinate pair', () => {
    expect(mapsUrlFor(43.305177, 21.775493)).toBe('https://maps.google.com/?q=43.305177,21.775493');
  });

  it('has nothing to build from without both coordinates', () => {
    expect(mapsUrlFor(null, 21.775493)).toBeNull();
    expect(mapsUrlFor(43.305177, null)).toBeNull();
  });
});
