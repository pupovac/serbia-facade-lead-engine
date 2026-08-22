/**
 * The shapes below are the ones that sat in the FUZZ-22 pilot's
 * `lead_phones.raw` column with `valid = 0` — 621 of them, and 111 carrying a
 * number that existed nowhere else in the database.
 *
 * **The subscriber digits are synthetic.** Area codes and label text are real,
 * because those are what the rule keys on; the rest is invented, because
 * crawled lead data does not go in the repository.
 */
import { describe, expect, it } from 'vitest';
import { splitPhoneLabel } from './label.js';
import { normalizePhone } from './normalize.js';
import { isPhoneError } from './types.js';

describe('splitPhoneLabel', () => {
  describe('a separator with words on one side of it', () => {
    it('takes a department label off the tail', () => {
      expect(splitPhoneLabel('034 2345678, PRODAJA')).toEqual({
        number: '034 2345678',
        label: 'PRODAJA',
      });
    });

    it('takes a place label off the tail — the branch tell', () => {
      expect(splitPhoneLabel('021 2345678, CENTRALA BEČEJ')).toEqual({
        number: '021 2345678',
        label: 'CENTRALA BEČEJ',
      });
    });

    it('reads a leading label too', () => {
      expect(splitPhoneLabel('PRODAJA: 034 2345678')).toEqual({
        number: '034 2345678',
        label: 'PRODAJA',
      });
    });

    it('keeps a label that carries a small number of its own', () => {
      expect(splitPhoneLabel('021 2345678, LOKAL 118')).toEqual({
        number: '021 2345678',
        label: 'LOKAL 118',
      });
    });
  });

  describe('what it refuses to touch', () => {
    it('leaves two comma-separated numbers alone rather than dropping one', () => {
      const both = '011 1234567, 011 1234599';
      expect(splitPhoneLabel(both)).toEqual({ number: both, label: null });
    });

    it('leaves a plain number alone', () => {
      expect(splitPhoneLabel('+381 64 123 4567')).toEqual({
        number: '+381 64 123 4567',
        label: null,
      });
    });

    it('does not strip a word it does not recognize when nothing separates it', () => {
      // No separator and `ULICA` is not a desk. Better to reject the string
      // than to invent a phone number out of an address.
      const address = 'ULICA 021 2345678';
      expect(splitPhoneLabel(address)).toEqual({ number: address, label: null });
    });

    it('does not turn a label with no number into one', () => {
      expect(splitPhoneLabel('PRODAJA, SERVIS')).toEqual({
        number: 'PRODAJA, SERVIS',
        label: null,
      });
    });

    it('leaves an empty string alone', () => {
      expect(splitPhoneLabel('')).toEqual({ number: '', label: null });
    });
  });

  describe('the unseparated shape, which needs the vocabulary', () => {
    it('strips a recognized desk word in front of the number', () => {
      expect(splitPhoneLabel('PRODAJA 034 2345678')).toEqual({
        number: '034 2345678',
        label: 'PRODAJA',
      });
    });

    it('strips one behind it, and folds diacritics to recognize it', () => {
      expect(splitPhoneLabel('031 2345678 KOMERCIJALA')).toEqual({
        number: '031 2345678',
        label: 'KOMERCIJALA',
      });
    });
  });
});

describe('normalizePhone, on the shapes the pilot could not parse', () => {
  const cases: readonly [string, string, string][] = [
    ['034 2345678, PRODAJA', '+381342345678', 'PRODAJA'],
    ['031 2345678, CENTRALA', '+381312345678', 'CENTRALA'],
    ['011 1234567, FABRIKA', '+381111234567', 'FABRIKA'],
    ['021 2345678, CENTRALA BEČEJ', '+381212345678', 'CENTRALA BEČEJ'],
    ['063 1234567, APATIN', '+381631234567', 'APATIN'],
    ['011 1234567, MALOPRODAJA 1', '+381111234567', 'MALOPRODAJA 1'],
  ];

  it.each(cases)('parses %s', (raw, e164, label) => {
    const result = normalizePhone(raw);
    if (isPhoneError(result)) throw new Error(`${raw} still fails: ${result.error.reason}`);
    expect(result.e164).toBe(e164);
    expect(result.label).toBe(label);
    // The raw column keeps the string exactly as the source published it —
    // the label is evidence, and an audit has to be able to see it.
    expect(result.raw).toBe(raw);
  });

  it('still rejects a string that only looks like a number once a word is removed', () => {
    // `Ulica` is not a desk, so nothing is stripped and the string fails as it
    // always did rather than becoming a phone number.
    expect(isPhoneError(normalizePhone('Ulica 15 broj 3'))).toBe(true);
  });
});
