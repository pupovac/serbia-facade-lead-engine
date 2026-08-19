import { describe, expect, it } from 'vitest';
import {
  cityMunicipalitiesOf,
  findMunicipalitiesByName,
  findMunicipalityByName,
  geoMeta,
  getMunicipalityById,
  landlineGroupCenter,
  municipalities,
  municipalitiesByLandlinePrefix,
  municipalitiesByPriority,
  municipalitiesInRegion,
  municipalitiesInTier,
  searchTermsFor,
  type Municipality,
  type PriorityTier,
} from './geo.js';
import { foldDiacritics } from './text/fold.js';

const units = municipalities.filter((m) => m.type !== 'city_municipality');
const cityMunicipalities = municipalities.filter((m) => m.type === 'city_municipality');

describe('dataset coverage', () => {
  it('carries all 145 Serbian local self-government units plus the 17 Belgrade city municipalities', () => {
    expect(units).toHaveLength(145);
    expect(cityMunicipalities).toHaveLength(17);
    expect(municipalities).toHaveLength(162);
  });

  it('agrees with its own _meta counts', () => {
    expect(geoMeta.unit_count).toBe(units.length);
    expect(geoMeta.city_municipality_count).toBe(cityMunicipalities.length);
  });

  it('matches the official district totals per statistical region', () => {
    // 1 (Belgrade) + 45 + 52 + 47 = 145 units; the 17 Belgrade city municipalities
    // add to the Belgrade region.
    expect(municipalitiesInRegion('Vojvodina')).toHaveLength(45);
    expect(municipalitiesInRegion('Šumadija i Zapadna Srbija')).toHaveLength(52);
    expect(municipalitiesInRegion('Južna i Istočna Srbija')).toHaveLength(47);
    expect(municipalitiesInRegion('Beogradski region')).toHaveLength(18);
  });

  it('cites the authority the unit list was checked against', () => {
    expect(geoMeta.sources.map((s) => s.url)).toContain(
      'https://en.wikipedia.org/wiki/Municipalities_and_cities_of_Serbia',
    );
    expect(geoMeta.sources.some((s) => s.url.includes('publikacije.stat.gov.rs'))).toBe(true);
  });
});

describe('record completeness', () => {
  it('gives every record a name, a district, a region, a tier and at least two search variants', () => {
    for (const m of municipalities) {
      expect(m.name_sr, m.id).not.toBe('');
      expect(m.name_ascii, m.id).not.toBe('');
      expect(m.search_variants.length, m.id).toBeGreaterThanOrEqual(2);
      expect(m.district, m.id).toBeTruthy();
      expect(m.region, m.id).toBeTruthy();
      expect([1, 2, 3], m.id).toContain(m.priority_tier);
    }
  });

  it('folds name_ascii the same way the rest of the project folds text', () => {
    for (const m of municipalities) {
      expect(m.name_ascii, m.id).toBe(foldDiacritics(m.name_sr));
    }
  });

  it('gives every record a landline prefix and a seat postal code', () => {
    for (const m of municipalities) {
      expect(m.landline_prefix, m.id).toMatch(/^0\d{2,3}$/);
      expect(m.postal_codes.length, m.id).toBeGreaterThan(0);
      for (const code of m.postal_codes) expect(code, m.id).toMatch(/^\d{5}$/);
    }
  });

  it('uses unique ids', () => {
    expect(new Set(municipalities.map((m) => m.id)).size).toBe(municipalities.length);
  });

  it('points every city municipality at a parent that exists', () => {
    for (const m of cityMunicipalities) {
      expect(m.parent_id, m.id).toBe('beograd');
      expect(getMunicipalityById(m.parent_id ?? ''), m.id).toBeDefined();
    }
    for (const m of units) expect(m.parent_id, m.id).toBeNull();
  });
});

describe('findMunicipalityByName', () => {
  it('resolves Čačak, Cacak and cacak to the same municipality', () => {
    const withDiacritics = findMunicipalityByName('Čačak');
    expect(withDiacritics?.id).toBe('cacak');
    expect(findMunicipalityByName('Cacak')).toBe(withDiacritics);
    expect(findMunicipalityByName('cacak')).toBe(withDiacritics);
    expect(findMunicipalityByName('ČAČAK')).toBe(withDiacritics);
    expect(findMunicipalityByName('  čačak  ')).toBe(withDiacritics);
    expect(findMunicipalityByName('Чачак')).toBe(withDiacritics);
  });

  it('resolves the inflected forms that actually appear in listings', () => {
    // "fasader u Novom Sadu", "iz Novog Sada" — nominative alone would miss both.
    expect(findMunicipalityByName('Novom Sadu')?.id).toBe('novi-sad');
    expect(findMunicipalityByName('Novog Sada')?.id).toBe('novi-sad');
    expect(findMunicipalityByName('u cacku')?.id).toBeUndefined(); // a phrase, not a place name
    expect(findMunicipalityByName('Čačku')?.id).toBe('cacak');
    expect(findMunicipalityByName('Sapcu')?.id).toBe('sabac');
    expect(findMunicipalityByName('Beogradu')?.id).toBe('beograd');
    expect(findMunicipalityByName('Kragujevcu')?.id).toBe('kragujevac');
    expect(findMunicipalityByName('Bačkoj Palanci')?.id).toBe('backa-palanka');
    expect(findMunicipalityByName('Sremskim Karlovcima')?.id).toBe('sremski-karlovci');
    expect(findMunicipalityByName('Vrnjackoj Banji')?.id).toBe('vrnjacka-banja');
  });

  it('returns undefined for a name that is not a Serbian municipality', () => {
    expect(findMunicipalityByName('Sarajevo')).toBeUndefined();
    expect(findMunicipalityByName('')).toBeUndefined();
    expect(findMunicipalitiesByName('Priština')).toHaveLength(0);
  });

  it('never reports the same municipality twice for one name', () => {
    for (const m of municipalities) {
      for (const term of searchTermsFor(m)) {
        const matches = findMunicipalitiesByName(term);
        expect(new Set(matches).size, `${m.id} / ${term}`).toBe(matches.length);
        expect(matches, `${m.id} / ${term}`).toContain(m);
      }
    }
  });
});

describe('municipalitiesByPriority', () => {
  it('walks tier 1 first and orders each tier by population', () => {
    const order = municipalitiesByPriority();
    expect(order).toHaveLength(municipalities.length);
    expect(order[0]?.id).toBe('beograd');
    for (let i = 1; i < order.length; i += 1) {
      const previous = order[i - 1] as Municipality;
      const current = order[i] as Municipality;
      expect(previous.priority_tier).toBeLessThanOrEqual(current.priority_tier);
      if (previous.priority_tier === current.priority_tier) {
        expect(previous.population).toBeGreaterThanOrEqual(current.population);
      }
    }
  });

  it('puts the largest cities in tier 1 and covers every tier', () => {
    const tier1 = municipalitiesInTier(1).map((m) => m.id);
    expect(tier1).toContain('novi-sad');
    expect(tier1).toContain('nis');
    expect(tier1).toContain('kragujevac');
    expect(tier1).not.toContain('crna-trava'); // 1,063 people
    for (const tier of [1, 2, 3] as PriorityTier[]) {
      expect(municipalitiesInTier(tier).length, `tier ${tier}`).toBeGreaterThan(0);
    }
    expect(
      ([1, 2, 3] as PriorityTier[]).reduce((n, t) => n + municipalitiesInTier(t).length, 0),
    ).toBe(municipalities.length);
  });
});

describe('landline lookup', () => {
  it('maps an area code to every municipality in its network group', () => {
    const group = municipalitiesByLandlinePrefix('021');
    expect(group.map((m) => m.id)).toContain('novi-sad');
    expect(group.map((m) => m.id)).toContain('backa-palanka');
    expect(group).toHaveLength(12);
  });

  it('accepts the forms a scraped phone number arrives in', () => {
    const canonical = municipalitiesByLandlinePrefix('021');
    expect(municipalitiesByLandlinePrefix('21')).toEqual(canonical);
    expect(municipalitiesByLandlinePrefix('+38121')).toEqual(canonical);
    expect(municipalitiesByLandlinePrefix('0038121')).toEqual(canonical);
    expect(municipalitiesByLandlinePrefix('')).toHaveLength(0);
  });

  it('names the city a code belongs to', () => {
    expect(landlineGroupCenter('021')?.id).toBe('novi-sad');
    expect(landlineGroupCenter('011')?.id).toBe('beograd');
    expect(landlineGroupCenter('0230')?.id).toBe('kikinda');
    expect(landlineGroupCenter('018')?.id).toBe('nis');
    expect(landlineGroupCenter('099')).toBeUndefined();
  });

  it('has exactly one group centre per area code', () => {
    const centres = new Map<string, number>();
    for (const m of municipalities) {
      if (m.landline_group_center) {
        centres.set(m.landline_prefix, (centres.get(m.landline_prefix) ?? 0) + 1);
      }
    }
    expect(centres.size).toBe(27); // RATEL network groups
    for (const [prefix, count] of centres) expect(count, prefix).toBe(1);
  });
});

describe('Belgrade', () => {
  it('carries the 17 city municipalities under the city itself', () => {
    const inner = cityMunicipalitiesOf('beograd');
    expect(inner).toHaveLength(17);
    expect(inner.map((m) => m.id)).toContain('beograd-novi-beograd');
    expect(inner.every((m) => m.landline_prefix === '011')).toBe(true);
    expect(cityMunicipalitiesOf('novi-sad')).toHaveLength(0);
  });

  it('keeps the city and its city municipalities separately addressable', () => {
    expect(findMunicipalityByName('Novi Beograd')?.id).toBe('beograd-novi-beograd');
    expect(findMunicipalityByName('Novom Beogradu')?.id).toBe('beograd-novi-beograd');
    expect(findMunicipalityByName('Beograd')?.id).toBe('beograd');
  });
});

describe('searchTermsFor', () => {
  it('returns Latin, ASCII-folded and Cyrillic spellings of all three cases', () => {
    const terms = searchTermsFor(getMunicipalityById('cacak') as Municipality);
    expect(terms).toEqual(
      expect.arrayContaining(['Čačak', 'Cacak', 'Čačku', 'Cacku', 'Čačka', 'Cacka', 'Чачак']),
    );
    expect(new Set(terms).size).toBe(terms.length);
  });
});
