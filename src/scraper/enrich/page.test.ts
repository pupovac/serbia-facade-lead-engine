/**
 * Reading a page, against pages that were really on the Serbian web.
 *
 * `termodom-*.html`, `tgkomerc-*.html` and `verticalsystem-parked.html` are
 * real, saved byte-for-byte on 2026-08-20 from robots-permitted sites, and the
 * values asserted here are the values those businesses actually publish. That
 * matters more than a tidy synthetic page would: every awkward thing in this
 * file — an `og:site_name` holding a page title, a phone glued to an email by
 * a missing tag boundary, an address that exists only as prose behind an
 * `Adresa:` label — is a real thing a real Serbian site does, and each of them
 * was a bug in this parser before it was a test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { countBusinesses, labelledAddress, readPage, stripPageLabel } from './page.js';
import type { PageEvidence } from './types.js';

function read(name: string, url: string): PageEvidence {
  const html = readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    'utf8',
  );
  return readPage({ url, html, $: cheerio.load(html) });
}

describe('termodom.rs — a shop with its contact details in the footer', () => {
  const home = (): PageEvidence => read('termodom-home.html', 'https://termodom.rs/');
  const kontakt = (): PageEvidence => read('termodom-kontakt.html', 'https://termodom.rs/kontakt');

  it('reads the phone and the email off the homepage', () => {
    const page = home();
    expect(page.phones).toEqual([
      { e164: '+381641083932', raw: '064 108 39 32', origin: 'text', type: 'mobile' },
    ]);
    expect(page.emails).toEqual(['vukasin@termodom.rs']);
    expect(page.website).toBe('https://termodom.rs');
  });

  it('does not glue an email to the number next to it', () => {
    // The page renders `…39 32</span><a>vukasin@termodom.rs</a><p>brzi…`, and
    // cheerio's `.text()` drops the tags without a separator. Before `textOf`
    // replaced tags with a space, this read `32vukasin@termodom.rsbrzi` and the
    // real address was lost.
    for (const page of [home(), kontakt()]) {
      expect(page.emails).not.toContain('32vukasin@termodom.rsbrzi');
      expect(page.emails).toEqual(['vukasin@termodom.rs']);
    }
  });

  it('takes the brand out of an `og:site_name` that is really a page title', () => {
    // The tag literally holds `Kontakt | Radno vreme | Informacije | Termodom`.
    expect(kontakt().businessName).toBe('Termodom');
    expect(home().businessName).toBe('Termodom Online prodavnica');
  });

  it('prefers the `tel:` link on the contact page to the same number in prose', () => {
    expect(kontakt().phones[0]?.origin).toBe('tel-link');
  });
});

describe('tgkomerc-98.co.rs — a yard with JSON-LD and a prose address', () => {
  const kontakt = (): PageEvidence =>
    read('tgkomerc-kontakt.html', 'https://tgkomerc-98.co.rs/kontakt/');

  it('reads both landlines, the email and the Facebook page', () => {
    const page = kontakt();
    expect(page.phones.map((phone) => phone.e164)).toEqual(['+381212419400', '+381212320399']);
    expect(page.phones[0]?.origin).toBe('json-ld');
    expect(page.emails).toEqual(['tgkomerc98@gmail.com']);
    expect(page.socials).toEqual([
      { network: 'facebook', url: 'https://www.facebook.com/tgkomerc98' },
    ]);
  });

  it('does not read the dates and order numbers on the page as phone numbers', () => {
    // The page carries strings like `017-06-09` and `01733216334`. Only the two
    // real numbers survive `libphonenumber-js`.
    expect(kontakt().phones).toHaveLength(2);
  });

  it('reads the address from the `Adresa:` label and resolves the city from it', () => {
    const page = kontakt();
    expect(page.address).toBe('Klisanski put 167, 21000 Novi Sad');
    expect(page.addressGrade).toBe('labelled');
    expect(page.postalCode).toBe('21000');
    expect(page.cityId).toBe('novi-sad');
  });

  it('keeps a labelled address out of the matcher’s corroboration slot', () => {
    // The whole point of the two grades: this address is good enough to attach
    // to a lead, and not good enough to promote a name match to a merge.
    expect(kontakt().candidateRecord.addressNormalized).toBeNull();
  });

  it('names the business from its JSON-LD, not from the title', () => {
    // The `<title>` is `TG Komerc-98 / Stovarište / Gradjevinski Materijal / Novi Sad`.
    expect(kontakt().businessName).toBe('TG Komerc-98');
  });

  it('counts one business, not one per JSON-LD node', () => {
    expect(kontakt().businessesOnPage).toBe(1);
  });
});

describe('a structured address', () => {
  it('is allowed to corroborate, unlike a labelled one', () => {
    const page = read('positive/mika-fasade-kontakt.html', 'https://mikafasade.rs/kontakt');
    expect(page.addressGrade).toBe('structured');
    expect(page.address).toBe('Temerinska 12, 21000, Novi Sad');
    expect(page.candidateRecord.addressNormalized).toBe('temerinska 12, 21000, novi sad');
    expect(page.cityId).toBe('novi-sad');
  });
});

describe('a parked domain', () => {
  it('yields nothing to attach rather than failing', () => {
    const page = read('verticalsystem-parked.html', 'https://verticalsystem.rs/');
    expect(page.phones).toEqual([]);
    expect(page.emails).toEqual([]);
    expect(page.address).toBeNull();
    expect(page.businessesOnPage).toBe(1);
  });
});

describe('a directory listing page', () => {
  it('is read as eight phone numbers, which is what the listing veto counts', () => {
    const page = read('negative/stovariste-listing.html', 'https://neki-portal.rs/x');
    expect(page.phones).toHaveLength(8);
  });
});

/* -------------------------------------------------------------------------- */
/* The pure helpers                                                           */
/* -------------------------------------------------------------------------- */

describe('stripPageLabel', () => {
  it('takes the last part that is not a page label', () => {
    expect(stripPageLabel('Kontakt | Radno vreme | Informacije | Termodom')).toBe('Termodom');
    expect(stripPageLabel('Fasade Petrović | Kontakt')).toBe('Fasade Petrović');
    expect(stripPageLabel('Mika Fasade - Novi Sad')).toBe('Novi Sad');
  });

  it('leaves a title that is only a name alone', () => {
    expect(stripPageLabel('Fasade Petrović')).toBe('Fasade Petrović');
    expect(stripPageLabel('TG Komerc-98')).toBe('TG Komerc-98');
  });

  it('keeps something when every part is a page label', () => {
    expect(stripPageLabel('Kontakt | O nama')).toBe('Kontakt');
  });
});

describe('labelledAddress', () => {
  it('reads the line a Serbian contact page labels', () => {
    const parsed = labelledAddress('KONTAKT PODACI\nAdresa: Klisanski put 167, 21000 Novi Sad');
    expect(parsed.full).toBe('Klisanski put 167, 21000 Novi Sad');
    expect(parsed.postalCode).toBe('21000');
    expect(parsed.locality).toBe('Novi Sad');
    expect(parsed.grade).toBe('labelled');
  });

  it('stops at the next labelled field on the same line', () => {
    const parsed = labelledAddress('Adresa: Rumenačka 118, 21000 Novi Sad Telefon: 021/2419-400');
    expect(parsed.full).toBe('Rumenačka 118, 21000 Novi Sad');
  });

  it('refuses a line with no house number on it', () => {
    // `Adresa: Novi Sad` places nothing and would corroborate nothing.
    expect(labelledAddress('Adresa: Novi Sad').full).toBeNull();
  });

  it('reads nothing at all from unlabelled prose', () => {
    expect(labelledAddress('Nalazimo se u Rumenačkoj 118 u Novom Sadu.').full).toBeNull();
  });
});

describe('countBusinesses', () => {
  it('counts distinct names, so a site that repeats its own markup is still one', () => {
    const $ = cheerio.load('<html><body></body></html>');
    const nodes = [
      { '@type': 'Organization', name: 'TG Komerc-98' },
      { '@type': 'LocalBusiness', name: 'TG Komerc-98' },
    ];
    expect(countBusinesses($, nodes)).toBe(1);
  });

  it('counts a directory’s nodes one per company', () => {
    const $ = cheerio.load('<html><body></body></html>');
    const nodes = [
      { '@type': 'LocalBusiness', name: 'Mika Fasade' },
      { '@type': 'LocalBusiness', name: 'Gradnja Plus' },
      { '@type': 'LocalBusiness', name: 'Stovarište Jović' },
    ];
    expect(countBusinesses($, nodes)).toBe(3);
  });

  it('falls back to microdata, and then to one', () => {
    const microdata = cheerio.load(
      '<div itemscope itemtype="https://schema.org/LocalBusiness"></div>' +
        '<div itemscope itemtype="https://schema.org/LocalBusiness"></div>',
    );
    expect(countBusinesses(microdata, [])).toBe(2);
    expect(countBusinesses(cheerio.load('<p>nothing</p>'), [])).toBe(1);
  });
});
