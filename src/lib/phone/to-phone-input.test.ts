import { describe, expect, it } from 'vitest';
import { PHONE_TYPES } from '../db/schema.js';
import { normalizePhone } from './normalize.js';
import { toPhoneInput } from './to-phone-input.js';

describe('toPhoneInput', () => {
  it('hands the repository a canonical number it never has to parse', () => {
    expect(toPhoneInput(normalizePhone('064/123-4567'))).toEqual({
      e164: '+381641234567',
      raw: '064/123-4567',
      nationalFormat: '064 1234567',
      type: 'mobile',
      valid: true,
      confidence: 0.95,
    });
  });

  it('only ever emits a type the schema allows', () => {
    for (const raw of ['064 123 4567', '011 2345 678', '0800 123 456', '0700 123 456']) {
      const input = toPhoneInput(normalizePhone(raw));
      expect(PHONE_TYPES).toContain(input.type);
    }
  });

  it('keeps an unparseable number instead of dropping it', () => {
    expect(toPhoneInput(normalizePhone('019 123 456'))).toEqual({
      e164: '+38119123456',
      raw: '019 123 456',
      nationalFormat: null,
      type: 'unknown',
      valid: false,
      confidence: 0,
    });
  });

  it('keeps a foreign number in its own country’s canonical form', () => {
    expect(toPhoneInput(normalizePhone('+385 91 234 5678'))).toMatchObject({
      e164: '+385912345678',
      valid: false,
    });
  });

  it('falls back to the raw string when nothing canonical could be made of it', () => {
    expect(toPhoneInput(normalizePhone('PIB 101234567'))).toMatchObject({
      e164: 'PIB 101234567',
      raw: 'PIB 101234567',
      valid: false,
    });
  });

  it('never lets a placeholder into the canonical column', () => {
    // `+381640000000` in `e164` would merge every unrelated lead that published
    // the same fake number.
    expect(toPhoneInput(normalizePhone('064 000 0000')).e164).toBe('064 000 0000');
  });
});
