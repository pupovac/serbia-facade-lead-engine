import { describe, expect, it } from 'vitest';
import {
  RECOMMENDED_ADDRESS_MATCH_THRESHOLD,
  addressSimilarity,
  normalizeAddress,
} from './address.js';

describe('normalizeAddress', () => {
  it('reads a full Serbian address into its parts', () => {
    const address = normalizeAddress('Ul. Temerinska br. 12/3, 21000 Novi Sad');
    expect(address.display).toBe('Ul. Temerinska br. 12/3, 21000 Novi Sad');
    expect(address.street).toBe('temerinska');
    expect(address.houseNumber).toBe('12');
    expect(address.unit).toBe('3');
    expect(address.postalCode).toBe('21000');
    expect(address.localityId).toBe('novi-sad');
    expect(address.ascii).toBe('temerinska 12, novi-sad');
  });

  it('keeps the published spelling in `display` and folds only the keys', () => {
    const address = normalizeAddress('Bulevar oslobođenja 5, Novi Sad');
    expect(address.display).toBe('Bulevar oslobođenja 5, Novi Sad');
    expect(address.normalized).toBe('bulevar oslobođenja 5, novi sad');
    expect(address.ascii).toBe('bulevar oslobodjenja 5, novi-sad');
  });

  it('puts every spelling of one address on one key', () => {
    const keys = [
      'Temerinska 12, 21000 Novi Sad',
      'Temerinska 12, 21000, Novi Sad',
      'Temerinska 12 21000 Novi Sad',
      'Ul. Temerinska br. 12, Novi Sad',
      'ulica Temerinska 12, Novi Sad',
      'Novi Sad, Temerinska 12',
      'TEMERINSKA 12, NOVI SAD',
      'Темеринска 12, Нови Сад',
      'Temerinska 12, 21000 Novi Sad, Srbija',
      'Temerinska 12/3, Novi Sad',
      'Temerinska 12, u Novom Sadu',
    ].map((raw) => normalizeAddress(raw).ascii);
    expect(new Set(keys)).toEqual(new Set(['temerinska 12, novi-sad']));
  });

  it('expands the abbreviations that stand for a word in the street name', () => {
    for (const raw of ['Bul. oslobođenja 5', 'Bulv. Oslobodjenja 5', 'BLV OSLOBODJENJA 5']) {
      expect(normalizeAddress(raw).ascii).toBe('bulevar oslobodjenja 5');
    }
  });

  it('reads `bb` as the house number it is, not as a missing one', () => {
    const address = normalizeAddress('Kraljevačka bb, Čačak');
    expect(address.houseNumber).toBe('bb');
    expect(address.ascii).toBe('kraljevacka bb, cacak');
  });

  it('takes the last number as the house number, so a street named after a date survives', () => {
    const address = normalizeAddress('27. marta 15, Beograd');
    expect(address.street).toBe('27 marta');
    expect(address.houseNumber).toBe('15');
  });

  it('keeps a letter suffix and a range, because they are different buildings', () => {
    expect(normalizeAddress('Temerinska 12a').houseNumber).toBe('12a');
    expect(normalizeAddress('Temerinska 12-14').houseNumber).toBe('12-14');
  });

  it('rolls a city district up to the municipality the lead is filed under', () => {
    expect(normalizeAddress('Glavna 10, Zemun').localityId).toBe('beograd');
    expect(normalizeAddress('Glavna 10, Beograd').localityId).toBe('beograd');
  });

  it('reads a lone postal code as the place it encodes', () => {
    expect(normalizeAddress('Temerinska 12, 21000').ascii).toBe('temerinska 12, novi-sad');
  });

  it('is idempotent, so a stored key re-keys to itself', () => {
    for (const raw of [
      'Ul. Temerinska br. 12, 21000 Novi Sad',
      'Bulevar oslobođenja 5, Novi Sad',
      'Kraljevačka bb, Čačak',
      '27. marta 15, Beograd',
      'Temerinska 12',
    ]) {
      const once = normalizeAddress(raw).ascii;
      expect(normalizeAddress(once).ascii).toBe(once);
    }
  });

  it('keeps the town on a key it wrote itself, so two towns still conflict', () => {
    // `from-db.ts` re-parses `leads.address_normalized` on every comparison. If
    // the municipality id in the key stopped resolving, a stored address would
    // silently lose its town and start matching the same street elsewhere.
    const stored = normalizeAddress(normalizeAddress('Kralja Petra 12, Novi Sad').ascii);
    expect(stored.localityId).toBe('novi-sad');
    expect(addressSimilarity(stored.ascii, 'Kralja Petra 12, Beograd')).toBe(0);
    expect(addressSimilarity(stored.ascii, 'Kralja Petra 12, 21000 Novi Sad')).toBe(1);
  });

  it('gives a record with no usable address no tokens to match on', () => {
    for (const raw of ['', '   ', '-', 'bb']) {
      expect(normalizeAddress(raw).tokens).toEqual([]);
    }
  });

  it('does not invent a place a street name only sounds like', () => {
    // The geo resolver finds a place inside a messy string on purpose; here that
    // would eat the street. `Beogradska 5` is an address, not Belgrade.
    expect(normalizeAddress('Beogradska 5').localityId).toBeUndefined();
    expect(normalizeAddress('Beogradska 5').ascii).toBe('beogradska 5');
    expect(normalizeAddress('Novosadski put 12').ascii).toBe('novosadski put 12');
  });
});

/* -------------------------------------------------------------------------- */
/* The two corpora behind the threshold                                       */
/* -------------------------------------------------------------------------- */

/**
 * The same address as two Serbian sources actually publish it: a comma moved, a
 * postal code dropped, a marker written out, a script swapped, a flat number
 * added. Every one of these must corroborate.
 */
const TRUE_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  // The pair FUZZ-21 pinned.
  ['Temerinska 12, 21000 Novi Sad', 'Temerinska 12, 21000, Novi Sad'],
  ['Temerinska 12, 21000 Novi Sad', 'Ul. Temerinska br. 12, Novi Sad'],
  ['Temerinska 12, 21000 Novi Sad', 'Темеринска 12, Нови Сад'],
  ['Temerinska 12, Novi Sad', 'Novi Sad, Temerinska 12'],
  ['Temerinska 12/3, Novi Sad', 'Temerinska 12, Novi Sad'],
  ['Bulevar oslobođenja 5, Novi Sad', 'Bul. Oslobodjenja 5, 21000 Novi Sad'],
  ['Bulevar Kralja Aleksandra 73, Beograd', 'Bul. kralja Aleksandra 73, 11000 Beograd'],
  ['Cara Dušana 4, Kragujevac', 'Cara Dusana 4, 34000 Kragujevac'],
  ['Kneza Miloša 22, Beograd', 'KNEZA MILOSA 22, BEOGRAD'],
  ['Bavaništanski put 18, Pančevo', 'Bavanistanski put 18, 26000 Pancevo'],
  ['Đure Đakovića 9, Zrenjanin', 'Djure Djakovica 9, Zrenjanin'],
  ['Kraljevačka bb, Čačak', 'Kraljevacka b.b., 32000 Cacak'],
  ['Nemanjina 4, 11000 Beograd, Srbija', 'Nemanjina 4, Beograd'],
  ['Glavna 10, Zemun', 'Glavna 10, Beograd'],
  ['Vojvode Stepe 120, Beograd', 'Vojvode Stepe 120, 11000, Beograd'],
];

/**
 * Addresses that are genuinely different, in the ways this market produces
 * them: a neighbouring house number, a letter suffix, a street that shares its
 * root with another street in the same town, the same street in two towns.
 */
const TRUE_NEGATIVES: ReadonlyArray<readonly [string, string]> = [
  ['Temerinska 12, Novi Sad', 'Temerinska 12a, Novi Sad'],
  ['Temerinska 12, Novi Sad', 'Temerinska 21, Novi Sad'],
  ['Vojvode Stepe 120, Beograd', 'Vojvode Stepe 12, Beograd'],
  ['Futoška 42, Novi Sad', 'Futoški put 42, Novi Sad'],
  ['Zrenjaninski put 2, Beograd', 'Pančevački put 2, Beograd'],
  ['Kralja Petra 12, Novi Sad', 'Kralja Petra 12, Beograd'],
  ['Kraljevačka bb, Čačak', 'Kraljevačka 12, Čačak'],
  ['Bulevar oslobođenja 5, Novi Sad', 'Bulevar Mihajla Pupina 5, Novi Sad'],
  ['Cara Dušana 4, Kragujevac', 'Cara Lazara 4, Kragujevac'],
  ['Nemanjina 4, Beograd', 'Nemanjina 4, Niš'],
];

/**
 * Real pairs that fall in the gap on purpose: one side never published a house
 * number, so the address is a street and a street is not an address. They are
 * not corroboration, and they are not nothing either — the score says so.
 */
const BELOW_THRESHOLD: ReadonlyArray<readonly [string, string]> = [
  ['Bulevar oslobođenja, Novi Sad', 'Bulevar oslobođenja 5, Novi Sad'],
  ['Temerinska, Novi Sad', 'Temerinska 12, Novi Sad'],
];

describe('addressSimilarity', () => {
  const positives = TRUE_POSITIVES.map(([a, b]) => addressSimilarity(a, b));
  const negatives = TRUE_NEGATIVES.map(([a, b]) => addressSimilarity(a, b));

  for (const [index, pair] of TRUE_POSITIVES.entries()) {
    it(`scores "${pair[0]}" ≈ "${pair[1]}" at or above the threshold`, () => {
      expect(positives[index]).toBeGreaterThanOrEqual(RECOMMENDED_ADDRESS_MATCH_THRESHOLD);
    });
  }

  for (const [index, pair] of TRUE_NEGATIVES.entries()) {
    it(`scores "${pair[0]}" vs "${pair[1]}" below the threshold`, () => {
      expect(negatives[index]).toBeLessThan(RECOMMENDED_ADDRESS_MATCH_THRESHOLD);
    });
  }

  /**
   * The evidence behind `RECOMMENDED_ADDRESS_MATCH_THRESHOLD`. The corpora do
   * not overlap and the recommended value sits in the gap between them, so the
   * threshold is a measurement rather than a guess. A change that narrows the
   * gap fails here, before the dedup engine starts corroborating strangers.
   */
  it('separates the two corpora with the recommended threshold inside the gap', () => {
    const worstPositive = Math.min(...positives);
    // The real lower edge is not the negative corpus — a wrong house number
    // scores 0 — it is the street-with-no-number band just underneath.
    const bestNonMatch = Math.max(
      ...negatives,
      ...BELOW_THRESHOLD.map(([a, b]) => addressSimilarity(a, b)),
    );
    expect(bestNonMatch).toBeLessThan(worstPositive);
    expect(RECOMMENDED_ADDRESS_MATCH_THRESHOLD).toBeGreaterThan(bestNonMatch);
    expect(RECOMMENDED_ADDRESS_MATCH_THRESHOLD).toBeLessThanOrEqual(worstPositive);
  });

  it('leaves an address with no house number below the threshold', () => {
    for (const [a, b] of BELOW_THRESHOLD) {
      const score = addressSimilarity(a, b);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(RECOMMENDED_ADDRESS_MATCH_THRESHOLD);
    }
  });

  it('scores a conflicting house number and a conflicting town at zero, not merely low', () => {
    expect(addressSimilarity('Temerinska 12, Novi Sad', 'Temerinska 12a, Novi Sad')).toBe(0);
    expect(addressSimilarity('Temerinska 12, Novi Sad', 'Temerinska 12, Beograd')).toBe(0);
  });

  it('is symmetric and self-identical', () => {
    for (const [a, b] of [...TRUE_POSITIVES, ...TRUE_NEGATIVES]) {
      expect(addressSimilarity(a, b)).toBe(addressSimilarity(b, a));
      expect(addressSimilarity(a, a)).toBe(1);
    }
  });

  it('scores a record with no address as nothing alike', () => {
    expect(addressSimilarity('', '')).toBe(0);
    expect(addressSimilarity('Temerinska 12', '')).toBe(0);
  });
});
