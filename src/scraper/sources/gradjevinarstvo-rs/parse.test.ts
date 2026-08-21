/**
 * `gradjevinarstvo-rs` — the fixture test.
 *
 * Every fixture is a real page saved from www.gradjevinarstvo.rs on 2026-08-20,
 * byte for byte. No network, no database: the diff of a fixture is exactly what
 * changed on the source.
 *
 * The four pages were chosen because they are the four shapes the register
 * actually prints:
 *
 * | Fixture              | What it proves                                          |
 * | -------------------- | ------------------------------------------------------- |
 * | `popovic`            | multi-phone run, fax, contact person, no website, and a facade contractor identifiable *only* from a category note |
 * | `rolomatik`          | the presented layout — sidebar categories, a description, a website, and a phone that carries a city suffix |
 * | `izo-pro-team`       | the small-firm shape: one mobile, a person, a website     |
 * | `skupstina-opstine`  | a Bosnian entry with `+387` numbers — the Serbia-only filter's input |
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { StructureChangedError } from '../../errors.js';
import { expectFound } from '../../types.js';
import { parseFirm, parsePlace, toRawLead, type Expect } from './parse.js';

const BASE = 'https://www.gradjevinarstvo.rs';

function fixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );
}

const assert: Expect = (value, selector, url, expected) =>
  expectFound('gradjevinarstvo-rs', value, selector, url, expected);

describe('parsePlace', () => {
  it('splits postal code, place and country', () => {
    expect(parsePlace('34000 KRAGUJEVAC, SRB')).toEqual({
      postalCode: '34000',
      city: 'KRAGUJEVAC',
      country: 'SRB',
    });
  });

  it('keeps a hyphenated place intact', () => {
    expect(parsePlace('14104 VALJEVO-BELOŠEVAC, SRB')).toEqual({
      postalCode: '14104',
      city: 'VALJEVO-BELOŠEVAC',
      country: 'SRB',
    });
  });

  it('reads the country that keeps a foreign entry out of a Serbian database', () => {
    expect(parsePlace('74470 VUKOSAVLJE, BIH').country).toBe('BIH');
  });

  it('survives a line with no postal code and no country', () => {
    expect(parsePlace('BEOGRAD')).toEqual({ postalCode: null, city: 'BEOGRAD', country: null });
    expect(parsePlace(null)).toEqual({ postalCode: null, city: null, country: null });
  });
});

describe('parseFirm — a plain company page', () => {
  const page = (): ReturnType<typeof parseFirm> =>
    parseFirm(fixture('firma-popovic.html'), `${BASE}/firme/5143/popovic`, assert);

  it('reads the contact card, raw', () => {
    const { name, contact } = page();
    expect(name).toBe('POPOVIĆ');
    expect(contact.city).toBe('KRAGUJEVAC');
    expect(contact.postalCode).toBe('34000');
    expect(contact.country).toBe('SRB');
    expect(contact.address).toBe('MILEVE RAIČEVIĆ 15');
    expect(contact.contactPerson).toBe('DRAGAN POPOVIĆ');
    expect(contact.website).toBeNull();
  });

  it('keeps every number in the phone run, not just the first', () => {
    // The second row's narrow cell is empty — it is a continuation, not a new
    // field. Reading the pairs independently would drop `064 6409 640`, which
    // is the only mobile this company publishes.
    expect(page().contact.phones).toEqual(['034 364 282', '064 6409 640']);
  });

  it('keeps the fax out of the phone list', () => {
    // Same digits as the landline here, and still not a number to call a
    // fasader on. `034 364 282` must not be counted twice.
    expect(page().contact.faxes).toEqual(['034 364 282']);
  });

  it('reads the categories the record owns and none from the site navigation', () => {
    const { categories } = page();
    expect(categories).toContain('Postavljanje toplotne izolacije');
    expect(categories).toContain('Malterisanje');
    // The header menu links `/kategorije/443/grejanje`; the record does not.
    expect(categories).not.toContain('GREJANJE');
    expect(categories).toHaveLength(19);
  });

  it('keeps the category note — the only sentence that says what this company is', () => {
    expect(page().categoryNotes).toContain(
      'Specijalizovana ekipa za izvođenje fasaderskih radova (izrada termoizolacionih fasada od stiropora po sistemu Demit)',
    );
  });
});

describe('parseFirm — the presented layout', () => {
  const page = (): ReturnType<typeof parseFirm> =>
    parseFirm(fixture('firma-rolomatik.html'), `${BASE}/firme/1222/rolomatik`, assert);

  it('reads four phones, a fax, a person and a website', () => {
    const { contact } = page();
    expect(contact.phones).toEqual([
      '031 3868 000',
      '031 3100 108',
      '031 3869 007',
      // As published. The trailing city is the source's annotation and
      // `src/lib/phone` is what decides the digits.
      '011 2641 564, BEOGRAD',
    ]);
    expect(contact.faxes).toEqual(['031 3869 407']);
    expect(contact.contactPerson).toBe('PREDRAG JOVANOVIĆ');
    expect(contact.website).toBe('https://www.rolomatik.com');
    expect(contact.displayName).toBe('ROLOMATIK');
  });

  it('finds the sidebar categories, which sit under a different heading', () => {
    // A presented page prints "KATEGORIJE" in a sidebar instead of the
    // "Kategorije za NAME" heading a plain page uses. One selector, both
    // layouts.
    const { categories } = page();
    expect(categories).toContain('MONTAŽNE ZGRADE, KUĆE');
    expect(categories.length).toBeGreaterThan(100);
  });

  it('reads the presentation paragraph past the nested <p> the template emits', () => {
    const description = page().description ?? '';
    expect(description).toContain('proizvodnju aluminijumskih rolo vrata');
    expect(description).toContain('fasadnih i krovnih termoizolacionih panela');
  });

  it('keeps the portal out of the record block', () => {
    // The page footer carries facebook.com/gradjevinarstvo and the publisher's
    // own accounts. `links` is scoped to the record, so none of them is here.
    const hrefs = page().links.map((link) => link.href);
    expect(hrefs).toContain('https://www.rolomatik.com');
    expect(hrefs.some((href) => href.includes('facebook.com/gradjevinarstvo'))).toBe(false);
  });
});

describe('parseFirm — the small-firm shape', () => {
  it('reads one mobile, a person and a website', () => {
    const { name, contact, categories } = parseFirm(
      fixture('firma-izo-pro-team.html'),
      `${BASE}/firme/19066/izo-pro-team`,
      assert,
    );
    expect(name).toBe('IZO PRO TEAM');
    expect(contact.phones).toEqual(['060 1158 629']);
    expect(contact.city).toBe('OBRENOVAC');
    expect(contact.contactPerson).toBe('ALEKSANDAR KRSTIĆ');
    expect(contact.website).toBe('https://www.izolacijapoliuretanima.rs');
    expect(categories).toContain('Termoizolacija zidova');
  });
});

describe('parseFirm — a foreign entry', () => {
  it('names the country, so the caller can keep it out', () => {
    const { name, contact } = parseFirm(
      fixture('firma-skupstina-opstine.html'),
      `${BASE}/firme/3370/skupstina-opstine`,
      assert,
    );
    expect(name).toBe('SKUPŠTINA OPŠTINE');
    expect(contact.country).toBe('BIH');
    expect(contact.city).toBe('VUKOSAVLJE');
    expect(contact.phones).toEqual(['+387 53 881129', '+387 53 882425', '+387 53 883513']);
  });
});

describe('parseFirm — a redesign', () => {
  it('raises instead of reporting a company with no name', () => {
    // The fixture is a real page with the heading class and the contact card
    // class renamed. A crawl that keeps going here reports a healthy run over
    // nameless records, which is the failure this project refuses to have.
    expect(() =>
      parseFirm(fixture('firma-redesigned.html'), `${BASE}/firme/19066/izo-pro-team`, assert),
    ).toThrow(StructureChangedError);
  });
});

describe('toRawLead', () => {
  const ref = { id: 5143, slug: 'popovic', url: `${BASE}/firme/5143/popovic` };
  const lead = (): ReturnType<typeof toRawLead> =>
    toRawLead(parseFirm(fixture('firma-popovic.html'), ref.url, assert), ref.url, ref);

  it('carries the exact page it was read at', () => {
    expect(lead().sourceUrl).toBe(`${BASE}/firme/5143/popovic`);
  });

  it('folds the category notes into the description the classifier reads', () => {
    expect(lead().description).toContain('fasaderskih radova');
  });

  it('keeps the fax and the firm id in `extra`, not in `phones`', () => {
    const record = lead();
    expect(record.phones).toEqual(['034 364 282', '064 6409 640']);
    expect(record.extra).toMatchObject({ firmId: 5143, slug: 'popovic', country: 'SRB' });
    expect((record.extra as { faxes?: string[] }).faxes).toEqual(['034 364 282']);
  });
});
