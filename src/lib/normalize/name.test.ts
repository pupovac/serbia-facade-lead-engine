import { describe, expect, it } from 'vitest';
import {
  characterSimilarity,
  nameSimilarity,
  normalizeCompanyName,
  RECOMMENDED_NAME_MATCH_THRESHOLD,
} from './name.js';

interface NameCase {
  readonly raw: string;
  readonly normalized: string;
  readonly legalForm?: string;
  readonly tradeName?: string;
  readonly cityHint?: string;
}

/**
 * Names in the shape Serbian directories publish them: legal form in front or
 * behind, the seat glued on, quotes around the trade name, Cyrillic, ALL CAPS,
 * and the ASCII spellings a site with a broken charset produces.
 */
const CASES: readonly NameCase[] = [
  // --- d.o.o. in all its spellings
  { raw: 'Fasada d.o.o.', normalized: 'fasada', legalForm: 'd.o.o.' },
  { raw: 'Fasada d.o.o', normalized: 'fasada', legalForm: 'd.o.o.' },
  { raw: 'FASADA DOO', normalized: 'fasada', legalForm: 'd.o.o.' },
  { raw: 'doo Fasada', normalized: 'fasada', legalForm: 'd.o.o.' },
  { raw: 'Fasada D.O.O. Beograd', normalized: 'fasada', legalForm: 'd.o.o.', cityHint: 'Beograd' },
  {
    raw: 'Građevinar d.o.o. Kragujevac',
    normalized: 'građevinar',
    legalForm: 'd.o.o.',
    cityHint: 'Kragujevac',
  },
  { raw: 'GRADJEVINAR DOO', normalized: 'gradjevinar', legalForm: 'd.o.o.' },
  { raw: 'Termo Izolacija D.O.O.', normalized: 'termo izolacija', legalForm: 'd.o.o.' },
  {
    raw: 'Stovarište Dunav doo Novi Sad',
    normalized: 'stovarište dunav',
    legalForm: 'd.o.o.',
    cityHint: 'Novi Sad',
  },

  // --- preduzetnik and the single-letter forms
  {
    raw: 'Fasaderski radovi PR Milan Ilić',
    normalized: 'fasaderski radovi milan ilić',
    legalForm: 'pr',
  },
  { raw: 'PR Zoran Jovanović Fasade', normalized: 'zoran jovanović fasade', legalForm: 'pr' },
  { raw: 'Izolacija SR Dragan Petrović', normalized: 'izolacija dragan petrović', legalForm: 'sr' },
  { raw: 'Beton Gradnja AD', normalized: 'beton gradnja', legalForm: 'a.d.' },
  {
    raw: 'A.D. Rudnik Gornji Milanovac',
    normalized: 'rudnik',
    legalForm: 'a.d.',
    cityHint: 'Gornji Milanovac',
  },
  {
    raw: 'Preduzetnik Marko Marković Fasade',
    normalized: 'marko marković fasade',
    legalForm: 'preduzetnik',
  },
  {
    raw: 'Zanatska radnja Zidar Čačak',
    normalized: 'zidar',
    legalForm: 'zanatska radnja',
    cityHint: 'Čačak',
  },

  // --- the SZR / STR / SUR family, with and without dots
  { raw: 'SZR Fasader Niš', normalized: 'fasader', legalForm: 'szr', cityHint: 'Niš' },
  { raw: 'S.Z.R. Fasader', normalized: 'fasader', legalForm: 'szr' },
  {
    raw: 'SZR "Fasada" Novi Sad',
    normalized: 'fasada',
    legalForm: 'szr',
    tradeName: 'Fasada',
    cityHint: 'Novi Sad',
  },
  { raw: 'STR Gradnja Komerc', normalized: 'gradnja komerc', legalForm: 'str' },
  { raw: 'S.T.R. Stovarište Zid', normalized: 'stovarište zid', legalForm: 'str' },
  { raw: 'SZTR Majstor Leskovac', normalized: 'majstor', legalForm: 'sztr', cityHint: 'Leskovac' },
  {
    raw: 'Stovarište "Gradnja" pr Milan Jovanović',
    normalized: 'gradnja',
    legalForm: 'pr',
    tradeName: 'Gradnja',
  },

  // --- Cyrillic, including Cyrillic legal forms
  { raw: 'Фасада д.о.о. Београд', normalized: 'fasada', legalForm: 'd.o.o.', cityHint: 'Beograd' },
  { raw: 'ФАСАДА ДОО', normalized: 'fasada', legalForm: 'd.o.o.' },
  {
    raw: 'Грађевинар доо Крагујевац',
    normalized: 'građevinar',
    legalForm: 'd.o.o.',
    cityHint: 'Kragujevac',
  },
  { raw: 'Занатска радња Зидар', normalized: 'zidar', legalForm: 'zanatska radnja' },
  { raw: 'СЗР Фасадер Ниш', normalized: 'fasader', legalForm: 'szr', cityHint: 'Niš' },
  { raw: 'Предузетник Марко Марковић', normalized: 'marko marković', legalForm: 'preduzetnik' },
  { raw: 'Стоваришта Дунав', normalized: 'stovarišta dunav' },

  // --- quoted trade names in every quote style Serbian sites use
  { raw: '„Fasada" doo', normalized: 'fasada', legalForm: 'd.o.o.', tradeName: 'Fasada' },
  {
    raw: 'ZR »Termo Fasade« Užice',
    normalized: 'termo fasade',
    legalForm: 'zr',
    tradeName: 'Termo Fasade',
    cityHint: 'Užice',
  },
  {
    raw: "Gradnja 'Petrović' d.o.o.",
    normalized: 'petrović',
    legalForm: 'd.o.o.',
    tradeName: 'Petrović',
  },

  // --- names that must survive intact
  { raw: 'Fasade Marković', normalized: 'fasade marković' },
  { raw: 'Fasade Marko', normalized: 'fasade marko' },
  { raw: 'Beograd doo', normalized: 'beograd', legalForm: 'd.o.o.' },
  { raw: 'DOO', normalized: 'doo', legalForm: 'd.o.o.' },
  { raw: 'MB Gradnja', normalized: 'mb gradnja' },
  { raw: 'Termo-izolacija Čačak', normalized: 'termo izolacija', cityHint: 'Čačak' },
  { raw: '  Fasade   Nikolić  ', normalized: 'fasade nikolić' },
  { raw: 'Izolacija & Fasade', normalized: 'izolacija fasade' },
  { raw: 'Stiropor Centar 021', normalized: 'stiropor centar 021' },
  { raw: 'Majstori za fasadu Vranje', normalized: 'majstori za fasadu', cityHint: 'Vranje' },
  { raw: 'Gradjevinsko stovariste Bogdanovic', normalized: 'gradjevinsko stovariste bogdanovic' },
];

describe('normalizeCompanyName', () => {
  for (const testCase of CASES) {
    it(`normalizes ${testCase.raw} to "${testCase.normalized}"`, () => {
      const result = normalizeCompanyName(testCase.raw);
      expect(result.normalized).toBe(testCase.normalized);
      expect(result.legalForm).toBe(testCase.legalForm);
      expect(result.tradeName).toBe(testCase.tradeName);
      expect(result.cityHint).toBe(testCase.cityHint);
    });
  }

  it('covers at least 40 real-world name shapes', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it('keeps the published spelling in display, whatever the script', () => {
    expect(normalizeCompanyName('  Фасада   д.о.о.  ').display).toBe('Фасада д.о.о.');
    expect(normalizeCompanyName('Građevinar d.o.o.').display).toBe('Građevinar d.o.o.');
  });

  it('folds the ascii key so Građevinar and Gradjevinar collide', () => {
    expect(normalizeCompanyName('Građevinar d.o.o.').ascii).toBe(
      normalizeCompanyName('GRADJEVINAR DOO').ascii,
    );
    expect(normalizeCompanyName('Фасада доо').ascii).toBe(
      normalizeCompanyName('Fasada d.o.o.').ascii,
    );
  });

  it('keeps the diacritic spelling in normalized and folds only ascii', () => {
    const result = normalizeCompanyName('Fasade Marković');
    expect(result.normalized).toBe('fasade marković');
    expect(result.ascii).toBe('fasade markovic');
  });

  it('never returns an empty key for a name that has one', () => {
    for (const testCase of CASES) {
      expect(normalizeCompanyName(testCase.raw).normalized.length).toBeGreaterThan(0);
    }
  });

  it('returns empty keys for empty input rather than throwing', () => {
    const result = normalizeCompanyName('   ');
    expect(result.display).toBe('');
    expect(result.normalized).toBe('');
    expect(result.tokens).toEqual([]);
  });
});

/** Same business, written differently by two sources. These must score high. */
const TRUE_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  ['SZR "Fasada" Novi Sad', 'FASADA DOO NOVI SAD'],
  ['Građevinar d.o.o. Kragujevac', 'GRADJEVINAR DOO'],
  ['Фасада д.о.о. Београд', 'Fasada doo Beograd'],
  ['Termo Fasade Petrović', 'Termofasade Petrovic'],
  ['Fasade Nikolić', 'Fasade Nikolic'],
  ['Stovarište Dunav doo', 'Dunav stovarište'],
  ['Gradjevinsko stovariste Bogdanovic', 'Građevinsko stovarište Bogdanović'],
  ['PR Zoran Jovanović Fasade', 'Zoran Jovanovic fasade'],
  ['Izolacija Milošević', 'Milošević izolacija'],
  ['MB Gradnja d.o.o. Šabac', 'MB GRADNJA DOO'],
  ['Termo izolacija Čačak', 'Termoizolacija Cacak'],
  ['Majstori za fasadu Vranje', 'Majstori za fasadu, Vranje'],
  // Harder: one side carries an extra industry word, a typo, or split initials.
  ['Termo Fasade Petrović', 'Fasade Petrović'],
  ['Gradjevinar Jovanović', 'Gradjevinar Jovanovič'],
  ['M.B. Gradnja', 'MB Gradnja'],
];

/**
 * Pairs that are probably the same business and still score below the
 * threshold. They are recorded rather than fixed: pulling the threshold down to
 * catch them would also catch `Fasade Marković` / `Fasade Mitrović`, and the
 * dedup engine has a phone, a domain and a city to settle these with.
 */
const BELOW_THRESHOLD: ReadonlyArray<readonly [string, string]> = [
  ['Petrović i sin d.o.o.', 'Petrovic i sinovi doo'],
  ['Stovarište Gradnja Komerc', 'Gradnja Komerc'],
  ['Fasade Nikolić', 'Nikolić fasade i izolacija'],
];

/** Different businesses that look alike. These must score low. */
const TRUE_NEGATIVES: ReadonlyArray<readonly [string, string]> = [
  ['Fasade Marković', 'Fasade Marko'],
  ['Fasade Marković', 'Fasade Mitrović'],
  ['Gradnja plus', 'Gradnja komerc'],
  ['Stovarište Dunav', 'Stovarište Drina'],
  ['Termo Fasade Petrović', 'Termo Fasade Pavlović'],
  ['Izolacija Milošević', 'Izolacija Milovanović'],
  ['MB Gradnja', 'MG Gradnja'],
  ['Fasader Niš', 'Fasader Nikolić'],
  ['Zidar Čačak', 'Zidar Čabar'],
  ['Beton Gradnja AD', 'Beton Promet AD'],
  ['Stiropor Centar', 'Stiropor Servis'],
  ['Fasada', 'Fasader Jovanović'],
];

describe('nameSimilarity', () => {
  const positives = TRUE_POSITIVES.map(([a, b]) => nameSimilarity(a, b));
  const negatives = TRUE_NEGATIVES.map(([a, b]) => nameSimilarity(a, b));

  for (const [index, pair] of TRUE_POSITIVES.entries()) {
    it(`scores "${pair[0]}" ≈ "${pair[1]}" at or above the threshold`, () => {
      expect(positives[index]).toBeGreaterThanOrEqual(RECOMMENDED_NAME_MATCH_THRESHOLD);
    });
  }

  for (const [index, pair] of TRUE_NEGATIVES.entries()) {
    it(`scores "${pair[0]}" vs "${pair[1]}" below the threshold`, () => {
      expect(negatives[index]).toBeLessThan(RECOMMENDED_NAME_MATCH_THRESHOLD);
    });
  }

  /**
   * The evidence behind `RECOMMENDED_NAME_MATCH_THRESHOLD`. The two corpora do
   * not overlap, and the recommended value sits inside the gap between them —
   * so the threshold is a measurement, not a guess. If a future change narrows
   * the gap, this fails before the dedup engine starts merging strangers.
   */
  it('separates the two corpora with the recommended threshold inside the gap', () => {
    const worstPositive = Math.min(...positives);
    const bestNegative = Math.max(...negatives);
    expect(bestNegative).toBeLessThan(worstPositive);
    expect(RECOMMENDED_NAME_MATCH_THRESHOLD).toBeGreaterThan(bestNegative);
    expect(RECOMMENDED_NAME_MATCH_THRESHOLD).toBeLessThanOrEqual(worstPositive);
  });

  it('leaves the known near-misses below the threshold, above the negatives', () => {
    const bestNegative = Math.max(...negatives);
    for (const [a, b] of BELOW_THRESHOLD) {
      const score = nameSimilarity(a, b);
      expect(score).toBeGreaterThan(bestNegative);
      expect(score).toBeLessThan(RECOMMENDED_NAME_MATCH_THRESHOLD);
    }
  });

  it('is symmetric and self-identical', () => {
    for (const [a, b] of [...TRUE_POSITIVES, ...TRUE_NEGATIVES]) {
      expect(nameSimilarity(a, b)).toBe(nameSimilarity(b, a));
      expect(nameSimilarity(a, a)).toBe(1);
    }
  });

  it('scores two nameless records as nothing alike', () => {
    expect(nameSimilarity('', '')).toBe(0);
    expect(nameSimilarity('Fasada', '')).toBe(0);
  });

  it('does not merge two businesses that share only the industry word', () => {
    expect(nameSimilarity('Fasade Jovanović', 'Fasade Petrović')).toBeLessThan(0.5);
  });
});

describe('characterSimilarity', () => {
  it('is 1 for identical strings and 0 for a missing one', () => {
    expect(characterSimilarity('fasada', 'fasada')).toBe(1);
    expect(characterSimilarity('fasada', '')).toBe(0);
  });

  it('drops with each edit', () => {
    expect(characterSimilarity('markovic', 'markovi')).toBeCloseTo(0.875, 3);
    expect(characterSimilarity('markovic', 'marko')).toBeCloseTo(0.625, 3);
  });
});
