import { describe, expect, it } from 'vitest';
import { getMunicipalityById, municipalities } from '../geo.js';
import { isPhoneError, normalizePhone } from '../phone/index.js';
import { foldForComparison } from '../text/fold.js';
import {
  resolveCity,
  resolveCityDetailed,
  settlements,
  type CityMatchMethod,
  type Settlement,
} from './city.js';

function expectCity(raw: string, cityId: string, via: CityMatchMethod, hint?: { phone: string }) {
  const match = resolveCity(raw, hint);
  expect(match, `"${raw}" should resolve`).not.toBeNull();
  expect(match?.cityId).toBe(cityId);
  expect(match?.matchedVia).toBe(via);
  return match;
}

describe('resolveCity — the plain forms', () => {
  const cases: ReadonlyArray<readonly [string, string, CityMatchMethod]> = [
    ['Novi Sad', 'novi-sad', 'exact'],
    ['novi sad', 'novi-sad', 'exact'],
    ['NOVI SAD', 'novi-sad', 'exact'],
    ['Нови Сад', 'novi-sad', 'exact'],
    ['Čačak', 'cacak', 'exact'],
    ['Cacak', 'cacak', 'exact'],
    ['Чачак', 'cacak', 'exact'],
    ['Užice', 'uzice', 'exact'],
    ['Uzice', 'uzice', 'exact'],
    ['Kragujevac', 'kragujevac', 'exact'],
    ['Sremska Mitrovica', 'sremska-mitrovica', 'exact'],
    ['Petrovac na Mlavi', 'petrovac-na-mlavi', 'exact'],
    ['Vrnjacka Banja', 'vrnjacka-banja', 'exact'],
    ['Indjija', 'indjija', 'exact'],
    ['Inđija', 'indjija', 'exact'],
  ];

  for (const [raw, cityId, via] of cases) {
    it(`resolves ${raw} to ${cityId}`, () => {
      expectCity(raw, cityId, via);
    });
  }
});

describe('resolveCity — inflected forms', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['u Novom Sadu', 'novi-sad'],
    ['Novom Sadu', 'novi-sad'],
    ['Novog Sada', 'novi-sad'],
    ['NOVOG SADA', 'novi-sad'],
    ['u Čačku', 'cacak'],
    ['Čačka', 'cacak'],
    ['u Beogradu', 'beograd'],
    ['iz Beograda', 'beograd'],
    ['u Kragujevcu', 'kragujevac'],
    ['Kragujevca', 'kragujevac'],
    ['u Nišu', 'nis'],
    ['u Nisu', 'nis'],
    ['Novom Pazaru', 'novi-pazar'],
    ['u Užicu', 'uzice'],
    ['у Београду', 'beograd'],
    ['Крагујевцу', 'kragujevac'],
  ];

  for (const [raw, cityId] of cases) {
    it(`resolves "${raw}" to ${cityId}`, () => {
      const match = resolveCity(raw);
      expect(match?.cityId).toBe(cityId);
      expect(match?.confidence).toBeGreaterThanOrEqual(0.9);
    });
  }
});

describe('resolveCity — Belgrade city municipalities', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Beograd - Zemun', 'beograd-zemun'],
    ['Beograd-Zemun', 'beograd-zemun'],
    ['Beograd (Zemun)', 'beograd-zemun'],
    ['Zemun, Beograd', 'beograd-zemun'],
    ['Beograd / Vračar', 'beograd-vracar'],
    ['Beograd — Novi Beograd', 'beograd-novi-beograd'],
    ['Београд - Земун', 'beograd-zemun'],
    ['Beograd, Palilula', 'beograd-palilula'],
    ['Beograd - Savski Venac', 'beograd-savski-venac'],
    ['Beograd - Stari Grad', 'beograd-stari-grad'],
  ];

  for (const [raw, cityId] of cases) {
    it(`resolves "${raw}" to ${cityId} under beograd`, () => {
      const match = resolveCity(raw);
      expect(match?.cityId).toBe(cityId);
      expect(match?.municipalityId).toBe('beograd');
    });
  }

  it('keeps a bare Beograd on the city itself', () => {
    const match = expectCity('Beograd', 'beograd', 'exact');
    expect(match?.municipalityId).toBe('beograd');
  });

  it('does not read a Niš city municipality as the Belgrade one of the same name', () => {
    // Niš's five city municipalities are not local self-government units and
    // are not in the geo dataset, so the city has to win the tie.
    const match = resolveCity('Niš - Palilula');
    expect(match?.cityId).toBe('nis');
    expect(match?.municipalityId).toBe('nis');
  });
});

describe('resolveCity — villages, suburbs and city districts', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['Kaluđerica', 'beograd-grocka', 'beograd'],
    ['Kaludjerica', 'beograd-grocka', 'beograd'],
    ['u Kaluđerici', 'beograd-grocka', 'beograd'],
    ['Batajnica', 'beograd-zemun', 'beograd'],
    ['Borča', 'beograd-palilula', 'beograd'],
    ['Železnik', 'beograd-cukarica', 'beograd'],
    ['Ripanj', 'beograd-vozdovac', 'beograd'],
    ['Petrovaradin', 'novi-sad', 'novi-sad'],
    ['Sremska Kamenica', 'novi-sad', 'novi-sad'],
    ['Futog', 'novi-sad', 'novi-sad'],
    ['Niška Banja', 'nis', 'nis'],
    ['Zlatibor', 'cajetina', 'cajetina'],
    ['Guča', 'lucani', 'lucani'],
    ['Palić', 'subotica', 'subotica'],
    ['Nova Pazova', 'stara-pazova', 'stara-pazova'],
    ['Sevojno', 'uzice', 'uzice'],
    ['Kostolac', 'pozarevac', 'pozarevac'],
    ['Банја Ковиљача', 'loznica', 'loznica'],
  ];

  for (const [raw, cityId, municipalityId] of cases) {
    it(`rolls "${raw}" up to ${municipalityId}`, () => {
      const match = resolveCity(raw);
      expect(match?.cityId).toBe(cityId);
      expect(match?.municipalityId).toBe(municipalityId);
      expect(match?.matchedVia).toBe('settlement');
      expect(match?.settlement).toBeDefined();
    });
  }

  it('covers at least 10 village-to-municipality cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it('prefers the village over the city it was published next to', () => {
    const match = resolveCity('Kaluđerica, Beograd');
    expect(match?.cityId).toBe('beograd-grocka');
    expect(match?.settlement).toBe('Kaluđerica');
  });
});

describe('resolveCity — addresses and noise', () => {
  it('finds the city at the end of a full address', () => {
    expectCity('Bulevar oslobođenja 12, 21000 Novi Sad', 'novi-sad', 'exact');
  });

  it('finds the city with no separator to split on', () => {
    expectCity('Bulevar oslobodjenja 12 Novi Sad', 'novi-sad', 'exact');
  });

  it('ignores a trailing country', () => {
    expectCity('Beograd, Srbija', 'beograd', 'exact');
    expectCity('Србија, Крагујевац', 'kragujevac', 'exact');
  });

  it('is not fooled by a street named after another town', () => {
    expectCity('Beogradska 15, Novi Sad', 'novi-sad', 'exact');
  });

  it('falls back to a postal code when nothing names a place', () => {
    const match = expectCity('21000', 'novi-sad', 'postal_code');
    expect(match?.confidence).toBe(0.7);
  });

  it('reads a shared Belgrade postal code as the city, not as an ambiguity', () => {
    expectCity('11000', 'beograd', 'postal_code');
  });
});

describe('resolveCity — the landline fallback', () => {
  it('uses the area code when the location string resolves to nothing', () => {
    const match = expectCity('Nepoznato mesto', 'novi-sad', 'landline', { phone: '+38121423456' });
    expect(match?.confidence).toBe(0.35);
    expect(match?.cityRaw).toBe('Nepoznato mesto');
  });

  it('accepts a national-format landline', () => {
    expectCity('', 'beograd', 'landline', { phone: '011/2345-678' });
    expectCity('', 'cacak', 'landline', { phone: '032 344 555' });
  });

  it('accepts a NormalizedPhone straight from the phone module', () => {
    const phone = normalizePhone('018/512-345');
    expect(isPhoneError(phone)).toBe(false);
    if (isPhoneError(phone)) return;
    const match = resolveCity('', { phone });
    expect(match?.cityId).toBe('nis');
    expect(match?.matchedVia).toBe('landline');
  });

  it('reads a four-digit area code as its own network group', () => {
    // Kikinda is 0230 and Zrenjanin is 023: a shortest-match read of the same
    // number would file every Kikinda lead under Zrenjanin.
    expectCity('', 'kikinda', 'landline', { phone: '0230/421-555' });
    expectCity('', 'zrenjanin', 'landline', { phone: '023/561-234' });
  });

  it('marks the fallback lower-confidence than every real match', () => {
    const landline = resolveCity('', { phone: '+38121423456' });
    const named = resolveCity('Novi Sad');
    expect(landline?.confidence).toBeLessThan(named?.confidence ?? 0);
  });

  it('never geolocates a mobile number', () => {
    expect(resolveCity('Nepoznato mesto', { phone: '+381641234567' })).toBeNull();
    expect(resolveCity('', { phone: '064/123-4567' })).toBeNull();
  });

  it('prefers the location string over the phone when both are available', () => {
    const match = resolveCity('Novi Sad', { phone: '+381112345678' });
    expect(match?.cityId).toBe('novi-sad');
  });
});

describe('resolveCityDetailed — refusing to guess', () => {
  it('says why an empty string resolved to nothing', () => {
    const result = resolveCityDetailed('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
    expect(result.detail).toContain('no location string');
  });

  it('says why an unknown place resolved to nothing', () => {
    const result = resolveCityDetailed('Neko Selo Koje Ne Postoji');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
    expect(result.cityRaw).toBe('Neko Selo Koje Ne Postoji');
  });

  it('refuses to pick between two unrelated cities', () => {
    const result = resolveCityDetailed('Novi Sad i Beograd');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
    expect(result.candidates).toEqual(['novi-sad', 'beograd']);
  });

  it('always echoes the published string back for lead.city_raw', () => {
    const raw = '  Bulevar oslobođenja 12,  21000 Novi Sad  ';
    const result = resolveCityDetailed(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.cityRaw).toBe('Bulevar oslobođenja 12, 21000 Novi Sad');
  });
});

describe('the settlement dataset', () => {
  it('points every settlement at a municipality that exists', () => {
    for (const settlement of settlements) {
      expect(getMunicipalityById(settlement.municipality_id), settlement.name).toBeDefined();
    }
  });

  it('never shadows a municipality name', () => {
    const municipalityKeys = new Set(
      municipalities.flatMap((municipality) =>
        [
          municipality.name_sr,
          municipality.name_ascii,
          municipality.name_cyrillic,
          ...municipality.search_variants,
          ...municipality.search_variants_cyrillic,
        ].map(foldForComparison),
      ),
    );
    for (const settlement of settlements) {
      expect(municipalityKeys.has(foldForComparison(settlement.name)), settlement.name).toBe(false);
    }
  });

  it('lists every settlement name once', () => {
    const seen = new Map<string, Settlement>();
    for (const settlement of settlements) {
      const key = foldForComparison(settlement.name);
      expect(seen.get(key)?.name, settlement.name).toBeUndefined();
      seen.set(key, settlement);
    }
  });

  it('resolves every settlement it lists', () => {
    for (const settlement of settlements) {
      const match = resolveCity(settlement.name);
      expect(match?.municipalityId, settlement.name).toBe(
        getMunicipalityById(settlement.municipality_id)?.parent_id ?? settlement.municipality_id,
      );
    }
  });
});
