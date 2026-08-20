/**
 * Portal Srbija's city slugs against the municipality dataset.
 *
 * The interesting cases are all the ones where the slug is not a municipality:
 * the site names a page after whatever neighbourhood it covers, so `zeleznik`
 * has to become Čukarica and `palic` has to become Subotica before `--city`
 * can mean anything.
 */
import { describe, expect, it } from 'vitest';
import { getMunicipalityById, type Municipality } from '@/lib/geo';
import { cityTextInScope, planLocations, resolveCitySlug } from './geography.js';
import type { LocationLink } from './parse.js';

function unit(id: string): Municipality {
  const municipality = getMunicipalityById(id);
  if (municipality === undefined) throw new Error(`no municipality ${id}`);
  return municipality;
}

function link(citySlug: string): LocationLink {
  return {
    slug: `radovi-na-visini-${citySlug}`,
    citySlug,
    label: citySlug,
    url: `https://www.portal-srbija.com/radovi-na-visini-${citySlug}`,
  };
}

describe('resolveCitySlug', () => {
  it('resolves a municipality slug outright', () => {
    expect(resolveCitySlug('novi-sad')).toEqual({ cityId: 'novi-sad', municipalityId: 'novi-sad' });
    expect(resolveCitySlug('kraljevo')).toEqual({ cityId: 'kraljevo', municipalityId: 'kraljevo' });
  });

  it('resolves a neighbourhood to the unit it rolls up to', () => {
    expect(resolveCitySlug('zeleznik')).toEqual({
      cityId: 'beograd-cukarica',
      municipalityId: 'beograd',
    });
    expect(resolveCitySlug('banovo-brdo')).toEqual({
      cityId: 'beograd-cukarica',
      municipalityId: 'beograd',
    });
    // A settlement of another city entirely.
    expect(resolveCitySlug('palic')).toEqual({ cityId: 'subotica', municipalityId: 'subotica' });
    expect(resolveCitySlug('kac')).toEqual({ cityId: 'novi-sad', municipalityId: 'novi-sad' });
  });

  it('takes the longest prefix that names a place', () => {
    // The site names one page after four neighbourhoods at once.
    expect(resolveCitySlug('rakovica-miljakovac-kanarevo-brdo-resnik')).toEqual({
      cityId: 'beograd-rakovica',
      municipalityId: 'beograd',
    });
    // Longest-first matters here: `nova-pazova` is a settlement of Stara
    // Pazova, and stopping at the first word would find nothing.
    expect(resolveCitySlug('nova-pazova')).toEqual({
      cityId: 'stara-pazova',
      municipalityId: 'stara-pazova',
    });
  });

  it('reports a slug it cannot place rather than guessing', () => {
    // A wrong city is worse than an empty one — these crawl last instead.
    expect(resolveCitySlug('zarkovo-cerak')).toEqual({ cityId: null, municipalityId: null });
    expect(resolveCitySlug('desimirovac')).toEqual({ cityId: null, municipalityId: null });
  });
});

describe('planLocations', () => {
  const links = [
    link('kraljevo'),
    link('zarkovo-cerak'),
    link('kac'),
    link('novi-beograd'),
    link('novi-sad'),
  ];

  it('orders by the dataset crawl order, unplaced slugs last', () => {
    const plan = planLocations(links, []);
    expect(plan.map((entry) => entry.link.citySlug)).toEqual([
      // Tier 1 by population: Novi Sad (~340k) outranks the Belgrade city
      // municipality Novi Beograd (~210k), which outranks Kraljevo. `kac`
      // ranks as Novi Sad and ties are broken by slug.
      'kac',
      'novi-sad',
      'novi-beograd',
      'kraljevo',
      // Placed last: the dataset cannot say where it is.
      'zarkovo-cerak',
    ]);
  });

  it('keeps only the cities a --city run asked for', () => {
    const plan = planLocations(links, [unit('novi-sad')]);
    expect(plan.map((entry) => entry.link.citySlug)).toEqual(['kac', 'novi-sad']);
  });

  it('treats --city beograd as every Belgrade city municipality', () => {
    const plan = planLocations(links, [unit('beograd')]);
    expect(plan.map((entry) => entry.link.citySlug)).toEqual(['novi-beograd']);
  });

  it('drops slugs it cannot place when the run is city-scoped', () => {
    // There is no honest way to say `zarkovo-cerak` is or is not in scope.
    const plan = planLocations([link('zarkovo-cerak')], [unit('beograd')]);
    expect(plan).toEqual([]);
  });
});

describe('cityTextInScope', () => {
  it('reads the company block’s own city string', () => {
    expect(cityTextInScope('Novi Sad', [unit('novi-sad')])).toBe(true);
    expect(cityTextInScope('Beograd', [unit('novi-sad')])).toBe(false);
    // The national page mixes the country together; a Belgrade-scoped run
    // still wants the Zemun rows off it.
    expect(cityTextInScope('Beograd Borča, Krnjača, Kotež', [unit('beograd')])).toBe(true);
  });

  it('keeps everything when the run is not city-scoped', () => {
    expect(cityTextInScope('Beograd', [])).toBe(true);
    expect(cityTextInScope(null, [])).toBe(true);
  });

  it('drops a row with no city when the run is city-scoped', () => {
    expect(cityTextInScope(null, [unit('novi-sad')])).toBe(false);
  });
});
