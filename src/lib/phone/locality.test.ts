/**
 * The branch-grouping rule, tested against the record that motivated it.
 *
 * `portal-srbija`'s listing for `Srma group` — one Belgrade address, six phone
 * numbers reaching Zemun, Kraljevo, Niš, Šabac and Vranje — is the shape that
 * cost the pilot four genuine leads, and it is the first case below.
 */
import { describe, expect, it } from 'vitest';
import { areaCodeCovers, labelNamesAnotherPlace, scopePhones } from './locality.js';

const landline = (areaCode: string, extra: Record<string, unknown> = {}) => ({
  type: 'landline',
  valid: true,
  areaCode,
  ...extra,
});
const mobile = { type: 'mobile', valid: true, areaCode: '064' };

describe('areaCodeCovers', () => {
  it('accepts any Belgrade city municipality for 011', () => {
    expect(areaCodeCovers('011', 'beograd')).toBe(true);
    expect(areaCodeCovers('011', 'beograd-zemun')).toBe(true);
  });

  it('rejects a code from another network group', () => {
    expect(areaCodeCovers('036', 'beograd')).toBe(false);
  });

  it('says nothing about a mobile prefix or an unknown code', () => {
    expect(areaCodeCovers('064', 'beograd')).toBe(false);
    expect(areaCodeCovers(undefined, 'beograd')).toBe(false);
  });
});

describe('labelNamesAnotherPlace', () => {
  it('reads a municipality name in the label as evidence of a branch', () => {
    expect(labelNamesAnotherPlace('CENTRALA BEČEJ', 'beograd')).toBe(true);
  });

  it('folds diacritics, so the ASCII spelling counts too', () => {
    expect(labelNamesAnotherPlace('PRODAJA BECEJ', 'beograd')).toBe(true);
  });

  it('is not fooled by the record naming its own city', () => {
    expect(labelNamesAnotherPlace('CENTRALA BEOGRAD', 'beograd')).toBe(false);
  });

  it('says nothing about a label that names no place', () => {
    expect(labelNamesAnotherPlace('PRODAJA', 'beograd')).toBe(false);
    expect(labelNamesAnotherPlace(undefined, 'beograd')).toBe(false);
  });

  it('matches a two-word name as a phrase, not as loose words', () => {
    expect(labelNamesAnotherPlace('SALON NOVI SAD', 'beograd')).toBe(true);
  });
});

describe('scopePhones', () => {
  it("keeps the Belgrade line and marks Srma group's four branch numbers", () => {
    // The pilot record, in order: +381 11 (Zemun, the address on the listing),
    // then Kraljevo, Šabac, Niš and Vranje.
    const scopes = scopePhones(
      [landline('011'), landline('036'), landline('015'), landline('018'), landline('017')],
      { municipalityId: 'beograd-zemun' },
    );
    expect(scopes).toEqual(['business', 'branch', 'branch', 'branch', 'branch']);
  });

  it('never demotes a mobile — it carries no geography to contradict', () => {
    expect(scopePhones([landline('011'), mobile], { municipalityId: 'nis' })).toEqual([
      'branch',
      'business',
    ]);
  });

  it("leaves a lone out-of-area number alone: it is the business's only line", () => {
    // `DOO Zidar, Negotin` in the pilot: a 019 number on a lead filed under
    // Belgrade. Far more likely a city that resolved wrong than a branch, and
    // demoting it would cost the lead its deliverable.
    expect(scopePhones([landline('019')], { municipalityId: 'beograd' })).toEqual(['business']);
  });

  it('still trusts the label when nothing else anchors the record', () => {
    expect(
      scopePhones([landline('019', { label: 'PRODAJA NEGOTIN' })], { municipalityId: 'beograd' }),
    ).toEqual(['branch']);
  });

  it('decides nothing when the record has no municipality', () => {
    expect(scopePhones([landline('011'), landline('036')], { municipalityId: null })).toEqual([
      'business',
      'business',
    ]);
  });

  it('ignores an unparseable string rather than scoping it', () => {
    const scopes = scopePhones(
      [{ type: 'unknown', valid: false, areaCode: undefined }, landline('011')],
      { municipalityId: 'beograd' },
    );
    expect(scopes).toEqual(['business', 'business']);
  });

  it('returns one scope per input, in order', () => {
    const phones = [landline('011'), mobile, landline('021')];
    expect(scopePhones(phones, { municipalityId: 'beograd' })).toHaveLength(phones.length);
  });
});
