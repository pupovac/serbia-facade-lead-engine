import { describe, expect, it } from 'vitest';
import {
  brandLabel,
  canonicalUrlString,
  isSameSite,
  normalizeHost,
  parseLooseUrl,
  registrableDomain,
} from './url.js';

describe('parseLooseUrl', () => {
  const repaired: ReadonlyArray<readonly [string, string]> = [
    // portal-srbija.com prints this href with a space inside it.
    ['http:// www.vns.rs', 'http://www.vns.rs/'],
    // poslovnikontakt.com never closes the attribute.
    [
      'https://www.facebook.com/pages/Agencija-Poslovni-kontakt/984748621542308?ref=hl/  target="_blank"',
      'https://www.facebook.com/pages/Agencija-Poslovni-kontakt/984748621542308?ref=hl/',
    ],
    // zutestrane.net prints the site as text, with no scheme.
    ['www.fermax.co.rs', 'https://www.fermax.co.rs/'],
    ['firma.rs/kontakt', 'https://firma.rs/kontakt'],
    ['//cdn.firma.rs/x', 'https://cdn.firma.rs/x'],
    [
      'https://www.biznisgroup.rs/gra&amp;evinarstvo/',
      'https://www.biznisgroup.rs/gra&evinarstvo/',
    ],
  ];

  for (const [input, expected] of repaired) {
    it(`repairs ${input}`, () => {
      expect(parseLooseUrl(input)?.toString()).toBe(expected);
    });
  }

  const rejected = [
    '',
    '   ',
    '#',
    '#kontakt',
    '/kontakt',
    'javascript:void(0)',
    'tel:0641234567',
    'mailto:a@b.rs',
    'localhost',
    'ftp://firma.rs',
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(parseLooseUrl(input)).toBeNull();
    });
  }
});

describe('registrableDomain', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['www.bimax.rs', 'bimax.rs'],
    ['BIMAX.RS', 'bimax.rs'],
    ['shop.firma.rs', 'firma.rs'],
    ['www.lensim.co.rs', 'lensim.co.rs'],
    ['gradjevinskefirme.cu.rs', 'cu.rs'],
    ['beograd.besplatnioglasi.in.rs', 'besplatnioglasi.in.rs'],
    ['srbija.aladin.info', 'aladin.info'],
    ['www.austrotherm.com.tr', 'austrotherm.com.tr'],
    ['maps.app.goo.gl', 'goo.gl'],
  ];
  for (const [host, expected] of cases) {
    it(`${host} → ${expected}`, () => {
      expect(registrableDomain(host)).toBe(expected);
    });
  }
});

describe('normalizeHost', () => {
  it('lower-cases and drops www', () => {
    expect(normalizeHost('WWW.Firma.RS')).toBe('firma.rs');
  });

  it('keeps a subdomain that is not www', () => {
    expect(normalizeHost('mojafirma.navidiku.rs')).toBe('mojafirma.navidiku.rs');
  });
});

describe('brandLabel', () => {
  it('is the label the directory is known by', () => {
    expect(brandLabel('www.navidiku.rs')).toBe('navidiku');
    expect(brandLabel('www.daibau.co.uk')).toBe('daibau');
  });
});

describe('isSameSite', () => {
  it('matches a subdomain of the source', () => {
    expect(isSameSite('mojafirma.navidiku.rs', 'www.navidiku.rs')).toBe(true);
  });

  it('does not match a different registrable domain', () => {
    expect(isSameSite('vasfasader.rs', 'www.navidiku.rs')).toBe(false);
  });
});

describe('canonicalUrlString', () => {
  it('keeps a non-default port, which is part of the address', () => {
    const url = parseLooseUrl('http://firma.rs:8080/kontakt/');
    expect(url).not.toBeNull();
    expect(canonicalUrlString(url as URL)).toBe('https://firma.rs:8080/kontakt');
  });

  it('sorts what is left of the query after the trackers are gone', () => {
    const url = parseLooseUrl('https://firma.rs/proizvodi?utm_source=x&b=2&a=1&fbclid=y');
    expect(canonicalUrlString(url as URL)).toBe('https://firma.rs/proizvodi?a=1&b=2');
  });
});
