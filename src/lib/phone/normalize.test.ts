import { describe, expect, it } from 'vitest';
import { municipalities } from '../geo.js';
import { normalizePhone } from './normalize.js';
import { areaCodeFor, inferCityFromAreaCode, isDatasetAreaCode } from './serbian-numbering.js';
import { isPhoneError } from './types.js';
import type { NormalizedPhone, PhoneErrorCode, PhoneType } from './types.js';

function accepted(raw: string): NormalizedPhone {
  const result = normalizePhone(raw);
  if (isPhoneError(result)) {
    throw new Error(`expected ${JSON.stringify(raw)} to normalize, got ${result.error.code}`);
  }
  return result;
}

/**
 * Every written form a Serbian listing has actually used, and what it must
 * become. `city` is the municipality a landline area code resolves to — the
 * only location signal a phone-only listing gives us.
 */
const ACCEPTED: ReadonlyArray<
  readonly [string, string, string, PhoneType, string, string | undefined, number]
> = [
  // Mobile, every separator a Serbian page reaches for.
  ['064 123 4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['064/123-4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['064-123-4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['064 123 45 67', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['064/1234567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['0641234567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['0 6 4 1 2 3 4 5 6 7', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['  064 123 4567  ', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  ['064 123 4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 0.95],
  // The same number saying its own country code.
  ['+381 64 123 4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['+381641234567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['00381 64 123 4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['00381641234567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['381641234567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['+381(0)64 123 4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['+381 (0) 64 123 4567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['tel:+381641234567', '+381641234567', '064 1234567', 'mobile', '064', undefined, 1],
  ['tel:0112085506', '+381112085506', '011 2085506', 'landline', '011', 'beograd', 0.95],
  // 06x with six and with seven subscriber digits, across every operator prefix.
  ['064 123 456', '+38164123456', '064 123456', 'mobile', '064', undefined, 0.95],
  ['060 123456', '+38160123456', '060 123456', 'mobile', '060', undefined, 0.95],
  ['061/234-567', '+38161234567', '061 234567', 'mobile', '061', undefined, 0.95],
  ['062 1131773', '+381621131773', '062 1131773', 'mobile', '062', undefined, 0.95],
  ['063 686300', '+38163686300', '063 686300', 'mobile', '063', undefined, 0.95],
  ['065 123 4567', '+381651234567', '065 1234567', 'mobile', '065', undefined, 0.95],
  ['066 123456', '+38166123456', '066 123456', 'mobile', '066', undefined, 0.95],
  ['067 1234567', '+381671234567', '067 1234567', 'mobile', '067', undefined, 0.95],
  ['067 12345678', '+3816712345678', '067 12345678', 'mobile', '067', undefined, 0.95],
  ['068 123456', '+38168123456', '068 123456', 'mobile', '068', undefined, 0.95],
  ['069 5651990', '+381695651990', '069 5651990', 'mobile', '069', undefined, 0.95],
  // Landlines. Each one names the town its area code has to resolve to.
  ['011 2345 678', '+381112345678', '011 2345678', 'landline', '011', 'beograd', 0.95],
  ['011/234-56-78', '+381112345678', '011 2345678', 'landline', '011', 'beograd', 0.95],
  ['0112085506', '+381112085506', '011 2085506', 'landline', '011', 'beograd', 0.95],
  ['+381 11 234 5678', '+381112345678', '011 2345678', 'landline', '011', 'beograd', 1],
  ['021/456-789', '+38121456789', '021 456789', 'landline', '021', 'novi-sad', 0.95],
  ['021/456-7890', '+381214567890', '021 4567890', 'landline', '021', 'novi-sad', 0.95],
  ['010 321 555', '+38110321555', '010 321555', 'landline', '010', 'pirot', 0.95],
  ['012 7661140', '+381127661140', '012 7661140', 'landline', '012', 'pozarevac', 0.95],
  ['013 345 678', '+38113345678', '013 345678', 'landline', '013', 'pancevo', 0.95],
  ['014 3421209', '+381143421209', '014 3421209', 'landline', '014', 'valjevo', 0.95],
  ['015 345 678', '+38115345678', '015 345678', 'landline', '015', 'sabac', 0.95],
  ['016 245104', '+38116245104', '016 245104', 'landline', '016', 'leskovac', 0.95],
  ['017 421 555', '+38117421555', '017 421555', 'landline', '017', 'vranje', 0.95],
  ['018 550907', '+38118550907', '018 550907', 'landline', '018', 'nis', 0.95],
  ['019 421 555', '+38119421555', '019 421555', 'landline', '019', 'zajecar', 0.95],
  ['020 315 555', '+38120315555', '020 315555', 'landline', '020', 'novi-pazar', 0.9],
  ['022 671119', '+38122671119', '022 671119', 'landline', '022', 'sremska-mitrovica', 0.95],
  ['023 561 234', '+38123561234', '023 561234', 'landline', '023', 'zrenjanin', 0.95],
  ['024 555 123', '+38124555123', '024 555123', 'landline', '024', 'subotica', 0.95],
  ['025 421 555', '+38125421555', '025 421555', 'landline', '025', 'sombor', 0.95],
  ['026 415 200', '+38126415200', '026 415200', 'landline', '026', 'smederevo', 0.95],
  ['027 321 555', '+38127321555', '027 321555', 'landline', '027', 'prokuplje', 0.95],
  ['030 421 555', '+38130421555', '030 421555', 'landline', '030', 'bor', 0.95],
  ['031 512 555', '+38131512555', '031 512555', 'landline', '031', 'uzice', 0.95],
  ['032 373712', '+38132373712', '032 373712', 'landline', '032', 'cacak', 0.95],
  ['033 712 555', '+38133712555', '033 712555', 'landline', '033', 'prijepolje', 0.95],
  ['034 6792660', '+381346792660', '034 6792660', 'landline', '034', 'kragujevac', 0.95],
  ['035 221 555', '+38135221555', '035 221555', 'landline', '035', 'jagodina', 0.95],
  ['036 333 444', '+38136333444', '036 333444', 'landline', '036', 'kraljevo', 0.95],
  ['037 421 555', '+38137421555', '037 421555', 'landline', '037', 'krusevac', 0.95],
  // Kikinda is 0230 and Zrenjanin is 023 — a shortest-match lookup files every
  // Kikinda number under the wrong town.
  ['0230 421 555', '+381230421555', '0230 421555', 'landline', '0230', 'kikinda', 0.95],
  // Landlines the coverage dataset cannot place: real numbers, lower confidence.
  ['028 425 555', '+38128425555', '028 425555', 'landline', '028', undefined, 0.75],
  ['029 421 555', '+38129421555', '029 421555', 'landline', '029', undefined, 0.8],
  ['039 421 555', '+38139421555', '039 421555', 'landline', '039', undefined, 0.8],
  // Non-geographic business lines. A stovarište that publishes one is still a lead.
  ['0800 123 456', '+381800123456', '0800 123456', 'toll_free', '0800', undefined, 0.95],
  ['0700 123 456', '+381700123456', '0700 123456', 'unknown', '0700', undefined, 0.95],
  // Valid, but shaped like a placeholder — kept, scored down.
  ['011 2222 333', '+381112222333', '011 2222333', 'landline', '011', 'beograd', 0.9],
  ['064 5555 123', '+381645555123', '064 5555123', 'mobile', '064', undefined, 0.9],
  // First two digits step by one, the rest do not: not a sequential fake.
  ['012 345 679', '+38112345679', '012 345679', 'landline', '012', 'pozarevac', 0.95],
];

const REJECTED: ReadonlyArray<readonly [string, PhoneErrorCode]> = [
  ['', 'empty'],
  ['   ', 'empty'],
  ['nema telefona', 'empty'],
  // Postal codes: Belgrade is 11000, Novi Sad 21000. Both look like a phone prefix.
  ['11000', 'too-short'],
  ['21000', 'too-short'],
  ['064-123', 'too-short'],
  ['064 12 34', 'too-short'],
  // A Serbian bank account number, and a mobile with an extra group glued on.
  ['160-0000000000000-00', 'too-long'],
  ['+381 64 123 4567 8901', 'too-long'],
  ['01.01.2024', 'date'],
  ['2024-01-01', 'date'],
  ['1/1/24', 'date'],
  ['15.03.2019.', 'date'],
  // A PIB is nine digits and a matični broj eight, with nothing in front.
  ['101234567', 'ambiguous-national-number'],
  ['20123456', 'ambiguous-national-number'],
  ['123456789', 'ambiguous-national-number'],
  ['PIB 101234567', 'not-a-number'],
  ['1.200,00 RSD', 'not-a-number'],
  ['064 123 4567 lok. 12', 'not-a-number'],
  ['+0 1234567 8', 'not-a-number'],
  // Placeholders somebody typed to get past a required field.
  ['000000000', 'repeated-digits'],
  ['064 000 0000', 'repeated-digits'],
  ['011 111 1111', 'repeated-digits'],
  ['0641111111', 'repeated-digits'],
  ['0123456789', 'sequential-digits'],
  ['0987654321', 'sequential-digits'],
  // Real numbers, wrong country. Never bent into +381.
  ['+385 91 234 5678', 'foreign'],
  ['+387 61 123 456', 'foreign'],
  ['+382 67 622 901', 'foreign'],
  ['+389 70 123 456', 'foreign'],
  ['00385 1 2345 678', 'foreign'],
  ['+383 44 123 456', 'foreign'],
  ['+800 12345678', 'foreign'],
  // 090x is a premium-rate line, not a business contact.
  ['0900 123 456', 'unsupported-type'],
  // Shapes the numbering plan rejects: subscriber starting with 1, an area code
  // that was never assigned, an eight-digit matični broj with a leading zero.
  ['019 123 456', 'invalid-for-region'],
  ['049 123 456', 'invalid-for-region'],
  ['08123456', 'invalid-for-region'],
  ['+381 60 12 34', 'invalid-for-region'],
];

describe('normalizePhone — accepted', () => {
  it.each(ACCEPTED)('%s → %s', (raw, e164, nationalFormat, type, areaCode, city, confidence) => {
    expect(accepted(raw)).toEqual({
      e164,
      raw,
      nationalFormat,
      type,
      areaCode,
      inferredCityId: city,
      confidence,
    });
  });

  it('covers at least the sixty cases the module was specified with', () => {
    expect(ACCEPTED.length + REJECTED.length).toBeGreaterThanOrEqual(60);
  });

  it('keeps the raw string byte for byte, however it was written', () => {
    expect(accepted('064/123-4567').raw).toBe('064/123-4567');
    expect(accepted('  064 123 4567  ').raw).toBe('  064 123 4567  ');
  });
});

describe('normalizePhone — rejected', () => {
  it.each(REJECTED)('%s → %s', (raw, code) => {
    const result = normalizePhone(raw);
    if (!isPhoneError(result)) throw new Error(`expected ${JSON.stringify(raw)} to be rejected`);
    expect(result.error.code).toBe(code);
    expect(result.error.raw).toBe(raw);
    expect(result.error.reason).not.toBe('');
  });
});

describe('foreign numbers', () => {
  it('flags a Croatian mobile with its own country and canonical form', () => {
    const result = normalizePhone('+385 91 234 5678');
    if (!isPhoneError(result)) throw new Error('expected a rejection');
    expect(result.error).toMatchObject({
      code: 'foreign',
      country: 'HR',
      e164: '+385912345678',
    });
  });

  it('never coerces a neighbouring country to +381', () => {
    for (const raw of ['+385 91 234 5678', '+387 61 123 456', '+382 67 622 901']) {
      const result = normalizePhone(raw);
      if (!isPhoneError(result)) throw new Error('expected a rejection');
      expect(result.error.e164?.startsWith('+381')).toBe(false);
    }
  });

  it('still reports a calling code that belongs to no single country', () => {
    const result = normalizePhone('+800 12345678');
    if (!isPhoneError(result)) throw new Error('expected a rejection');
    expect(result.error.country).toBeUndefined();
    expect(result.error.e164).toBe('+80012345678');
  });
});

describe('what a rejection carries forward', () => {
  it('keeps the parsed form of an invalid Serbian number for the audit trail', () => {
    const result = normalizePhone('019 123 456');
    if (!isPhoneError(result)) throw new Error('expected a rejection');
    expect(result.error.e164).toBe('+38119123456');
  });

  it('withholds a canonical form for a placeholder, so it cannot false-merge', () => {
    for (const raw of ['064 000 0000', '0123456789']) {
      const result = normalizePhone(raw);
      if (!isPhoneError(result)) throw new Error('expected a rejection');
      expect(result.error.e164).toBeUndefined();
    }
  });
});

describe('landline city inference', () => {
  const areaCodes = [...new Set(municipalities.map((m) => m.landline_prefix))].sort();

  it('covers every area code in the geographic dataset', () => {
    expect(areaCodes).toHaveLength(27);
  });

  it.each(areaCodes)('%s resolves to a landline in the town it is named after', (areaCode) => {
    // A subscriber number starting 4 is valid in every Serbian network group.
    const phone = accepted(`${areaCode} 421 555`);
    const expected = municipalities.find(
      (m) => m.landline_prefix === areaCode && m.landline_group_center,
    );
    expect(phone.type).toBe('landline');
    expect(phone.areaCode).toBe(areaCode);
    expect(phone.inferredCityId).toBe(expected?.id);
  });

  it('never infers a city from a mobile prefix', () => {
    for (const raw of ['064 123 4567', '060 123456', '069 5651990']) {
      expect(accepted(raw).inferredCityId).toBeUndefined();
    }
  });
});

describe('confidence', () => {
  it('trusts a number that states its own country code more than a trunk-form one', () => {
    expect(accepted('+381 64 123 4567').confidence).toBe(1);
    expect(accepted('064 123 4567').confidence).toBe(0.95);
  });

  it('scores down a landline no town can be inferred for', () => {
    expect(accepted('029 421 555').confidence).toBe(0.8);
  });

  it('scores down a run of four identical digits', () => {
    expect(accepted('064 5555 123').confidence).toBe(0.9);
  });

  it('stays inside 0 and 1 for every accepted case', () => {
    for (const [raw] of ACCEPTED) {
      const { confidence } = accepted(raw);
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('serbian numbering tables', () => {
  it('prefers the longer area code when one is a prefix of another', () => {
    expect(areaCodeFor('230421555')).toBe('0230');
    expect(areaCodeFor('23561234')).toBe('023');
  });

  it('has no code for a number outside the plan', () => {
    expect(areaCodeFor('49123456')).toBeUndefined();
  });

  it('knows which area codes the coverage dataset can place', () => {
    expect(isDatasetAreaCode('021')).toBe(true);
    expect(isDatasetAreaCode('21')).toBe(true);
    expect(isDatasetAreaCode('028')).toBe(false);
    expect(isDatasetAreaCode(undefined)).toBe(false);
  });

  it('infers nothing from a missing or unplaceable area code', () => {
    expect(inferCityFromAreaCode(undefined)).toBeUndefined();
    expect(inferCityFromAreaCode('028')).toBeUndefined();
    expect(inferCityFromAreaCode('021')).toBe('novi-sad');
  });
});
