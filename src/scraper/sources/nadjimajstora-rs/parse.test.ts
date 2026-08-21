/**
 * The parsers, over the pages as the site actually served them on 2026-08-21.
 *
 * The tests that matter here are the three that guard against a *silent* loss,
 * because this source has no loud failure mode for any of them: markup that a
 * double-quote matcher misses, a pager that returns the same masters twice, and
 * an address field whose two halves share one text node. Each one produces a
 * run that looks healthy and is wrong.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { StructureChangedError } from '../../errors.js';
import { expectFound } from '../../types.js';
import {
  listingUrl,
  masterIdFrom,
  parseContact,
  parseListing,
  parseProfile,
  parseShowTel,
  splitPlaceLine,
} from './parse.js';

const BASE = 'https://www.nadjimajstora.rs';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

function load(name: string): cheerio.CheerioAPI {
  return cheerio.load(fixture(name));
}

const expectOf = <T>(
  value: T | null | undefined | readonly T[],
  selector: string,
  url: string,
  expected?: string,
): T => expectFound('nadjimajstora-rs', value, selector, url, expected);

describe('listingUrl', () => {
  /**
   * The single highest-value assertion in this file. The bare category URL
   * sorts by rating descending and the pager sorts ascending, so a page-1
   * request without the sort parameters walks a different ordering from every
   * page after it: 56 rows, 36 distinct masters, no error anywhere.
   */
  it('sends the pager’s sort parameters on page 1, not just on later pages', () => {
    expect(listingUrl(BASE, 'fasader', 1)).toBe(
      `${BASE}/gradjevinski-radovi/fasader.htm?p=1&s=o&st=asc`,
    );
    expect(listingUrl(BASE, 'fasader', 3)).toBe(
      `${BASE}/gradjevinski-radovi/fasader.htm?p=3&s=o&st=asc`,
    );
  });
});

describe('masterIdFrom', () => {
  it('reads the id from both spellings of a profile URL', () => {
    // The listing's doubled dash is an empty city slug, not a typo.
    expect(masterIdFrom(`${BASE}/gradjevinski-radovi/fasader/srdjan-todic--2298.htm`)).toBe(2298);
    expect(masterIdFrom(`${BASE}/gradjevinski-radovi/fasader/srdjan-todic-2298.htm`)).toBe(2298);
    expect(
      masterIdFrom(`${BASE}/gradjevinski-radovi/fasader/nemanja-vranic-novi-sad-1032.htm`),
    ).toBe(1032);
  });

  it('returns null rather than a wrong id for a URL with no id', () => {
    expect(masterIdFrom(`${BASE}/gradjevinski-radovi/fasader.htm`)).toBeNull();
    expect(masterIdFrom(`${BASE}/`)).toBeNull();
  });
});

describe('parseListing', () => {
  it("reads single-quoted `class='Master-Item '` rows a double-quote matcher would miss", () => {
    const url = listingUrl(BASE, 'fasader', 1);
    const raw = fixture('listing-fasader-p1.html');

    // The trap, stated as a fact about the fixture rather than as a claim.
    expect(raw).toContain("class='Master-Item '");
    expect(raw).not.toContain('class="Master-Item ');

    const page = parseListing(load('listing-fasader-p1.html'), url, { expect: expectOf });
    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toEqual({
      id: 37,
      url: `${BASE}/gradjevinski-radovi/fasader/zeljko-djuric-surcin-37.htm`,
      name: 'Željko Đurić',
      rating: '-',
    });
    expect(page.items.every((item) => item.id > 0)).toBe(true);
  });

  it('reads the `1 - 20 od 56` counter', () => {
    const page = parseListing(load('listing-fasader-p1.html'), listingUrl(BASE, 'fasader', 1));
    expect(page).toMatchObject({ from: 1, to: 20, total: 56 });
  });

  it('returns the short last page without complaining', () => {
    const page = parseListing(load('listing-fasader-p3.html'), listingUrl(BASE, 'fasader', 3));
    expect(page.items).toHaveLength(16);
    expect(page.total).toBe(56);
  });

  it('yields 56 distinct masters across the three pages of `fasader`', () => {
    const ids = new Set<number>();
    for (const name of ['listing-fasader-p1.html', 'listing-fasader-p3.html']) {
      for (const item of parseListing(load(name), BASE).items) ids.add(item.id);
    }
    // Pages 1 and 3 are saved; consistent sorting means they never overlap.
    expect(ids.size).toBe(36);
  });

  it('reads the izolater listing with the same selectors', () => {
    const page = parseListing(load('listing-izolater-p1.html'), listingUrl(BASE, 'izolater', 1));
    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(33);
  });

  /**
   * The whole point of `expect`: a redesign has to stop the run, not report a
   * category that quietly emptied out.
   */
  it('raises StructureChangedError when the row markup is gone', () => {
    const $ = cheerio.load('<html><body><div id="Masters-List"></div>1 - 0 od 56</body></html>');
    expect(() => parseListing($, BASE, { expect: expectOf })).toThrow(StructureChangedError);
  });

  it('does not raise on an empty page when the caller did not ask it to', () => {
    const $ = cheerio.load('<html><body><div id="Masters-List"></div></body></html>');
    expect(parseListing($, BASE).items).toEqual([]);
  });
});

describe('parseProfile', () => {
  it('reads the name, the id, the trade and the services checklist', () => {
    const url = `${BASE}/gradjevinski-radovi/fasader/srdjan-todic--2298.htm`;
    const profile = parseProfile(load('profile-srdjan-todic.html'), url, expectOf);

    expect(profile.id).toBe(2298);
    expect(profile.name).toBe('Srdjan Todić');
    expect(profile.trade).toBe('Fasader,');
    expect(profile.addedOn).toBe('12.05.2021.');
    expect(profile.rating).toBe('10.0');
    // Every box on this profile is a grey circle: the site offered him the
    // seven facade services and he ticked none of them.
    expect(profile.occupations).toEqual([]);
    expect(profile.offeredVocabulary).toEqual([
      'Postavljanje fasade',
      'Postavljanje izolacije',
      'Postavljanje mermernih fasada',
      'Postavljanje kamenih fasada',
      'Postavljanje fasadne cigle',
      'Postavljanje dekorativnog kamena',
      'Postavljanje fasadne mrežice',
    ]);
  });

  /**
   * The distinction the markup makes and a careless selector does not: the page
   * lists a trade's whole vocabulary on every profile and ticks the subset the
   * tradesman offers. Reading all the `h4`s would credit `Nenad Dimitrijević`
   * with thermal insulation and drainage he did not claim.
   */
  it('keeps only the ticked services, not the whole trade vocabulary', () => {
    const url = `${BASE}/gradjevinski-radovi/izolater/nenad-dimitrijevic-vozdovac-223.htm`;
    const profile = parseProfile(load('profile-izolater.html'), url, expectOf);
    expect(profile.occupations).toEqual(['Hidroizolacija']);
    expect(profile.offeredVocabulary).toEqual(['Hidroizolacija', 'Termoizolacija', 'Drenaža']);
  });

  /**
   * The contact tab is read off the page's own nav rather than derived from the
   * profile URL, because the two slugs disagree: the listing links
   * `srdjan-todic--2298.htm` and the tab links `srdjan-todic-2298/kontakt.htm`.
   * Building the second from the first by string surgery would 404.
   */
  it('takes the contact tab URL from the page rather than rebuilding it', () => {
    const url = `${BASE}/gradjevinski-radovi/fasader/srdjan-todic--2298.htm`;
    const profile = parseProfile(load('profile-srdjan-todic.html'), url, expectOf);
    expect(profile.contactUrl).toBe(
      `${BASE}/gradjevinski-radovi/fasader/srdjan-todic-2298/kontakt.htm`,
    );
  });

  it('reads an izolater profile with the same selectors', () => {
    const url = `${BASE}/gradjevinski-radovi/izolater/nenad-dimitrijevic-vozdovac-223.htm`;
    const profile = parseProfile(load('profile-izolater.html'), url, expectOf);
    expect(profile).toMatchObject({
      id: 223,
      name: 'Nenad Dimitrijević',
      trade: 'Izolater, Voždovac',
      occupations: ['Hidroizolacija'],
    });
  });

  /**
   * The failure this source does not announce: an unknown slug is `200` with
   * the whole template rendered and every field empty. The name assertion is
   * the only thing standing between that and a nameless record.
   */
  it('raises rather than emitting the blank template an unknown slug returns', () => {
    const blank = cheerio.load(
      '<html><body><div class="Master-Title"><h1> - </h1><h3>, </h3>' +
        '<span class="PibId">ID: </span></div>' +
        '<div class="Master-Vote"><h3>9.3</h3></div></body></html>',
    );
    expect(() =>
      parseProfile(blank, `${BASE}/gradjevinski-radovi/izolater/nope--9999.htm`, expectOf),
    ).toThrow(StructureChangedError);
  });

  it('raises StructureChangedError when the name is gone', () => {
    const $ = cheerio.load('<html><body><div class="Master-Title"></div></body></html>');
    expect(() => parseProfile($, BASE, expectOf)).toThrow(StructureChangedError);
  });
});

describe('splitPlaceLine', () => {
  /**
   * Street and place share one text node, so the split is on meaning. These are
   * the four shapes the 89 real profiles actually produced.
   */
  it('splits a street from the place name it runs into', () => {
    expect(splitPlaceLine('Knez mihajla 5 Paraćin')).toEqual({
      street: 'Knez mihajla 5',
      place: 'Paraćin',
    });
    expect(splitPlaceLine('Pančevački put 196 Palilula')).toEqual({
      street: 'Pančevački put 196',
      place: 'Palilula',
    });
  });

  it('handles a line that is only a place', () => {
    expect(splitPlaceLine('Novi Sad')).toEqual({ street: null, place: 'Novi Sad' });
  });

  it('prefers the longest place name, so `Novi Sad` never reads as `Sad`', () => {
    expect(splitPlaceLine('Bulevar oslobođenja 1 Novi Sad').place).toBe('Novi Sad');
  });

  it('resolves a Belgrade neighbourhood the site’s own dropdown does not list', () => {
    // `Sremčica` and `Karaburma` are settlements, not municipalities. Matching
    // them is what takes place resolution on this source from 87% to 100%.
    expect(splitPlaceLine('Sremčica').place).toBe('Sremčica');
    expect(splitPlaceLine('Karaburma').place).toBe('Karaburma');
  });

  it('reports no place rather than guessing when the line is only a street', () => {
    expect(splitPlaceLine('Kraljice Marije')).toEqual({ street: 'Kraljice Marije', place: null });
  });
});

describe('parseContact', () => {
  it('separates the street from the place in the undivided residence line', () => {
    const contact = parseContact(load('kontakt-srdjan-todic.html'));
    expect(contact.address).toBe('Pančevački put 196');
    expect(contact.place).toBe('Palilula');
    expect(contact.telId).toBe(2298);
    expect(contact.openingHours).toContain('Ponedeljak');
  });

  it('reads a profile that gives a city and no street', () => {
    const contact = parseContact(load('kontakt-city-only.html'));
    expect(contact.address).toBeNull();
    expect(contact.place).toBe('Niš');
    expect(contact.telId).toBe(4162);
  });

  it('returns nulls rather than throwing when the box is absent', () => {
    const contact = parseContact(cheerio.load('<html><body></body></html>'));
    expect(contact).toMatchObject({ address: null, place: null, telId: null });
  });
});

describe('parseShowTel', () => {
  /** The exact body the endpoint returned for master 2298. */
  it('reads one number out of the reveal payload', () => {
    const body =
      '{"ind":1,"html":"\\n<a href=\\"tel:0645880669 \\" >0645880669 <\\/a><br\\/>\\n<a href=\\"tel:\\" ><\\/a>","msg":"Show master phone"}';
    expect(parseShowTel(body)).toEqual(['0645880669']);
  });

  it('reads both numbers when a master registered two', () => {
    const body =
      '{"ind":1,"html":"<a href=\\"tel:060 016 02 75\\">060 016 02 75<\\/a><br\\/><a href=\\"tel:063 809 39 27\\">063 809 39 27<\\/a>","msg":"ok"}';
    expect(parseShowTel(body)).toEqual(['060 016 02 75', '063 809 39 27']);
  });

  it('does not repeat a number the site printed in both slots', () => {
    const body =
      '{"ind":1,"html":"<a href=\\"tel:0656372964\\">0656372964<\\/a><br\\/><a href=\\"tel:0656372964\\">0656372964<\\/a>"}';
    expect(parseShowTel(body)).toEqual(['0656372964']);
  });

  it('reports an empty list for a master with no number, distinctly from a refusal', () => {
    expect(parseShowTel('{"ind":1,"html":"<a href=\\"tel:\\" ><\\/a>"}')).toEqual([]);
    // `null` is what an unrecognised id answers — a different fact, and the one
    // that must not be read as "this tradesman has no phone".
    expect(parseShowTel('null')).toBeNull();
  });

  it('reports a refusal rather than throwing when the endpoint stops speaking JSON', () => {
    expect(parseShowTel('<html>Just a moment…</html>')).toBeNull();
    expect(parseShowTel('{"ind":0,"msg":"denied"}')).toBeNull();
  });

  it('falls back to the anchor text when the href loses its number', () => {
    expect(parseShowTel('{"ind":1,"html":"<a href=\\"tel:\\">064 123 4567<\\/a>"}')).toEqual([
      '064 123 4567',
    ]);
  });
});
