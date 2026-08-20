import { describe, expect, it } from 'vitest';
import {
  diacriticVariants,
  foldDiacritics,
  foldForComparison,
  normalizeWhitespace,
} from './fold.js';

describe('foldDiacritics', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Čačak', 'Cacak'],
    ['Užice', 'Uzice'],
    ['Šabac', 'Sabac'],
    ['Ćuprija', 'Cuprija'],
    ['Đakovica', 'Djakovica'],
    ['građevinski materijal', 'gradjevinski materijal'],
    ['GRAĐEVINSKO STOVARIŠTE', 'GRADJEVINSKO STOVARISTE'],
    ['Beograd', 'Beograd'],
    ['izolacija kuće', 'izolacija kuce'],
    ['Novi Pazar', 'Novi Pazar'],
    ['Ǆemal', 'DZemal'],
  ];

  for (const [input, expected] of cases) {
    it(`folds ${input} to ${expected}`, () => {
      expect(foldDiacritics(input)).toBe(expected);
    });
  }

  // `Đ` folds to two letters, so all-caps input needs `DJ` — including when
  // the letter ends the word and there is nothing after it to read the case
  // from. `ĐORĐ` used to fold to `DJORDj`.
  const digraphCases: ReadonlyArray<readonly [string, string]> = [
    ['ĐORĐ', 'DJORDJ'],
    ['Đorđ', 'Djordj'],
    ['ĐURĐEVIĆ FASADE', 'DJURDJEVIC FASADE'],
    ['Đurđević fasade', 'Djurdjevic fasade'],
    ['SMEĐ', 'SMEDJ'],
    ['Đ', 'Dj'],
    ['ĐORĐ, BEOGRAD', 'DJORDJ, BEOGRAD'],
    ['NJEGOŠ FASADE', 'NJEGOS FASADE'],
    ['Njegoš fasade', 'Njegos fasade'],
    ['DŽORDŽ', 'DZORDZ'],
    // The precomposed single-code-point digraphs, U+01C4..U+01CC.
    ['Ǉubinko', 'LJubinko'],
    ['ǈubinko', 'Ljubinko'],
    ['ǉubinko', 'ljubinko'],
    ['Ǌegoš', 'NJegos'],
    ['ǋegoš', 'Njegos'],
    ['ǌegoš', 'njegos'],
    ['Ǆemal', 'DZemal'],
    ['ǳak', 'dzak'],
  ];

  for (const [input, expected] of digraphCases) {
    it(`folds the digraph in ${input} to ${expected}`, () => {
      expect(foldDiacritics(input)).toBe(expected);
    });
  }

  it('leaves already-folded text untouched', () => {
    expect(foldDiacritics('gradjevinski')).toBe('gradjevinski');
  });

  it('leaves digits and punctuation alone', () => {
    expect(foldDiacritics('Fasade d.o.o. — 064/123-4567')).toBe('Fasade d.o.o. — 064/123-4567');
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs of whitespace', () => {
    expect(normalizeWhitespace('  Termo   fasada \n\t Beograd ')).toBe('Termo fasada Beograd');
  });

  it('collapses non-breaking spaces from scraped HTML', () => {
    expect(normalizeWhitespace('Stovari\u00a0\u00a0\u0161te\u200b')).toBe('Stovari \u0161te');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeWhitespace('   \n  ')).toBe('');
  });
});

describe('foldForComparison', () => {
  it('makes the two spellings of a company name equal', () => {
    expect(foldForComparison('  GRAĐEVINAR  Čačak ')).toBe(foldForComparison('gradjevinar cacak'));
  });

  // A directory that publishes in Cyrillic is publishing the same business as
  // the one next to it that publishes in Latin. Every comparison key in the
  // project goes through here, so this is where the two scripts meet.
  it('is script-insensitive', () => {
    expect(foldForComparison('ГРАЂЕВИНСКО СТОВАРИШТЕ')).toBe(
      foldForComparison('Građevinsko stovarište'),
    );
    expect(foldForComparison('Фасадерски радови Марковић')).toBe(
      foldForComparison('FASADERSKI RADOVI MARKOVIĆ'),
    );
    expect(foldForComparison('ЊЕГОШ ФАСАДЕ ДОО')).toBe(foldForComparison('Njegoš fasade doo'));
    expect(foldForComparison('ЏОРЏЕ')).toBe(foldForComparison('Džordže'));
    expect(foldForComparison('Ковиљ')).toBe(foldForComparison('KOVILJ'));
  });

  it('is case-insensitive for the digraphs, which case-mapping alone is not', () => {
    for (const [caps, mixed] of [
      ['NJEGOŠ FASADE', 'Njegoš Fasade'],
      ['LJUBINKO GRADNJA', 'Ljubinko Gradnja'],
      ['DŽORDŽE STOVARIŠTE', 'Džordže Stovarište'],
      ['ĐORĐ IZOLACIJA', 'Đorđ Izolacija'],
    ] as const) {
      expect(foldForComparison(caps)).toBe(foldForComparison(mixed));
    }
  });

  it('leaves a non-Serbian Cyrillic letter alone rather than guessing', () => {
    // Russian `ы` and `э` have no Serbian counterpart; passing them through is
    // the honest result, and they never appear in a Serbian business name.
    expect(foldForComparison('Аэрофлот')).toBe('aэroflot');
  });
});

describe('diacriticVariants', () => {
  it('returns both spellings when they differ', () => {
    expect(diacriticVariants('građevinski materijal')).toEqual([
      'građevinski materijal',
      'gradjevinski materijal',
    ]);
  });

  it('returns a single entry when folding changes nothing', () => {
    expect(diacriticVariants('fasader')).toEqual(['fasader']);
  });

  it('normalizes whitespace before comparing', () => {
    expect(diacriticVariants('  termo   fasada ')).toEqual(['termo fasada']);
  });
});
