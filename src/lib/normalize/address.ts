/**
 * Street-address normalization — the corroborating deduplication key.
 *
 * An address is never decisive: two firms share a building often enough that a
 * matching address only ever *corroborates* a name match. But it has to work at
 * all, and byte-exact comparison does not. Two sources almost never agree down
 * to the comma:
 *
 * ```
 * Temerinska 12, 21000 Novi Sad
 * Temerinska 12, 21000, Novi Sad
 * Ul. Temerinska br. 12, Novi Sad
 * ТЕМЕРИНСКА 12, НОВИ САД
 * ```
 *
 * One business, four spellings, and `address.toLowerCase()` on both sides makes
 * them four addresses. Every pair that needed the address as its second signal
 * then stalls in `review` — which is exactly the corroboration rule 4 in
 * `src/lib/dedup/score.ts` is built on.
 *
 * So every address gets the same two lives a company name gets in `name.ts`:
 *
 * - `display` — as published, Cyrillic and diacritics intact.
 * - `normalized` / `ascii` — the matching keys nobody ever sees. `ascii` is what
 *   goes into `leads.address_normalized`, and it is what two records are
 *   compared on.
 *
 * ## What it does not do
 *
 * It does not decide a merge — it produces a key and a similarity score, and
 * `src/lib/dedup` weighs them. And it deliberately stops short of the
 * normalizations that would lose an address rather than clean it:
 *
 * - **The house number is never touched.** `Temerinska 12` and `Temerinska 12a`
 *   are two buildings, and so are `12` and `21`. A conflict there is a hard
 *   zero, not a small penalty.
 * - **A street type word stays.** `Futoška 42` and `Futoški put 42` are two
 *   different Novi Sad addresses; only the pure markers that carry no name
 *   (`ul.`, `br.`) are dropped, and the abbreviations that do (`bul.`) are
 *   expanded rather than removed.
 * - **An address with no house number is not an address**, for corroboration
 *   purposes: `Bulevar oslobođenja` is four kilometres long. Such a pair scores
 *   below the recommended threshold by construction.
 *
 * ## The postal code is not part of the key
 *
 * It is recorded in its own field, and left out of `ascii`, because sources
 * disagree about whether to print it at all and the locality it encodes is
 * already in the key as a `data/serbia-geo.json` municipality id. Keeping it
 * would put `Temerinska 12, Novi Sad` and `Temerinska 12, 21000 Novi Sad` back
 * on two different keys, which is the bug this module exists to fix.
 */
import { hasCyrillic, toLatin } from '../text/cyrillic.js';
import { foldDiacritics, foldForComparison, normalizeWhitespace } from '../text/fold.js';
import { getMunicipalityById } from '../geo.js';
import { resolveCityDetailed } from './city.js';
import { characterSimilarity } from './name.js';

export interface NormalizedAddress {
  /** The address as published, whitespace-cleaned and nothing else. */
  readonly display: string;
  /** Matching key: Latin, lower-case, diacritics kept, markers folded. Human-readable. */
  readonly normalized: string;
  /**
   * `normalized` with diacritics folded and the locality replaced by its
   * municipality id — the value to write to `leads.address_normalized`.
   */
  readonly ascii: string;
  /** The street name alone, ASCII-folded, with the house number and markers removed. */
  readonly street: string;
  /** The ASCII street tokens `normalizedAddressSimilarity` compares. */
  readonly tokens: readonly string[];
  /** `12`, `12a`, `12-14`, or `bb` for *bez broja*. Absent when the source gave none. */
  readonly houseNumber?: string;
  /** Flat, floor or entrance after a `/`. Recorded, never compared — same building. */
  readonly unit?: string;
  /** The five-digit postal code, if the source printed one. Not part of `ascii`. */
  readonly postalCode?: string;
  /** The place the address is in, as published (Latin). */
  readonly locality?: string;
  /** `locality` resolved to a `data/serbia-geo.json` municipality id — `novi-sad`. */
  readonly localityId?: string;
}

/**
 * The score at or above which `src/lib/dedup` may treat two addresses as the
 * same address. Measured against the corpora in `address.test.ts`, not guessed:
 * every true-positive pair there scores at or above it and every
 * true-negative pair scores below, with the gap asserted.
 */
export const RECOMMENDED_ADDRESS_MATCH_THRESHOLD = 0.85;

/**
 * Pure markers: they mean "what follows is a street" or "what follows is a
 * number" and are omitted as often as they are written. `Ul. Temerinska br. 12`
 * and `Temerinska 12` are one address.
 */
const MARKER_TOKENS: ReadonlySet<string> = new Set(['ul', 'ulica', 'br', 'broj', 'no', 'kbr']);

/**
 * Abbreviations that stand for a word which is part of the street name. These
 * are expanded, never dropped — `Bulevar oslobođenja` is not `oslobođenja`.
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  bul: 'bulevar',
  bulv: 'bulevar',
  blv: 'bulevar',
  bulevara: 'bulevar',
  nas: 'naselje',
  naselja: 'naselje',
  puta: 'put',
  trga: 'trg',
};

/** Words that name the country rather than the place, and never belong in a key. */
const COUNTRY_TOKENS: ReadonlySet<string> = new Set([
  'srbija',
  'srbiji',
  'serbia',
  'republika',
  'republike',
  'rs',
]);

/** `bez broja` — a building with no number. A real value, and not equal to any number. */
const NO_NUMBER = 'bb';

const SEGMENT_SPLIT = /[,;\n]+/u;
const POSTAL_CODE = /^\d{5}$/u;
/** `12`, `12a`, `12-14`, `12/3`, `12a/3`. The letter suffix is significant; the unit is not. */
const HOUSE_NUMBER = /^(\d{1,4}[a-z]{0,2})(?:[-–](\d{1,4}[a-z]{0,2}))?(?:\/([\da-z]{1,4}))?$/u;
/** The longest place name in the geo dataset is three words (`Petrovac na Mlavi`). */
const MAX_LOCALITY_WORDS = 3;

/** How much a missing house number costs. Enough to put a perfect street below the threshold. */
const NO_HOUSE_NUMBER_DISCOUNT = 0.8;
/** Two street tokens count as the same word above this character-level similarity. */
const TOKEN_MATCH_MIN = 0.85;

/**
 * Split a raw address into a display form, a matching key and the parts a
 * comparison needs to keep apart.
 *
 * `Ul. Temerinska br. 12/3, 21000 Novi Sad` → street `temerinska`, houseNumber
 * `12`, unit `3`, postalCode `21000`, localityId `novi-sad`, ascii
 * `temerinska 12, novi-sad`.
 */
export function normalizeAddress(raw: string): NormalizedAddress {
  const display = normalizeWhitespace(raw ?? '');
  const latin = hasCyrillic(display) ? toLatin(display) : display;

  const segments = latin
    .split(SEGMENT_SPLIT)
    .map((segment) => normalizeWhitespace(segment))
    .filter((segment) => segment !== '');

  const place = takePlaceSegments(segments);
  const street = parseStreet(place.rest.length > 0 ? (place.rest[0] as string) : '');

  // The locality can also sit inside the street segment with no comma at all —
  // `Temerinska 12 21000 Novi Sad`.
  const inline = street.locality ?? null;
  const locality = place.locality ?? inline;
  const postalCode = place.postalCode ?? street.postalCode ?? null;

  // A postal code names a place on its own, so `Temerinska 12, 21000` lands on
  // the same key as `Temerinska 12, Novi Sad` rather than on a third one.
  const localityId =
    (locality === null ? undefined : resolveLocality(locality)) ?? postalMunicipality(postalCode);

  // The unit is deliberately not in the key: a flat number tells two offices in
  // one building apart, and one building is exactly what the address signal is
  // allowed to say. It is kept as a field so an exporter can print it.
  const streetWithNumber = [street.normalized, street.houseNumber]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');

  const localityKey = localityId ?? (locality === null ? null : foldForComparison(locality));
  const normalized =
    locality === null ? streetWithNumber : `${streetWithNumber}, ${lower(locality)}`;
  const ascii =
    localityKey === null
      ? foldDiacritics(streetWithNumber)
      : `${foldDiacritics(streetWithNumber)}, ${localityKey}`;

  return {
    display,
    normalized,
    ascii,
    street: foldDiacritics(street.normalized),
    tokens: street.tokens,
    ...(street.houseNumber === null ? {} : { houseNumber: street.houseNumber }),
    ...(street.unit === null ? {} : { unit: street.unit }),
    ...(postalCode === null ? {} : { postalCode }),
    ...(locality === null ? {} : { locality }),
    ...(localityId === undefined ? {} : { localityId }),
  };
}

/**
 * How alike two addresses are, 0–1.
 *
 * A conflicting house number or a conflicting locality is a hard zero: those
 * are not near-misses, they are different buildings and different towns. What
 * is scored is the street name, discounted when either side never gave a house
 * number. A merge decision is never made here — see
 * `RECOMMENDED_ADDRESS_MATCH_THRESHOLD`.
 */
export function addressSimilarity(a: string, b: string): number {
  return normalizedAddressSimilarity(normalizeAddress(a), normalizeAddress(b));
}

/** `addressSimilarity` for addresses the caller has already normalized. */
export function normalizedAddressSimilarity(
  a: NormalizedAddress | null,
  b: NormalizedAddress | null,
): number {
  if (a == null || b == null) return 0;
  if (a.tokens.length === 0 || b.tokens.length === 0) return 0;
  if (localityConflict(a, b)) return 0;
  if (a.houseNumber !== undefined && b.houseNumber !== undefined && a.houseNumber !== b.houseNumber)
    return 0;

  const street = streetSimilarity(a.tokens, b.tokens);
  const complete = a.houseNumber !== undefined && b.houseNumber !== undefined;
  return round(complete ? street : street * NO_HOUSE_NUMBER_DISCOUNT);
}

/**
 * Two addresses placed in two different municipalities.
 *
 * Compared on the municipality id rather than the text, so `Zemun` and
 * `Beograd` are one place — they roll up to the same local self-government
 * unit, and a business with a yard in one writes its address as either. When
 * neither side resolved, the folded text is all there is.
 */
function localityConflict(a: NormalizedAddress, b: NormalizedAddress): boolean {
  if (a.localityId !== undefined && b.localityId !== undefined)
    return a.localityId !== b.localityId;
  if (a.localityId !== undefined || b.localityId !== undefined) return false;
  if (a.locality === undefined || b.locality === undefined) return false;
  return foldForComparison(a.locality) !== foldForComparison(b.locality);
}

/**
 * Weighted token overlap over the street name, against the longer of the two.
 *
 * Against the longer, not the average, because an extra token in a street name
 * is usually a different street: `Futoška` and `Futoški put` share a word and
 * are two roads. That makes the measure conservative, which is the direction to
 * be wrong in — a missed corroboration leaves a pair in `review`, a false one
 * merges two businesses.
 */
function streetSimilarity(a: readonly string[], b: readonly string[]): number {
  const pairs: Array<{ readonly ai: number; readonly bi: number; readonly sim: number }> = [];
  for (const [ai, tokenA] of a.entries()) {
    for (const [bi, tokenB] of b.entries()) {
      const sim = characterSimilarity(tokenA, tokenB);
      if (sim >= TOKEN_MATCH_MIN) pairs.push({ ai, bi, sim });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let matched = 0;
  for (const pair of pairs) {
    if (usedA.has(pair.ai) || usedB.has(pair.bi)) continue;
    usedA.add(pair.ai);
    usedB.add(pair.bi);
    matched += pair.sim;
  }
  return matched / Math.max(a.length, b.length);
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

interface PlaceSegments {
  /** The segments that are not the place — the first one is the street. */
  readonly rest: readonly string[];
  readonly locality: string | null;
  readonly postalCode: string | null;
}

/**
 * Peel the place off both ends of a comma-separated address.
 *
 * Sources write it at either end — `Temerinska 12, Novi Sad` and
 * `Novi Sad, Temerinska 12` — and some write it twice, once as a postal code
 * and once as a name. A segment is only peeled while at least one remains, so
 * an address that *is* nothing but a place name keeps it as the street rather
 * than normalizing to the empty string.
 */
function takePlaceSegments(segments: readonly string[]): PlaceSegments {
  let rest = [...segments];
  let locality: string | null = null;
  let postalCode: string | null = null;

  const take = (from: 'front' | 'back'): boolean => {
    if (rest.length < 2) return false;
    const segment = (from === 'front' ? rest[0] : rest[rest.length - 1]) as string;
    const read = readPlaceSegment(segment);
    if (read === null) return false;
    locality ??= read.locality;
    postalCode ??= read.postalCode;
    rest = from === 'front' ? rest.slice(1) : rest.slice(0, -1);
    return true;
  };

  while (take('back')) {
    /* peel every trailing place segment: `…, 21000, Novi Sad, Srbija` */
  }
  while (take('front')) {
    /* and every leading one: `Novi Sad, Temerinska 12` */
  }
  return { rest, locality, postalCode };
}

/** A segment that names a place, a postal code, or the country — and nothing else. */
function readPlaceSegment(
  segment: string,
): { locality: string | null; postalCode: string | null } | null {
  const words = segment.split(/\s+/u).filter((word) => word !== '');
  const postalCode = words.find((word) => POSTAL_CODE.test(word)) ?? null;
  const remaining = words.filter(
    (word) => !POSTAL_CODE.test(word) && !COUNTRY_TOKENS.has(foldForComparison(word)),
  );

  // Nothing but a postal code, or nothing but `Srbija` — a place segment that
  // happens to name no place.
  if (remaining.length === 0) return { locality: null, postalCode };
  const name = remaining.join(' ');
  return isPlaceName(name) ? { locality: name, postalCode } : null;
}

interface ParsedStreet {
  /** Lower-case Latin, diacritics kept, markers dropped and abbreviations expanded. */
  readonly normalized: string;
  readonly tokens: readonly string[];
  readonly houseNumber: string | null;
  readonly unit: string | null;
  readonly postalCode: string | null;
  readonly locality: string | null;
}

/**
 * Read one segment as `street name` + `house number`.
 *
 * The house number is the *last* number-shaped word, which is what keeps a
 * street named after a date whole: `27. marta 15` is number 15 in `27. marta`,
 * not number 27 in `marta 15`.
 */
function parseStreet(segment: string): ParsedStreet {
  const words = segment
    .split(/\s+/u)
    .map((word) => trimPunctuation(word))
    .filter((word) => word !== '');

  const postalCode = words.find((word) => POSTAL_CODE.test(word)) ?? null;
  let rest = words.filter((word) => !POSTAL_CODE.test(word));

  // A locality with no comma in front of it — `Temerinska 12 21000 Novi Sad`.
  const inline = takeTrailingLocality(rest);
  rest = inline.rest;

  let houseNumber: string | null = null;
  let unit: string | null = null;
  for (let at = rest.length - 1; at >= 0; at -= 1) {
    const word = rest[at] as string;
    const parsed = readHouseNumber(word);
    if (parsed === null) continue;
    houseNumber = parsed.houseNumber;
    unit = parsed.unit;
    rest = rest.slice(0, at);
    break;
  }

  const tokens = rest
    .map((word) => lower(word))
    .filter((word) => !MARKER_TOKENS.has(foldDiacritics(word)))
    .map((word) => ABBREVIATIONS[foldDiacritics(word)] ?? word);

  return {
    normalized: tokens.join(' '),
    tokens: tokens.map((token) => foldDiacritics(token)),
    houseNumber,
    unit,
    postalCode,
    locality: inline.locality,
  };
}

/** `12` → `12`; `12a/3` → `12a` plus unit `3`; `bb` → `bb`. */
function readHouseNumber(word: string): { houseNumber: string; unit: string | null } | null {
  const folded = foldForComparison(word).replace(/\./gu, '');
  if (folded === NO_NUMBER) return { houseNumber: NO_NUMBER, unit: null };
  const match = HOUSE_NUMBER.exec(folded);
  if (match === null) return null;
  const first = match[1] as string;
  const second = match[2];
  return {
    houseNumber: second === undefined ? first : `${first}-${second}`,
    unit: match[3] ?? null,
  };
}

/** The place name a run of words ends with, when something is left in front of it. */
function takeTrailingLocality(words: readonly string[]): {
  rest: string[];
  locality: string | null;
} {
  const longest = Math.min(MAX_LOCALITY_WORDS, words.length - 1);
  for (let size = longest; size >= 1; size -= 1) {
    const window = words.slice(words.length - size).join(' ');
    if (!isPlaceName(window)) continue;
    return { rest: words.slice(0, words.length - size), locality: window };
  }
  return { rest: [...words], locality: null };
}

/** A digit anywhere means a house number or a postal code, never a place name. */
const HAS_DIGIT = /\d/u;

/**
 * Does this string name a place this project knows?
 *
 * `resolveCityDetailed` is the authority — the same index the `city_id` on the
 * lead came from, so an address and a city field can never disagree about what
 * `Novom Sadu` means. Its landline fallback is not reachable here (no phone is
 * passed), and a street name does not resolve: `Temerinska 12`,
 * `Bulevar oslobođenja 5` and `Beogradska 5` are all `no_match`, which is what
 * makes peeling by resolution safe.
 */
function isPlaceName(value: string): boolean {
  // The resolver reads `12 Novi Sad` as Novi Sad — it is built to find a place
  // inside a messy string, and a house number is exactly the kind of noise it
  // ignores. Here that would swallow the number, so a window with a digit in it
  // is never a place.
  return !HAS_DIGIT.test(value) && resolveLocality(value) !== undefined;
}

/**
 * The municipality a place name rolls up to — `Zemun` and `Beograd` are both
 * `beograd`.
 *
 * Memoized because parsing one address asks the question up to four times (once
 * per comma-separated segment, once per trailing word window) and the geo
 * resolver walks its index each time. The set of distinct strings a crawl asks
 * about is small — a few hundred place names and a few thousand street names.
 */
const localityCache = new Map<string, string | undefined>();

function resolveLocality(value: string): string | undefined {
  const key = foldForComparison(value);
  if (localityCache.has(key)) return localityCache.get(key);
  const id = resolveLocalityUncached(key, value);
  localityCache.set(key, id);
  return id;
}

function resolveLocalityUncached(key: string, value: string): string | undefined {
  // A key this module wrote earlier — `temerinska 12, novi-sad` — is read back
  // by `from-db.ts` on every comparison, so the id it prints has to resolve to
  // itself. Without this, a stored address would lose its town on re-read and
  // two `Kralja Petra 12` in two cities would stop conflicting.
  const byId = getMunicipalityById(key);
  if (byId !== undefined) return byId.parent_id ?? byId.id;
  const resolution = resolveCityDetailed(value);
  return resolution.ok ? resolution.match.municipalityId : undefined;
}

/** The municipality a lone postal code points at, when no name was published. */
function postalMunicipality(postalCode: string | null): string | undefined {
  return postalCode === null ? undefined : resolveLocality(postalCode);
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Punctuation only ever wraps a word here; `12/3` and `27.` keep what matters. */
function trimPunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}/-]+$/u, '');
}

function lower(value: string): string {
  return value.toLocaleLowerCase('sr-Latn-RS');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
