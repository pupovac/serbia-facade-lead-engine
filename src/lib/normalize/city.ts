/**
 * Free-text location → a `data/serbia-geo.json` municipality id.
 *
 * Sources publish a location in whatever field they had: `Novi Sad`,
 * `u Novom Sadu`, `21000 Novi Sad`, `Beograd - Zemun`, `Kaluđerica`,
 * `Bulevar oslobođenja 12, Нови Сад`. All of those are the same two slugs to us:
 * `city_id` (the most specific unit matched) and `municipality_id` (the local
 * self-government unit it rolls up to).
 *
 * **A wrong city is worse than an empty one.** Sales calls are organised by
 * city, so a lead filed under the wrong one is worked by the wrong person and
 * never recovered, while a lead with no city is still a phone number someone
 * can call. Every branch below therefore prefers `null` — with a reason — over
 * a guess, and the landline fallback is marked low-confidence rather than
 * treated as a match.
 */
import settlementData from '../../../data/serbia-settlements.json' with { type: 'json' };
import {
  findMunicipalitiesByName,
  getMunicipalityById,
  landlineGroupCenter,
  municipalities,
  municipalitiesByLandlinePrefix,
  type Municipality,
} from '../geo.js';
import { hasCyrillic, toLatin } from '../text/cyrillic.js';
import { foldForComparison, normalizeWhitespace } from '../text/fold.js';

export type CityMatchMethod =
  /** The string names a municipality outright: `Novi Sad`, `Нови Сад`, `Cacak`. */
  | 'exact'
  /** An inflected case form from the geo dataset: `u Novom Sadu`, `Čačka`. */
  | 'inflected'
  /** A city + city-municipality pair: `Beograd - Zemun`, `Niš, Palilula`. */
  | 'compound'
  /** A village, suburb or city district that rolls up: `Kaluđerica` → Grocka. */
  | 'settlement'
  /** Nothing named a place, but a postal code identified one seat uniquely. */
  | 'postal_code'
  /** Last resort: the landline area code of the lead's phone. Low confidence. */
  | 'landline';

export interface CityMatch {
  /** Most specific `data/serbia-geo.json` id matched — `beograd-zemun`, `novi-sad`. */
  readonly cityId: string;
  /** The local self-government unit `cityId` rolls up to — `beograd`, `novi-sad`. */
  readonly municipalityId: string;
  /** The location string as published, whitespace-cleaned. Goes to `leads.city_raw`. */
  readonly cityRaw: string;
  readonly matchedVia: CityMatchMethod;
  /** 0–1. How sure the match is, not how good the lead is. */
  readonly confidence: number;
  /** The settlement that produced the match, canonically spelled. */
  readonly settlement?: string;
}

export type CityFailureReason =
  /** Nothing to resolve, and no phone to fall back on. */
  | 'empty'
  /** Nothing in the string names a place this dataset knows. */
  | 'no_match'
  /** Two or more unrelated municipalities match equally well. */
  | 'ambiguous';

export type CityResolution =
  | { readonly ok: true; readonly match: CityMatch }
  | {
      readonly ok: false;
      readonly cityRaw: string;
      readonly reason: CityFailureReason;
      /** Human-readable explanation, safe to log and to show in the review UI. */
      readonly detail: string;
      /** The municipality ids that tied, when the reason is `ambiguous`. */
      readonly candidates?: readonly string[];
    };

/** A phone the lead already carries, used only as a fallback location signal. */
export interface CityHint {
  /**
   * `+38121123456`, `021/123-456` or the object `src/lib/phone` produces. Only
   * the landline area code is read; a mobile number says nothing about a city.
   */
  readonly phone?: PhoneLike | undefined;
}

export type PhoneLike =
  | string
  | {
      readonly e164?: string | null | undefined;
      readonly nationalFormat?: string | null | undefined;
    };

export interface Settlement {
  readonly name: string;
  readonly municipality_id: string;
  readonly kind: 'settlement' | 'neighbourhood' | 'city_district';
}

/** Villages, suburbs and city districts that resolve to a municipality. */
export const settlements: readonly Settlement[] =
  settlementData.settlements as readonly Settlement[];

const CONFIDENCE: Readonly<Record<CityMatchMethod, number>> = {
  exact: 1,
  compound: 0.95,
  inflected: 0.9,
  settlement: 0.85,
  postal_code: 0.7,
  landline: 0.35,
};

/** Words that surround a place name without being part of it. */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  'u',
  'na',
  'iz',
  'kod',
  'blizu',
  'grad',
  'gradu',
  'opstina',
  'opstini',
  'opstine',
  'mesto',
  'naselje',
  'selo',
  'srbija',
  'srbiji',
  'serbia',
  'republika',
  'rs',
  'bb',
  'br',
  'ul',
  'ulica',
]);

const SEGMENT_SPLIT = /[,;|/\\()[\]\-–—]+/u;
const POSTAL_CODE = /\b\d{5}\b/gu;
/** The longest place name in the dataset is three words (`Petrovac na Mlavi`). */
const MAX_NAME_WORDS = 3;

/**
 * Resolve a location string to municipality ids, or explain why it could not be.
 *
 * The detailed form. `resolveCity` is the same function with the reason dropped.
 */
export function resolveCityDetailed(raw: string, hint?: CityHint): CityResolution {
  const cityRaw = normalizeWhitespace(raw ?? '');
  const latin = hasCyrillic(cityRaw) ? toLatin(cityRaw) : cityRaw;
  const postalCodes = [...latin.matchAll(POSTAL_CODE)].map((match) => match[0]);

  const candidates = collectCandidates(latin);
  if (candidates.length > 0) {
    const resolved = pickBest(candidates, postalCodes);
    if (resolved.ok) return { ok: true, match: { ...resolved.match, cityRaw } };
    return { ...resolved, cityRaw };
  }

  const byPostal = uniqueByPostalCode(postalCodes);
  if (byPostal !== undefined) {
    return { ok: true, match: toMatch(byPostal, 'postal_code', cityRaw) };
  }

  const byLandline = resolveFromPhone(hint?.phone);
  if (byLandline !== undefined) {
    return { ok: true, match: toMatch(byLandline, 'landline', cityRaw) };
  }

  return cityRaw === ''
    ? {
        ok: false,
        cityRaw,
        reason: 'empty',
        detail: 'no location string and no phone to fall back on',
      }
    : {
        ok: false,
        cityRaw,
        reason: 'no_match',
        detail: `nothing in "${cityRaw}" names a municipality, settlement or postal code this dataset knows`,
      };
}

/**
 * The best municipality for a location string, or `null` when it cannot be
 * resolved confidently. Use `resolveCityDetailed` when you need the reason.
 */
export function resolveCity(raw: string, hint?: CityHint): CityMatch | null {
  const resolution = resolveCityDetailed(raw, hint);
  return resolution.ok ? resolution.match : null;
}

/** How a candidate was found; lower `rank` is stronger evidence. Ties are settled by `pickBest`. */
interface Candidate {
  readonly municipality: Municipality;
  readonly method: CityMatchMethod;
  readonly rank: number;
  /** Which reading of the string produced it, and the word span it covers. */
  readonly listId: number;
  readonly start: number;
  readonly end: number;
  readonly settlement?: string;
}

const RANK = {
  wholeExact: 0,
  wholeInflected: 1,
  windowExact: 2,
  windowInflected: 3,
  settlement: 4,
};

function collectCandidates(latin: string): Candidate[] {
  const found: Candidate[] = [];
  const segments = [latin, ...latin.split(SEGMENT_SPLIT)];

  let listId = 0;
  for (const segment of segments) {
    // `Petrovac na Mlavi` contains a word that is noise everywhere else, so the
    // segment is tried untouched before the noise words are taken out.
    for (const words of wordVariants(segment)) {
      collectFromWords(words, found, listId);
      listId += 1;
    }
  }
  return dropContainedSpans(found);
}

/**
 * `Mali Požarevac` is a village near Belgrade, not the city of Požarevac with a
 * word in front of it, and `Padinska Skela` is not `Skela`. Whenever one
 * candidate's words sit entirely inside another's, the longer reading is the
 * right one and the shorter is dropped — however strong its evidence looked.
 */
function dropContainedSpans(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.listId === candidate.listId &&
          other.end - other.start > candidate.end - candidate.start &&
          other.start <= candidate.start &&
          other.end >= candidate.end,
      ),
  );
}

/** Look one word list up whole, then every place-name-sized window inside it. */
function collectFromWords(words: readonly string[], found: Candidate[], listId: number): void {
  if (words.length === 0) return;
  const whole = words.join(' ');
  const span = { listId, start: 0, end: words.length };

  for (const municipality of findMunicipalitiesByName(whole)) {
    const exact = isNominative(municipality, whole);
    found.push({
      municipality,
      method: exact ? 'exact' : 'inflected',
      rank: exact ? RANK.wholeExact : RANK.wholeInflected,
      ...span,
    });
  }

  // `Bulevar oslobođenja 12 Novi Sad` has no separator to split on, so the
  // place name has to be found inside the segment.
  for (let size = Math.min(MAX_NAME_WORDS, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const window = words.slice(start, start + size).join(' ');
      const windowSpan = { listId, start, end: start + size };
      if (window !== whole) {
        for (const municipality of findMunicipalitiesByName(window)) {
          const exact = isNominative(municipality, window);
          found.push({
            municipality,
            method: exact ? 'exact' : 'inflected',
            rank: exact ? RANK.windowExact : RANK.windowInflected,
            ...windowSpan,
          });
        }
      }
      const settlement = findSettlement(window);
      if (settlement !== undefined) {
        const municipality = getMunicipalityById(settlement.municipality_id);
        if (municipality !== undefined) {
          found.push({
            municipality,
            method: 'settlement',
            rank: RANK.settlement,
            settlement: settlement.name,
            ...windowSpan,
          });
        }
      }
    }
  }
}

/** The segment's words as published, and again with the filler words removed. */
function wordVariants(segment: string): string[][] {
  const raw = splitWords(segment);
  const cleaned = raw.filter((word) => !NOISE_WORDS.has(foldForComparison(word)));
  return cleaned.length === raw.length ? [raw] : [raw, cleaned];
}

/**
 * The strongest candidate, or an `ambiguous` failure.
 *
 * Two municipalities can tie legitimately. `Beograd - Zemun` names a city and
 * one of its own city municipalities, and the specific one is the answer.
 * `Niš, Palilula` names a city and a city municipality of a *different* city —
 * Niš's Palilula is not a local self-government unit and is not in the dataset,
 * so the city wins and the confidence drops. Anything else that ties is a real
 * ambiguity and resolves to nothing.
 */
function pickBest(
  candidates: readonly Candidate[],
  postalCodes: readonly string[],
): CityResolution {
  const bestRank = Math.min(...candidates.map((candidate) => candidate.rank));
  const top = candidates.filter((candidate) => candidate.rank === bestRank);
  const byId = new Map(top.map((candidate) => [candidate.municipality.id, candidate]));

  if (byId.size === 1) {
    const only = top[0] as Candidate;
    return { ok: true, match: refine(only, candidates) };
  }

  const ids = [...byId.keys()];
  const child = [...byId.values()].find(
    (candidate) =>
      candidate.municipality.parent_id !== null && byId.has(candidate.municipality.parent_id),
  );
  if (child !== undefined) {
    return { ok: true, match: toMatch(child.municipality, 'compound', '', child.settlement) };
  }

  const units = [...byId.values()].filter(
    (candidate) => candidate.municipality.type !== 'city_municipality',
  );
  if (units.length === 1) {
    const unit = units[0] as Candidate;
    const refined = refine(unit, candidates);
    return {
      ok: true,
      match:
        refined.cityId === unit.municipality.id
          ? toMatch(unit.municipality, 'compound', '')
          : refined,
    };
  }

  const postal = uniqueByPostalCode(postalCodes);
  if (postal !== undefined && byId.has(postal.id)) {
    return { ok: true, match: toMatch(postal, 'postal_code', '') };
  }

  return {
    ok: false,
    cityRaw: '',
    reason: 'ambiguous',
    detail: `matches ${ids.length} unrelated municipalities: ${ids.join(', ')}`,
    candidates: ids,
  };
}

/**
 * `Kaluđerica, Beograd` names both a city and one of its own city
 * municipalities' villages. The city matched more strongly, but the village is
 * the more specific truth, so a weaker candidate that sits *inside* the chosen
 * one wins — as long as there is exactly one such candidate.
 */
function refine(chosen: Candidate, candidates: readonly Candidate[]): CityMatch {
  const inside = new Map(
    candidates
      .filter((candidate) => candidate.municipality.parent_id === chosen.municipality.id)
      .map((candidate) => [candidate.municipality.id, candidate]),
  );
  const only = inside.size === 1 ? [...inside.values()][0] : undefined;
  if (only === undefined) {
    return toMatch(chosen.municipality, chosen.method, '', chosen.settlement);
  }
  return toMatch(
    only.municipality,
    only.method === 'settlement' ? 'settlement' : 'compound',
    '',
    only.settlement,
  );
}

function toMatch(
  municipality: Municipality,
  method: CityMatchMethod,
  cityRaw: string,
  settlement?: string,
): CityMatch {
  return {
    cityId: municipality.id,
    municipalityId: municipality.parent_id ?? municipality.id,
    cityRaw,
    matchedVia: method,
    confidence: CONFIDENCE[method],
    ...(settlement === undefined ? {} : { settlement }),
  };
}

/** True when the string is the place's nominative name rather than a case form. */
function isNominative(municipality: Municipality, value: string): boolean {
  const key = foldForComparison(value);
  return (
    key === foldForComparison(municipality.name_sr) ||
    key === foldForComparison(municipality.name_ascii) ||
    key === foldForComparison(municipality.name_cyrillic)
  );
}

/** A segment's words, with postal codes and house numbers dropped. */
function splitWords(segment: string): string[] {
  return segment
    .replace(POSTAL_CODE, ' ')
    .split(/[\s.]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && !/^\d+[a-zA-Z]?$/u.test(word));
}

const settlementIndex = new Map<string, Settlement>();
for (const settlement of settlements) {
  for (const key of settlementKeys(settlement.name)) {
    if (!settlementIndex.has(key)) settlementIndex.set(key, settlement);
  }
}

/**
 * A settlement name plus the case forms a listing writes it in. Serbian
 * feminine names in `-a` inflect predictably (`Kaluđerica` → `u Kaluđerici`,
 * `iz Kaluđerice`); anything less regular is left alone rather than guessed at.
 */
function settlementKeys(name: string): string[] {
  const base = foldForComparison(name);
  const words = base.split(' ');
  const last = words[words.length - 1] ?? '';
  if (!last.endsWith('a')) return [base];
  const stem = words.slice(0, -1).join(' ');
  const prefix = stem === '' ? '' : `${stem} `;
  return [base, `${prefix}${last.slice(0, -1)}i`, `${prefix}${last.slice(0, -1)}e`];
}

function findSettlement(value: string): Settlement | undefined {
  return settlementIndex.get(foldForComparison(value));
}

const postalIndex = new Map<string, Municipality[]>();
for (const municipality of municipalities) {
  for (const code of municipality.postal_codes) {
    const slot = postalIndex.get(code);
    if (slot) slot.push(municipality);
    else postalIndex.set(code, [municipality]);
  }
}

/**
 * The one municipality a set of postal codes points at.
 *
 * Belgrade's `11000` is the seat code of the city and of several of its city
 * municipalities at once. That is not an ambiguity — they all roll up to the
 * same unit — so the local self-government unit is the answer. Codes pointing
 * at genuinely different units resolve to nothing.
 */
function uniqueByPostalCode(codes: readonly string[]): Municipality | undefined {
  const matches = new Map<string, Municipality>();
  for (const code of codes) {
    for (const municipality of postalIndex.get(code) ?? []) {
      matches.set(municipality.id, municipality);
    }
  }
  const found = [...matches.values()];
  if (found.length === 1) return found[0];
  const units = new Set(found.map((municipality) => municipality.parent_id ?? municipality.id));
  if (units.size !== 1) return undefined;
  const [unitId] = units;
  return getMunicipalityById(unitId as string);
}

/**
 * The municipality a landline area code is named after.
 *
 * A Serbian area code covers a whole RATEL network group, so this is the
 * group's centre and not necessarily the lead's own town — hence
 * `confidence: 0.35`. Mobile numbers (06x) carry no geography at all and are
 * ignored.
 */
function resolveFromPhone(phone: PhoneLike | undefined): Municipality | undefined {
  const prefix = landlinePrefixOf(phone);
  if (prefix === undefined) return undefined;
  const centre = landlineGroupCenter(prefix);
  if (centre !== undefined) return centre;
  const group = municipalitiesByLandlinePrefix(prefix);
  return group.length === 1 ? group[0] : undefined;
}

function landlinePrefixOf(phone: PhoneLike | undefined): string | undefined {
  if (phone === undefined) return undefined;
  const raw = typeof phone === 'string' ? phone : (phone.e164 ?? phone.nationalFormat ?? '');
  if (raw === null || raw === '') return undefined;
  const national = raw
    .replace(/\D/gu, '')
    .replace(/^(00)?381/u, '')
    .replace(/^0/u, '');
  // 06x is mobile: it tells us the operator, never the town.
  if (national.length < 3 || national.startsWith('6')) return undefined;
  return `0${national.slice(0, 2)}`;
}
