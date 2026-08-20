/**
 * The example adapter's fixture test — the shape every source ships.
 *
 * Saved HTML in, an expected record set out, no network and no database. This
 * is what makes a parser reviewable: the diff of a fixture is exactly what
 * changed on the source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { StructureChangedError } from '../../errors.js';
import { expectFound } from '../../types.js';
import { parseDetail, parseListing, type Expect } from './parse.js';

const BASE = 'http://127.0.0.1:8787';

function fixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );
}

const assert: Expect = (value, selector, url, expected) =>
  expectFound('example', value, selector, url, expected);

describe('parseListing', () => {
  it('reads every card and the next-page link', () => {
    const page = parseListing(fixture('listing-1.html'), `${BASE}/firme/fasaderi`, assert);

    expect(page.items).toEqual([
      {
        url: `${BASE}/firme/termo-fasade-novi-sad`,
        name: 'Termo Fasade Novi Sad d.o.o.',
        city: 'Novi Sad',
        phone: '021/456-789',
      },
      {
        url: `${BASE}/firme/fasaderski-radovi-markovic`,
        name: 'Fasaderski radovi Marković PR',
        city: 'Čačak',
        phone: '063/478-115',
      },
      {
        url: `${BASE}/firme/stovariste-gradnja-plus`,
        name: 'Stovarište Gradnja Plus',
        city: 'Kragujevac',
        phone: '034 335 100',
      },
    ]);
    expect(page.nextUrl).toBe(`${BASE}/firme/fasaderi?strana=2`);
  });

  it('reports no next page on the last one', () => {
    const page = parseListing(fixture('listing-2.html'), `${BASE}/firme/fasaderi?strana=2`, assert);
    expect(page.items).toHaveLength(3);
    expect(page.nextUrl).toBeNull();
  });

  it('raises StructureChangedError when the source redesigns the listing', () => {
    // `listing-redesigned.html` is a healthy 200 full of companies. A parser
    // that returned `[]` here would report a successful run with zero leads —
    // the silent failure this error exists to prevent.
    expect(() =>
      parseListing(fixture('listing-redesigned.html'), `${BASE}/firme/fasaderi`, assert),
    ).toThrow(StructureChangedError);

    try {
      parseListing(fixture('listing-redesigned.html'), `${BASE}/firme/fasaderi`, assert);
    } catch (error) {
      const detail = (error as StructureChangedError).detail;
      expect(detail.sourceId).toBe('example');
      expect(detail.selector).toBe('ul.lista-firmi li.firma-kartica');
      expect(detail.url).toBe(`${BASE}/firme/fasaderi`);
    }
  });
});

describe('parseDetail', () => {
  it('emits raw strings, not normalized ones', () => {
    const url = `${BASE}/firme/termo-fasade-novi-sad`;
    const record = parseDetail(fixture('detalj-termo-fasade-novi-sad.html'), url, assert);

    expect(record.name).toBe('Termo Fasade Novi Sad d.o.o.');
    expect(record.sourceUrl).toBe(url);
    // Exactly as the source printed them — canonicalization is `src/lib`'s job.
    expect(record.phones).toEqual(['021/456-789', '064 123 4567']);
    expect(record.website).toBe('http://www.termofasade.rs');
    expect(record.city).toBe('Novi Sad');
    expect(record.address).toBe('Bulevar oslobođenja 112');
    expect(record.postalCode).toBe('21000');
    expect(record.taxId).toBe('101234567');
    expect(record.registrationNumber).toBe('20345678');
    expect(record.categories).toEqual(['Fasaderski radovi', 'demit fasada', 'termoizolacija']);
    expect(record.openingHours).toBe('pon–pet 08–16h');
  });

  it('carries the block links, and only the block', () => {
    const url = `${BASE}/firme/termo-fasade-novi-sad`;
    const record = parseDetail(fixture('detalj-termo-fasade-novi-sad.html'), url, assert);
    const hrefs = (record.links ?? []).map((link) => link.href);

    expect(hrefs).toContain('mailto:info@termofasade.rs');
    expect(hrefs).toContain('https://www.facebook.com/termofasadens');
    // The directory's own footer link is outside `article.firma-detalj`.
    expect(hrefs).not.toContain(`${BASE}/kontakt`);
    expect(record.text).not.toContain('011/111-222');
  });

  it('keeps a listing with no phone at all', () => {
    // A lead with a name, a city and an email is still a lead. Never dropped.
    const record = parseDetail(
      fixture('detalj-izolacija-majstor-uzice.html'),
      `${BASE}/firme/izolacija-majstor-uzice`,
      assert,
    );
    expect(record.phones).toEqual([]);
    expect(record.name).toBe('Izolacija Majstor Užice');
    expect(record.city).toBe('Užice');
  });

  it('falls back to the listing hint when the detail page omits the phone', () => {
    const record = parseDetail(
      fixture('detalj-izolacija-majstor-uzice.html'),
      `${BASE}/firme/izolacija-majstor-uzice`,
      assert,
      { phone: '031/512-345', city: 'Užice' },
    );
    expect(record.phones).toEqual(['031/512-345']);
  });

  it('raises StructureChangedError when the company block is gone', () => {
    expect(() => parseDetail(fixture('listing-1.html'), `${BASE}/firme/x`, assert)).toThrow(
      StructureChangedError,
    );
  });
});
