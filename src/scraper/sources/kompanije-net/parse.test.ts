/**
 * `kompanije-net` — the fixture test.
 *
 * Every `.html` here is a real page saved from www.kompanije.net on 2026-08-21,
 * byte for byte, its unclosed tags and stray whitespace included. No network,
 * no database: the diff of a fixture is exactly what changed on the source.
 *
 * Two of them are derived rather than saved, and both say so in their names:
 * `category-redesigned.html` and `detail-redesigned.html` are the real pages
 * with one thing broken, and they exist to prove the adapter raises instead of
 * reporting a healthy crawl of nothing. They are the only edited fixtures.
 *
 * The four traps FUZZ-41 named each have a test with a real page behind it:
 *
 * | Trap                                | Fixture                            |
 * | ----------------------------------- | ---------------------------------- |
 * | single-quoted `href='./slug/12345'` | `category-l70-malterisanje.html`   |
 * | label/value list                    | `detail-agmax-company.html`        |
 * | blank field falls to the next label | `detail-matis-nis-blank-pib.html`  |
 * | `Sajt:` followed by prose           | `detail-acalend-sajt-prose.html`   |
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { StructureChangedError } from '../../errors.js';
import { expectFound } from '../../types.js';
import { CATEGORIES, selectCategories, selectSurfaces, scopeKeyOf } from './categories.js';
import {
  LABELS,
  looksLikeWebsite,
  parseAddress,
  parseCompany,
  parseLegacyCategory,
  parseModernCategory,
  parsePlaceSentence,
  parseSectionIndex,
  placeString,
  splitPhones,
  toRawLead,
  type Expect,
} from './parse.js';

const BASE = 'https://www.kompanije.net';
const SECTION = `${BASE}/Srbija/d4_GRAĐEVINARSTVO.html`;
const CATEGORY = `${BASE}/Srbija/l70_Malterisanje.html`;
const LEGACY_INDEX = `${BASE}/preduzetnici/preduzetnici.php?delatnost=433100`;

function fixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );
}

const assert: Expect = (value, selector, url, expected) =>
  expectFound('kompanije-net', value, selector, url, expected);

const MALTERISANJE = CATEGORIES.find((category) => category.code === '43.31')!;
const IZGRADNJA_ZGRADA = CATEGORIES.find((category) => category.code === '41.20')!;

describe('parseSectionIndex', () => {
  it('resolves every activity code this adapter crawls to an absolute URL', () => {
    const byListId = parseSectionIndex(fixture('section-index-gradjevinarstvo.html'), SECTION);

    expect(byListId.size).toBe(22);
    expect(byListId.get('l70')).toBe(`${BASE}/Srbija/l70_Malterisanje.html`);
    expect(byListId.get('l69')).toBe(
      `${BASE}/Srbija/l69_Ostali-instalacioni-radovi-u-gra%C4%91evinarstvu.html`,
    );

    // Every code in the table is reachable, core and adjacent alike. This is
    // the assertion that fails first if the site renumbers its categories.
    for (const category of CATEGORIES) {
      expect(byListId.has(category.listId), `${category.listId} (${category.code})`).toBe(true);
    }
  });
});

describe('parseModernCategory', () => {
  it('reads all 900 single-quoted company links off one page — there is no pagination', () => {
    const entries = parseModernCategory(fixture('category-l70-malterisanje.html'), CATEGORY);

    // Trap 1. A double-quote-only href regex reads zero of these.
    expect(entries).toHaveLength(900);
    expect(entries[0]).toEqual({
      url: `${BASE}/Srbija/acalend/26011`,
      recordId: '26011',
      name: 'ACA LAZAREVIĆ PR, ZANATSKA RADNJA ACALEND STUBLINE',
    });
    expect(entries.at(-1)).toEqual({
      url: `${BASE}/Srbija/jovica-vuckovic-pr-zanatska-radnja-za-malterisanje-i-ostale-radove-beograd/381489`,
      recordId: '381489',
      name: 'JOVICA VUČKOVIĆ PR ZANATSKA RADNJA ZA MALTERISANJE I OSTALE RADOVE BEOGRAD',
    });
    expect(new Set(entries.map((entry) => entry.recordId)).size).toBe(900);
  });

  it('ignores the sibling-category links that share the same class', () => {
    const entries = parseModernCategory(fixture('section-index-gradjevinarstvo.html'), SECTION);
    // The section index is nothing but `l<id>_…html` links under `a.cat-list`.
    expect(entries).toHaveLength(0);
  });

  it('raises when the company links stop looking like company links', () => {
    const page = fixture('category-redesigned.html');
    const entries = parseModernCategory(page, CATEGORY);
    expect(entries).toHaveLength(0);
    expect(() => assert(entries, 'a.cat-list', CATEGORY, 'company links')).toThrow(
      StructureChangedError,
    );
  });
});

describe('parseLegacyCategory', () => {
  it('reads the sole-trader index, whose anchors carry no class at all', () => {
    const entries = parseLegacyCategory(fixture('category-legacy-433100.html'), LEGACY_INDEX);

    expect(entries).toHaveLength(852);
    expect(entries[0]?.recordId).toBe('125195');
    expect(entries[0]?.url).toBe(
      `${BASE}/preduzetnici/p125195_SAMOSTALNA-ZANATSKA-RADNJA-GRA%C4%90EVINSKE-STRUKE-PA%C4%8CIR-COOP-TOMISLAV-TAKA%C4%8C-PR-PA%C4%8CIR--ZEMLJORADNI%C4%8CKA-22.htm`,
    );
    // The footer's region links must not be mistaken for records.
    expect(entries.every((entry) => entry.url.includes('/preduzetnici/p'))).toBe(true);
  });
});

describe('parseCompany — the privredno društvo layout', () => {
  const page = (): ReturnType<typeof parseCompany> =>
    parseCompany(fixture('detail-agmax-company.html'), `${BASE}/Srbija/agmax/26017`, assert);

  it('reads every field of a fully populated record, raw', () => {
    const company = page();

    expect(company.name).toBe('AGMAX DOO BEOGRAD (ČUKARICA)');
    expect(company.legalForm).toBe('Društvo sa ograničenom odgovornošću');
    expect(company.status).toBe('Aktivno privredno društvo');
    expect(company.registrationNumber).toBe('20757949');
    expect(company.taxId).toBe('107217841');
    expect(company.activityCode).toBe('4331');
    expect(company.activityName).toBe('Malterisanje');
    // Raw, `.(0)`-free or not, trailing comma dropped. `+38111228820` is
    // `src/lib/phone`'s business and it has its own tests.
    expect(company.phones).toEqual(['+381 11 2288208']);
    expect(company.members).toEqual(['Željko Lazić ( 100 %)']);
  });

  it('splits the structured address into its own labelled parts', () => {
    const company = page();
    expect(company.address).toEqual({
      municipality: 'Beograd-Čukarica',
      place: 'Beograd-Čukarica',
      street: 'Šavnička 42',
      raw: 'Opština: Beograd-Čukarica | Mesto: Beograd-Čukarica | Ulica i broj: Šavnička 42',
    });
    expect(company.place).toBe('Beograd-Čukarica');
    expect(company.municipality).toBe('Beograd-Čukarica');
  });
});

describe('parseCompany — the preduzetnik layout', () => {
  it('reads a sole trader that prints neither Forma nor Status', () => {
    const company = parseCompany(
      fixture('detail-acalend-sajt-prose.html'),
      `${BASE}/Srbija/acalend/26011`,
      assert,
    );

    expect(company.name).toBe('ACA LAZAREVIĆ PR, ZANATSKA RADNJA ACALEND STUBLINE');
    expect(company.legalForm).toBeNull();
    expect(company.status).toBeNull();
    expect(company.contactPerson).toBe('Aca Lazarević');
    expect(company.phones).toEqual(['+381.(0)64.3637451']);
    expect(company.registrationNumber).toBe('61712135');
    expect(company.taxId).toBe('106114863');

    // The free-text address has no separator between street and place, so it is
    // kept whole and the place comes from the page's own sentence instead.
    expect(company.address?.street).toBe('Stubline 372 Stubline');
    expect(company.address?.municipality).toBeNull();
    expect(company.municipality).toBe('Obrenovac');
    expect(company.place).toBe('Stubline');
  });

  it('does not report a website from the prose that follows an empty `Sajt:`', () => {
    // Trap 4. The sentence after `Sajt:` is "Ova firma se bavi pretežno
    // delatnošču Malterisanje…", which a line-based parser reports as a URL —
    // 67% website coverage where the truth is near zero.
    const company = parseCompany(
      fixture('detail-acalend-sajt-prose.html'),
      `${BASE}/Srbija/acalend/26011`,
      assert,
    );
    expect(company.website).toBeNull();
    expect(company.websiteRaw).toBeNull();
    expect(company.text).toContain('Ova firma se bavi pretežno delatnošču Malterisanje');
    expect(company.labels).toContain(LABELS.website);
  });

  it('keeps the page advertising out of the record text', () => {
    // `cheerio.text()` walks into `<script>`, and the field block holds an
    // AdSense unit. The classifier and `raw_records` must see the company's
    // words, not Google's.
    const company = parseCompany(
      fixture('detail-acalend-sajt-prose.html'),
      `${BASE}/Srbija/acalend/26011`,
      assert,
    );
    expect(company.text).not.toContain('adsbygoogle');
    expect(company.text).not.toContain('google_ad_client');
    expect(company.text).toContain('ACA LAZAREVIĆ PR');
  });

  it('reads a blank field as absent instead of as the next label', () => {
    // Trap 3. `MATIS NIŠ` has a matični broj and no PIB; the label after `PIB:`
    // is `Šifra delatnosti:`, which is what a line-based parser reports here.
    const company = parseCompany(
      fixture('detail-matis-nis-blank-pib.html'),
      `${BASE}/Srbija/matis-nis/26021`,
      assert,
    );

    expect(company.registrationNumber).toBe('61341684');
    expect(company.taxId).toBeNull();
    expect(company.activityCode).toBe('4331');
    // The label was printed even though the value was blank — the difference
    // between "this record has no PIB" and "this template no longer has one".
    expect(company.labels).toContain(LABELS.taxId);
  });

  it('keeps both numbers when a record lists several', () => {
    const company = parseCompany(
      fixture('detail-multi-phone.html'),
      `${BASE}/Srbija/gm-marketing/26393`,
      assert,
    );
    expect(company.phones).toEqual(['+381 (0)62 629230', '+381 (0)12 630013']);
  });
});

describe('parseCompany — the legacy surface', () => {
  it('parses a `/preduzetnici/` page with the same code as a modern one', () => {
    const url = `${BASE}/preduzetnici/p127306_ZANATSKA-ZIDARSKO-FASADERSKA.htm`;
    const company = parseCompany(fixture('detail-legacy-prizma.html'), url, assert);

    expect(company.name).toBe(
      'ZANATSKA ZIDARSKO-FASADERSKA, TESARSKA RADNJA PRIZMA MILUTIN JAKOVLJEVIĆ PR IVANJICA',
    );
    expect(company.phones).toEqual(['+381.(0)64.7655632']);
    expect(company.registrationNumber).toBe('50603989');
    expect(company.taxId).toBe('100934455');
    expect(company.municipality).toBe('Ivanjica');
    expect(company.place).toBe('Ivanjica');
    // The legacy detail page prints the 4-digit šifra, not the 6-digit code its
    // index is addressed by.
    expect(company.activityCode).toBe('4331');
  });
});

describe('parseCompany — failing loudly', () => {
  it('raises when a label the source guarantees stops being printed', () => {
    // `Telefon:` renamed to `Broj telefona:`. Without this assertion the run
    // succeeds and every record silently loses its phone — the whole value of
    // this source, gone quietly.
    expect(() =>
      parseCompany(fixture('detail-redesigned.html'), `${BASE}/Srbija/agmax/26017`, assert),
    ).toThrow(StructureChangedError);
    expect(() =>
      parseCompany(fixture('detail-redesigned.html'), `${BASE}/Srbija/agmax/26017`, assert),
    ).toThrow(/Telefon:/);
  });

  it('raises when the field block is gone', () => {
    const empty = cheerio.load('<html><body><div id="data_content"></div></body></html>');
    expect(() => parseCompany(empty, `${BASE}/Srbija/agmax/26017`, assert)).toThrow(
      StructureChangedError,
    );
  });
});

describe('the pure rules', () => {
  it('splitPhones splits on the comma and drops the trailing one', () => {
    expect(splitPhones('+381.(0)64.4320025')).toEqual(['+381.(0)64.4320025']);
    expect(splitPhones('+381 11 2288208,')).toEqual(['+381 11 2288208']);
    expect(splitPhones('+381.(0)22.650034,+381.(0)64.2245501')).toEqual([
      '+381.(0)22.650034',
      '+381.(0)64.2245501',
    ]);
  });

  it('looksLikeWebsite accepts a host and rejects the prose that follows `Sajt:`', () => {
    expect(looksLikeWebsite('www.termofasade.rs')).toBe(true);
    expect(looksLikeWebsite('http://agmax.rs')).toBe(true);
    expect(looksLikeWebsite('agmax.co.rs/kontakt')).toBe(true);
    expect(
      looksLikeWebsite('Ova firma se bavi pretežno delatnošču Malterisanje. Nalazi se u opštini'),
    ).toBe(false);
    expect(looksLikeWebsite('Malterisanje')).toBe(false);
    expect(looksLikeWebsite('Šifra delatnosti:')).toBe(false);
  });

  it('parseAddress keeps a free-text line whole and splits a labelled one', () => {
    expect(parseAddress('Stubline 372 Stubline')).toEqual({
      municipality: null,
      place: null,
      street: 'Stubline 372 Stubline',
      raw: 'Stubline 372 Stubline',
    });
    expect(parseAddress('Opština: Niš | Mesto: Niš | Ulica i broj: Đorđa Jocića 5').street).toBe(
      'Đorđa Jocića 5',
    );
  });

  it('placeString hands over both published place fields, without repeating one', () => {
    expect(placeString('Stubline', 'Obrenovac')).toBe('Stubline, Obrenovac');
    expect(placeString('Beograd-Čukarica', 'Beograd-Čukarica')).toBe('Beograd-Čukarica');
    expect(placeString(null, 'Ivanjica')).toBe('Ivanjica');
    expect(placeString(null, null)).toBeNull();
  });

  it('parsePlaceSentence reads the municipality and the place the page states', () => {
    expect(
      parsePlaceSentence(
        'Ova firma se bavi pretežno delatnošču Malterisanje. Nalazi se  u opštini Beograd-Čukarica u mestu Beograd (Čukarica). ',
      ),
    ).toEqual({ municipality: 'Beograd-Čukarica', place: 'Beograd (Čukarica)' });
    expect(parsePlaceSentence('nothing to read here')).toEqual({
      municipality: null,
      place: null,
    });
  });
});

describe('selectCategories / selectSurfaces', () => {
  it('defaults to the five core codes and the modern surface only', () => {
    expect(selectCategories([]).map((category) => category.code)).toEqual([
      '43.31',
      '43.39',
      '43.99',
      '43.34',
      '43.29',
    ]);
    expect(selectSurfaces([])).toEqual(['modern']);
  });

  it('takes an adjacent code by code, šifra or list id', () => {
    expect(selectCategories(['43.33']).map((category) => category.listId)).toEqual(['l72']);
    expect(selectCategories(['4333']).map((category) => category.listId)).toEqual(['l72']);
    expect(selectCategories(['l72']).map((category) => category.listId)).toEqual(['l72']);
  });

  it('refuses a code it does not know instead of silently crawling the core five', () => {
    expect(() => selectCategories(['43.21'])).toThrow(/unknown --query 43\.21/);
  });

  it('adds the legacy surface only when asked, and is not itself a category', () => {
    expect(selectSurfaces(['legacy'])).toEqual(['modern', 'legacy']);
    expect(selectCategories(['legacy']).map((category) => category.tier)).toEqual([
      'core',
      'core',
      'core',
      'core',
      'core',
    ]);
  });

  it('keys a scope by category and surface', () => {
    expect(scopeKeyOf(MALTERISANJE, 'modern')).toBe('code:43.31|surface:modern');
    expect(scopeKeyOf(MALTERISANJE, 'legacy')).toBe('code:43.31|surface:legacy');
  });
});

describe('toRawLead', () => {
  const url = `${BASE}/Srbija/acalend/26011`;
  const lead = (): ReturnType<typeof toRawLead> =>
    toRawLead(parseCompany(fixture('detail-acalend-sajt-prose.html'), url, assert), url, {
      recordId: '26011',
      surface: 'modern',
      category: MALTERISANJE,
    });

  it('emits raw values, the exact source URL and the register identifiers', () => {
    expect(lead()).toMatchObject({
      sourceUrl: url,
      name: 'ACA LAZAREVIĆ PR, ZANATSKA RADNJA ACALEND STUBLINE',
      registrationNumber: '61712135',
      taxId: '106114863',
      phones: ['+381.(0)64.3637451'],
      emails: [],
      // `Mesto, Opština`: no gazetteer resolves the village `Stubline` alone.
      city: 'Stubline, Obrenovac',
      address: 'Stubline 372 Stubline',
      categories: ['Malterisanje'],
    });
    expect(lead().website).toBeUndefined();
  });

  it('asserts the trade a core activity code establishes, and names the code for it', () => {
    const record = lead();
    expect(record.assertedType).toBe('FACADE_CONTRACTOR');
    expect(record.assertedTypeReason).toBe(
      'registered under KD 43.31 Malterisanje (šifra delatnosti 4331)',
    );
  });

  it('asserts nothing for an adjacent code — 41.20 is general building construction', () => {
    const record = toRawLead(
      parseCompany(fixture('detail-acalend-sajt-prose.html'), url, assert),
      url,
      {
        recordId: '26011',
        surface: 'modern',
        category: IZGRADNJA_ZGRADA,
      },
    );
    expect(record.assertedType).toBeUndefined();
    expect(record.assertedTypeReason).toBeUndefined();
  });

  it('records which surface and which category the record came from', () => {
    expect(lead().extra).toMatchObject({
      recordId: '26011',
      surface: 'modern',
      categoryCode: '43.31',
      categoryListId: 'l70',
      sifraDelatnosti: '4331',
      municipality: 'Obrenovac',
      contactPerson: 'Aca Lazarević',
      // Kept even when null, so "published no website" stays distinguishable
      // from "this parser did not look".
      websiteFieldRaw: null,
    });
  });

  it('keeps the company layout’s status without ever filtering on it', () => {
    const companyUrl = `${BASE}/Srbija/agmax/26017`;
    const record = toRawLead(
      parseCompany(fixture('detail-agmax-company.html'), companyUrl, assert),
      companyUrl,
      { recordId: '26017', surface: 'modern', category: MALTERISANJE },
    );
    expect(record.extra).toMatchObject({ status: 'Aktivno privredno društvo' });
    expect(record.legalForm).toBe('Društvo sa ograničenom odgovornošću');
  });
});
