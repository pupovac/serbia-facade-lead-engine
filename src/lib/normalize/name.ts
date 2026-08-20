/**
 * Company-name normalization — the second-tier deduplication key.
 *
 * A Serbian business name reaches us in whatever shape the directory that
 * published it happened to use: `SZR "Fasada" Novi Sad`, `FASADA doo`,
 * `Фасада д.о.о.`, `Fasada D.O.O. Novi Sad`. All four are one business, and the
 * export must still show the name its owner uses. So every name gets two lives:
 *
 * - `display` — exactly as published, Cyrillic and diacritics intact. This is
 *   what the XLSX and the review UI show.
 * - `normalized` / `ascii` — lower-cased, Latin, punctuation- and legal-form-free
 *   matching keys nobody ever sees. `ascii` is the one that goes into
 *   `leads.name_normalized`, because `Građevinar` and `Gradjevinar` have to
 *   collide on the same key.
 *
 * **This module never decides a merge.** It produces keys and a similarity
 * score; `src/lib/dedup` weighs them against the phone, the domain and the city.
 * `Fasade Marković` and `Fasade Marko` are different businesses and score far
 * apart here — see `name.test.ts` for the measured separation.
 */
import { findMunicipalityByName } from '../geo.js';
import { hasCyrillic, toLatin } from '../text/cyrillic.js';
import { foldDiacritics, normalizeWhitespace } from '../text/fold.js';

export interface NormalizedCompanyName {
  /** The published name, whitespace-cleaned and nothing else. Serbian spelling preserved. */
  readonly display: string;
  /** Matching key: Latin, lower-case, diacritics kept, legal form and trailing city removed. */
  readonly normalized: string;
  /** `normalized` with diacritics folded — the value to write to `leads.name_normalized`. */
  readonly ascii: string;
  /** Canonical spelling of the legal form found, e.g. `d.o.o.`, `szr`, `preduzetnik`. */
  readonly legalForm?: string;
  /** The quoted trade name when the source used the `SZR "Fasada" Novi Sad` pattern. */
  readonly tradeName?: string;
  /** The place name found inside the company name, as published. Feed it to `resolveCity`. */
  readonly cityHint?: string;
  /** The ASCII tokens `nameSimilarity` compares. Exposed so the dedup engine can index them. */
  readonly tokens: readonly string[];
}

/**
 * A legal form as it appears once the name has been lower-cased and split on
 * punctuation. `d.o.o.` arrives as three tokens, `doo` as one; both mean the
 * same thing and both must go.
 */
interface LegalFormRule {
  /** How the form is written back out in `legalForm`. */
  readonly canonical: string;
  /** Token sequences that spell it, longest first. */
  readonly sequences: readonly (readonly string[])[];
  /**
   * `false` for short forms that are also ordinary words or initials (`ad`,
   * `pr`): those are only stripped at the very start or the very end of the
   * name, never from the middle.
   */
  readonly anywhere: boolean;
}

const LEGAL_FORMS: readonly LegalFormRule[] = [
  { canonical: 'zanatska radnja', sequences: [['zanatska', 'radnja']], anywhere: true },
  { canonical: 'preduzetnik', sequences: [['preduzetnik']], anywhere: true },
  { canonical: 'd.o.o.', sequences: [['d', 'o', 'o'], ['doo']], anywhere: true },
  { canonical: 'sztr', sequences: [['s', 'z', 't', 'r'], ['sztr']], anywhere: true },
  { canonical: 'szr', sequences: [['s', 'z', 'r'], ['szr']], anywhere: true },
  { canonical: 'str', sequences: [['s', 't', 'r'], ['str']], anywhere: true },
  { canonical: 'sur', sequences: [['sur']], anywhere: true },
  { canonical: 'ptr', sequences: [['ptr']], anywhere: true },
  // `Fasaderski radovi PR Milan Ilić` puts the form between the trade name and
  // the owner, so `pr` and its siblings are stripped wherever they stand.
  { canonical: 'pr', sequences: [['pr']], anywhere: true },
  { canonical: 'sr', sequences: [['sr']], anywhere: true },
  { canonical: 'zr', sequences: [['zr']], anywhere: true },
  // `ad` is an ordinary syllable in the middle of a name, so only the ends.
  { canonical: 'a.d.', sequences: [['a', 'd'], ['ad']], anywhere: false },
];

/**
 * Industry and filler words. They are not removed — `Fasade Marković` must keep
 * its `fasade` so the key stays readable — but they carry a fraction of a real
 * token's weight when two names are compared, because half the businesses in
 * this market have one of them in the name.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'and',
  'bau',
  'beton',
  'braca',
  'centar',
  'co',
  'commerce',
  'company',
  'comp',
  'dom',
  'export',
  'fasada',
  'fasade',
  'fasader',
  'fasaderi',
  'fasaderske',
  'fasaderski',
  'grada',
  'gradjenje',
  'gradjevina',
  'gradjevinar',
  'gradjevinski',
  'gradjevinsko',
  'gradnja',
  'group',
  'grupa',
  'i',
  'import',
  'inzenjering',
  'invest',
  'izgradnja',
  'izolacija',
  'kompanija',
  'komerc',
  'komerce',
  'kuca',
  'materijal',
  'materijali',
  'plus',
  'prodaja',
  'projekt',
  'promet',
  'radnja',
  'radovi',
  'servis',
  'sin',
  'sinovi',
  'sistem',
  'sistemi',
  'sons',
  'stiropor',
  'stovariste',
  'termo',
  'termoizolacija',
  'trade',
  'trgovina',
  'usluge',
]);

/** Words a source glues onto a name that say nothing about which business it is. */
const NOISE_TOKENS: ReadonlySet<string> = new Set(['srbija', 'serbia', 'rs']);

const QUOTES = '"\'„“”‘’«»‹›';
const QUOTED = new RegExp(`[${QUOTES}]([^${QUOTES}]{2,})[${QUOTES}]`, 'u');
/** Everything that is not a letter or a digit separates tokens. */
const NON_TOKEN = /[^\p{L}\p{N}]+/gu;

const GENERIC_WEIGHT = 0.35;
/** Two tokens count as the same word above this character-level similarity. */
const TOKEN_MATCH_MIN = 0.85;
/**
 * Below this, a whole-string character similarity is treated as weak evidence
 * and discounted: `fasademarkovic` / `fasademarko` are 0.79 similar as strings
 * and still not the same business.
 */
const STRONG_STRING_MATCH = 0.92;
const WEAK_STRING_DISCOUNT = 0.7;

/**
 * The score at or above which `src/lib/dedup` may treat two names in the same
 * city as the same business. Measured, not guessed — `name.test.ts` asserts the
 * gap between the true-positive and true-negative corpora that produced it.
 */
export const RECOMMENDED_NAME_MATCH_THRESHOLD = 0.82;

/**
 * Split a company name into a display form and the keys used to match it.
 *
 * `SZR "Fasada" Novi Sad` → display `SZR "Fasada" Novi Sad`, normalized
 * `fasada`, legalForm `szr`, tradeName `Fasada`, cityHint `Novi Sad`.
 */
export function normalizeCompanyName(raw: string): NormalizedCompanyName {
  const display = normalizeWhitespace(raw);
  const latin = hasCyrillic(display) ? toLatin(display) : display;

  const quoted = QUOTED.exec(latin);
  const tradeName = quoted?.[1] === undefined ? undefined : normalizeWhitespace(quoted[1]);
  // A quoted trade name IS the business name; the legal form and the city sit
  // outside the quotes and are only read for their own fields.
  const matchSource = tradeName ?? latin;
  // Around a quoted trade name the legal form sits in its own fragment —
  // `Stovarište "Gradnja" pr Milan Jovanović` — so each side is read on its own.
  const outside =
    quoted === null
      ? [latin]
      : [latin.slice(0, quoted.index), latin.slice(quoted.index + quoted[0].length)];

  let tokens = tokenize(matchSource);
  let legalForm = firstLegalForm(tokenize(latin));
  let cityHint: string | undefined;

  // City and legal form can be interleaved (`Fasade Beograd doo`), so strip in
  // turns until the name stops shrinking.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = tokens.length;
    const city = stripTrailingCity(tokens);
    tokens = city.tokens;
    cityHint ??= city.cityHint;
    tokens = stripLegalForms(tokens);
    if (tokens.length === before) break;
  }
  const withoutNoise = tokens.filter((token) => !NOISE_TOKENS.has(foldDiacritics(token)));
  if (withoutNoise.length > 0) tokens = withoutNoise;

  for (const fragment of outside) {
    legalForm ??= firstLegalForm(tokenize(fragment));
    // Outside a quoted trade name the whole fragment may be the city —
    // `SZR "Fasada" Novi Sad` — which is never true of the name itself.
    cityHint ??= trailingCity(stripLegalForms(tokenize(fragment)), fragment !== latin);
  }

  const normalized = tokens.join(' ');
  return {
    display,
    normalized,
    ascii: foldDiacritics(normalized),
    ...(legalForm === undefined ? {} : { legalForm }),
    ...(tradeName === undefined ? {} : { tradeName }),
    ...(cityHint === undefined ? {} : { cityHint }),
    tokens: tokens.map((token) => foldDiacritics(token)),
  };
}

/**
 * How alike two company names are, 0–1.
 *
 * Compares the normalized token sets, discounting the industry words half this
 * market shares, and falls back to a whole-string comparison so a name written
 * as one word still matches (`Termofasade Petrović` / `Termo Fasade Petrovic`).
 * A merge decision is never made here — see `RECOMMENDED_NAME_MATCH_THRESHOLD`.
 */
export function nameSimilarity(a: string, b: string): number {
  return normalizedNameSimilarity(normalizeCompanyName(a), normalizeCompanyName(b));
}

/** `nameSimilarity` for names the caller has already normalized. */
export function normalizedNameSimilarity(
  a: NormalizedCompanyName,
  b: NormalizedCompanyName,
): number {
  const stringScore = characterSimilarity(a.tokens.join(''), b.tokens.join(''));
  if (a.tokens.length === 0 || b.tokens.length === 0) return stringScore;

  const discounted =
    stringScore >= STRONG_STRING_MATCH ? stringScore : stringScore * WEAK_STRING_DISCOUNT;
  return round(Math.max(tokenSimilarity(a.tokens, b.tokens), discounted));
}

/** Weighted token overlap: every token pairs at most once, best pairs first. */
function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
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
    matched += Math.min(weight(a[pair.ai] as string), weight(b[pair.bi] as string)) * pair.sim;
  }

  const totalA = a.reduce((sum, token) => sum + weight(token), 0);
  const totalB = b.reduce((sum, token) => sum + weight(token), 0);
  const total = (totalA + totalB) / 2;
  return total === 0 ? 0 : Math.min(1, matched / total);
}

function weight(token: string): number {
  return GENERIC_TOKENS.has(token) ? GENERIC_WEIGHT : 1;
}

/** 1 − normalized Levenshtein distance. */
export function characterSimilarity(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(NON_TOKEN)
    .filter((token) => token.length > 0);
}

function firstLegalForm(tokens: readonly string[]): string | undefined {
  for (const rule of LEGAL_FORMS) {
    if (findSequence(tokens, rule) !== null) return rule.canonical;
  }
  return undefined;
}

/** Remove every legal-form token, unless doing so would leave nothing behind. */
function stripLegalForms(tokens: readonly string[]): string[] {
  let remaining = [...tokens];
  for (const rule of LEGAL_FORMS) {
    for (;;) {
      const at = findSequence(remaining, rule);
      if (at === null) break;
      const stripped = [
        ...remaining.slice(0, at),
        ...remaining.slice(at + sequenceLength(rule, at, remaining)),
      ];
      // `DOO` alone is not a company name — keep what was published instead.
      if (stripped.length === 0) return remaining;
      remaining = stripped;
    }
  }
  return remaining;
}

function sequenceLength(rule: LegalFormRule, at: number, tokens: readonly string[]): number {
  for (const sequence of rule.sequences) {
    if (matchesAt(tokens, at, sequence)) return sequence.length;
  }
  return 1;
}

function findSequence(tokens: readonly string[], rule: LegalFormRule): number | null {
  for (const sequence of rule.sequences) {
    for (let at = 0; at + sequence.length <= tokens.length; at += 1) {
      if (!matchesAt(tokens, at, sequence)) continue;
      if (!rule.anywhere && at !== 0 && at + sequence.length !== tokens.length) continue;
      return at;
    }
  }
  return null;
}

function matchesAt(tokens: readonly string[], at: number, sequence: readonly string[]): boolean {
  return sequence.every((word, offset) => foldDiacritics(tokens[at + offset] ?? '') === word);
}

/**
 * Serbian sources routinely append the seat to the name — `Fasada doo Novi Sad`.
 * The city belongs in `leads.city_id`, not in the matching key, so a trailing
 * run of up to three tokens that names a municipality is lifted out. Never the
 * whole name: a business actually called `Beograd` keeps its name.
 */
function stripTrailingCity(tokens: readonly string[]): {
  tokens: string[];
  cityHint: string | undefined;
} {
  const size = trailingCitySize(tokens, false);
  if (size === 0) return { tokens: [...tokens], cityHint: undefined };
  return {
    tokens: tokens.slice(0, tokens.length - size),
    cityHint: cityNameAt(tokens, size),
  };
}

/** The place name a token run ends with, if any. */
function trailingCity(tokens: readonly string[], allowWholeString: boolean): string | undefined {
  const size = trailingCitySize(tokens, allowWholeString);
  return size === 0 ? undefined : cityNameAt(tokens, size);
}

function trailingCitySize(tokens: readonly string[], allowWholeString: boolean): number {
  const longest = Math.min(3, allowWholeString ? tokens.length : tokens.length - 1);
  for (let size = longest; size >= 1; size -= 1) {
    if (cityNameAt(tokens, size) !== undefined) return size;
  }
  return 0;
}

function cityNameAt(tokens: readonly string[], size: number): string | undefined {
  const window = tokens.slice(tokens.length - size).join(' ');
  return findMunicipalityByName(window)?.name_sr;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
