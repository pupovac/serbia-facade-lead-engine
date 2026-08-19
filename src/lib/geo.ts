/**
 * Serbian geographic coverage — the canonical crawl target list.
 *
 * `data/serbia-geo.json` holds all 145 Serbian local self-government units plus
 * the 17 city municipalities of Belgrade. Every geographic crawl iterates over
 * it, so the helpers here are deliberately narrow: look a place up, or walk the
 * list in the order that produces usable leads soonest.
 *
 * Name lookup is diacritic-insensitive and inflection-aware. Serbian listings
 * say "fasader u Novom Sadu", not "fasader Novi Sad", so `Novom Sadu`,
 * `Novi Sad`, `novog sada` and `Нови Сад` all resolve to the same record.
 */
import geo from '../../data/serbia-geo.json' with { type: 'json' };
import { foldForComparison } from './text/fold.js';

export type MunicipalityType = 'city' | 'municipality' | 'city_municipality';
export type PriorityTier = 1 | 2 | 3;
export type Region =
  'Beogradski region' | 'Vojvodina' | 'Šumadija i Zapadna Srbija' | 'Južna i Istočna Srbija';

export interface Municipality {
  /** Stable ASCII-folded slug, e.g. `novi-sad`, `cacak`, `beograd-vracar`. */
  readonly id: string;
  /** Official name in Serbian Latin, diacritics intact. */
  readonly name_sr: string;
  /** ASCII-folded spelling: `Čačak` → `Cacak`. */
  readonly name_ascii: string;
  /** Serbian Cyrillic spelling — many Serbian directories publish only this. */
  readonly name_cyrillic: string;
  /** Nominative, locative and genitive, each in both spellings. Build queries from this. */
  readonly search_variants: readonly string[];
  /** The same three case forms in Cyrillic. */
  readonly search_variants_cyrillic: readonly string[];
  readonly type: MunicipalityType;
  /** Administrative district (upravni okrug), e.g. `Južnobački okrug`. */
  readonly district: string;
  readonly region: Region;
  /** Population of the whole unit at the census in `population_census_year`. */
  readonly population: number;
  readonly population_census_year: number;
  readonly area_km2: number | null;
  readonly settlement_count: number | null;
  /** Postal code(s) of the municipal seat, not of every settlement in the unit. */
  readonly postal_codes: readonly string[];
  /** Landline area code including the trunk zero, e.g. `021`. Shared across a network group. */
  readonly landline_prefix: string;
  /** True for the one municipality its landline network group is named after. */
  readonly landline_group_center: boolean;
  /** 1 = the 20 largest units, 2 = the rest above 20k, 3 = smaller. Crawl tier 1 first. */
  readonly priority_tier: PriorityTier;
  /** `beograd` for a Belgrade city municipality, otherwise null. */
  readonly parent_id: string | null;
}

export interface GeoMeta {
  readonly description: string;
  readonly unit_count: number;
  readonly city_municipality_count: number;
  readonly sources: ReadonlyArray<{ name: string; url: string; used_for: string }>;
}

/** Every record in the dataset: 145 local self-government units + 17 Belgrade city municipalities. */
export const municipalities: readonly Municipality[] =
  geo.municipalities as readonly Municipality[];

/** Provenance and the rules the dataset was built under. */
export const geoMeta: GeoMeta = geo._meta as GeoMeta;

const byId = new Map(municipalities.map((m) => [m.id, m]));

/**
 * Crawl order: tier 1 first, most populous first inside a tier. A run that is
 * cut short after N municipalities has still covered the N best ones.
 */
function crawlOrder(a: Municipality, b: Municipality): number {
  return a.priority_tier - b.priority_tier || b.population - a.population;
}

const ordered: readonly Municipality[] = [...municipalities].sort(crawlOrder);

const byName = new Map<string, Municipality[]>();
for (const m of ordered) {
  // Fold first, then dedupe: `Čačak` and `Cacak` are one key, not two.
  const keys = new Set(
    [
      m.name_sr,
      m.name_ascii,
      m.name_cyrillic,
      ...m.search_variants,
      ...m.search_variants_cyrillic,
    ].map(foldForComparison),
  );
  for (const key of keys) {
    const slot = byName.get(key);
    if (slot) slot.push(m);
    else byName.set(key, [m]);
  }
}

/** Look a municipality up by its slug id. */
export function getMunicipalityById(id: string): Municipality | undefined {
  return byId.get(id);
}

/**
 * Every municipality a name could refer to, in crawl order.
 *
 * Matches any spelling the dataset knows: diacritic or ASCII-folded, Latin or
 * Cyrillic, nominative or an inflected form. Case- and whitespace-insensitive.
 * Returns more than one entry only when a form is genuinely ambiguous.
 */
export function findMunicipalitiesByName(name: string): readonly Municipality[] {
  return byName.get(foldForComparison(name)) ?? [];
}

/**
 * The single best match for a name, or `undefined`.
 *
 * `Čačak`, `Cacak`, `cacak` and `Чачак` all return the same record. When a form
 * is ambiguous the highest-priority, most populous match wins.
 */
export function findMunicipalityByName(name: string): Municipality | undefined {
  return findMunicipalitiesByName(name)[0];
}

/** All municipalities in crawl order: tier ascending, population descending. */
export function municipalitiesByPriority(): readonly Municipality[] {
  return ordered;
}

/** The municipalities in one priority tier, in crawl order. */
export function municipalitiesInTier(tier: PriorityTier): readonly Municipality[] {
  return ordered.filter((m) => m.priority_tier === tier);
}

/** The municipalities in one region, in crawl order. */
export function municipalitiesInRegion(region: Region): readonly Municipality[] {
  return ordered.filter((m) => m.region === region);
}

/**
 * Every municipality sharing a landline area code, in crawl order.
 *
 * Accepts `021`, `21` or `+38121`. A Serbian area code covers a whole RATEL
 * network group, so this is usually several municipalities — see
 * `landlineGroupCenter` for the one the code is named after.
 */
export function municipalitiesByLandlinePrefix(prefix: string): readonly Municipality[] {
  const normalized = normalizeLandlinePrefix(prefix);
  return normalized === null ? [] : ordered.filter((m) => m.landline_prefix === normalized);
}

/**
 * The municipality a landline area code is named after — the best single guess
 * at a city when a landline number is the only location signal available.
 */
export function landlineGroupCenter(prefix: string): Municipality | undefined {
  return municipalitiesByLandlinePrefix(prefix).find((m) => m.landline_group_center);
}

/** The 17 city municipalities of Belgrade, in crawl order. Empty for anything else. */
export function cityMunicipalitiesOf(parentId: string): readonly Municipality[] {
  return ordered.filter((m) => m.parent_id === parentId);
}

/**
 * Every spelling of a place name worth putting in a search query: Latin
 * diacritic, Latin ASCII-folded and Cyrillic, in all three cases.
 */
export function searchTermsFor(municipality: Municipality): readonly string[] {
  return [...new Set([...municipality.search_variants, ...municipality.search_variants_cyrillic])];
}

function normalizeLandlinePrefix(prefix: string): string | null {
  const digits = prefix.replace(/\D/g, '').replace(/^(00)?381/, '');
  if (digits.length === 0) return null;
  return digits.startsWith('0') ? digits : `0${digits}`;
}
