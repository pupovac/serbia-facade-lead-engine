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
