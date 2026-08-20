/**
 * Which links are worth a second request.
 *
 * The real fixtures are the point: `tgkomerc-home.html` publishes three
 * contact-ish links with three different labels, and `termodom-home.html`
 * publishes exactly one. A guess-the-URL crawler would have spent four
 * requests on each and mostly collected 404s.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { contactLinks } from './contact-pages.js';

function load(name: string): cheerio.CheerioAPI {
  return cheerio.load(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8'),
  );
}

describe('the real sites', () => {
  it('finds termodom’s single contact link', () => {
    const links = contactLinks(load('termodom-home.html'), 'https://termodom.rs/', 3);
    expect(links).toEqual([
      { url: 'https://termodom.rs/kontakt', text: 'Kontakt', rank: 100, keyword: 'kontakt' },
    ]);
  });

  it('ranks tgkomerc’s `kontakt` links above its `o nama` link', () => {
    const links = contactLinks(load('tgkomerc-home.html'), 'https://tgkomerc-98.co.rs/', 3);
    expect(links.map((link) => link.url)).toEqual([
      'https://tgkomerc-98.co.rs/kontakt/',
      'https://tgkomerc-98.co.rs/new/kontakt/',
      'https://tgkomerc-98.co.rs/o_nama/',
    ]);
    expect(links.map((link) => link.rank)).toEqual([100, 100, 70]);
  });

  it('finds nothing on a page that links nowhere useful', () => {
    expect(
      contactLinks(load('verticalsystem-parked.html'), 'https://verticalsystem.rs/', 3),
    ).toEqual([]);
  });
});

describe('what it refuses to follow', () => {
  const page = (body: string): cheerio.CheerioAPI => cheerio.load(`<body>${body}</body>`);

  it('stays on the site — an outbound contact link is somebody else’s', () => {
    const links = contactLinks(
      page('<a href="https://drugafirma.rs/kontakt">Kontakt</a>'),
      'https://firma.rs/',
      3,
    );
    expect(links).toEqual([]);
  });

  it('treats www. and the bare host as the same site', () => {
    const links = contactLinks(
      page('<a href="https://www.firma.rs/kontakt">Kontakt</a>'),
      'https://firma.rs/',
      3,
    );
    expect(links.map((link) => link.url)).toEqual(['https://www.firma.rs/kontakt']);
  });

  it('skips mailto, tel, fragments and files', () => {
    const links = contactLinks(
      page(
        '<a href="mailto:a@firma.rs">Kontakt</a>' +
          '<a href="tel:+381641234567">Kontakt</a>' +
          '<a href="#kontakt">Kontakt</a>' +
          '<a href="/kontakt.pdf">Kontakt</a>',
      ),
      'https://firma.rs/',
      3,
    );
    expect(links).toEqual([]);
  });

  it('does not offer the page it was given back to itself', () => {
    const links = contactLinks(
      page('<a href="/kontakt">Kontakt</a><a href="/kontakt#forma">Kontakt</a>'),
      'https://firma.rs/kontakt',
      3,
    );
    expect(links).toEqual([]);
  });

  it('ignores a link that matches no keyword at all', () => {
    expect(
      contactLinks(page('<a href="/proizvodi">Proizvodi</a>'), 'https://firma.rs/', 3),
    ).toEqual([]);
  });
});

describe('Serbian spelling', () => {
  const page = (body: string): cheerio.CheerioAPI => cheerio.load(`<body>${body}</body>`);

  it('matches Cyrillic anchor text', () => {
    const links = contactLinks(page('<a href="/k">Контакт</a>'), 'https://firma.rs/', 3);
    expect(links[0]?.keyword).toBe('kontakt');
  });

  it('matches a diacritic-free slug against a diacritic keyword', () => {
    const links = contactLinks(
      page('<a href="/pisite-nam">Пишите нам</a>'),
      'https://firma.rs/',
      3,
    );
    expect(links[0]?.keyword).toBe('pisite-nam');
  });

  it('scores a keyword in the href above the same keyword in the text alone', () => {
    const links = contactLinks(
      page('<a href="/kontakt">Piši nam</a><a href="/info">Kontakt</a>'),
      'https://firma.rs/',
      3,
    );
    expect(links[0]?.url).toBe('https://firma.rs/kontakt');
    expect(links[0]?.rank).toBeGreaterThan(links[1]?.rank ?? 0);
  });
});

describe('the cap', () => {
  it('returns at most the limit it was given', () => {
    const body = ['kontakt', 'contact', 'o-nama', 'impressum', 'lokacije']
      .map((slug) => `<a href="/${slug}">${slug}</a>`)
      .join('');
    expect(contactLinks(cheerio.load(`<body>${body}</body>`), 'https://firma.rs/', 2)).toHaveLength(
      2,
    );
  });
});
