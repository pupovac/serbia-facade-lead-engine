/**
 * Serbian Latin → Cyrillic transliteration.
 *
 * Some Serbian directories publish only Cyrillic, so a query set that is Latin
 * only cannot reach them. Serbian Latin and Cyrillic are a 1:1 alphabet pair,
 * so the mapping is mechanical — with one caveat, handled below.
 *
 * Input must be Serbian Latin *with diacritics*. An ASCII-folded string
 * (`gradjevinski`) is deliberately NOT accepted as equivalent: folding is
 * lossy, and `dj` → `đ` would be a guess. Transliterate the diacritic form and
 * fold separately.
 */
import { digraphCase } from './case.js';

/**
 * The three Serbian digraphs, longest match first. They must be replaced before
 * the single letters or `nj` becomes `нј` instead of `њ`.
 */
const DIGRAPHS: ReadonlyArray<readonly [string, string]> = [
  ['DŽ', 'Џ'],
  ['Dž', 'Џ'],
  ['dž', 'џ'],
  ['LJ', 'Љ'],
  ['Lj', 'Љ'],
  ['lj', 'љ'],
  ['NJ', 'Њ'],
  ['Nj', 'Њ'],
  ['nj', 'њ'],
];

const LETTERS: Readonly<Record<string, string>> = {
  A: 'А',
  B: 'Б',
  C: 'Ц',
  Č: 'Ч',
  Ć: 'Ћ',
  D: 'Д',
  Đ: 'Ђ',
  E: 'Е',
  F: 'Ф',
  G: 'Г',
  H: 'Х',
  I: 'И',
  J: 'Ј',
  K: 'К',
  L: 'Л',
  M: 'М',
  N: 'Н',
  O: 'О',
  P: 'П',
  R: 'Р',
  S: 'С',
  Š: 'Ш',
  T: 'Т',
  U: 'У',
  V: 'В',
  Z: 'З',
  Ž: 'Ж',
  a: 'а',
  b: 'б',
  c: 'ц',
  č: 'ч',
  ć: 'ћ',
  d: 'д',
  đ: 'ђ',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'ј',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  r: 'р',
  s: 'с',
  š: 'ш',
  t: 'т',
  u: 'у',
  v: 'в',
  z: 'з',
  ž: 'ж',
};

const DIGRAPH_PATTERN = new RegExp(DIGRAPHS.map(([latin]) => latin).join('|'), 'g');
const DIGRAPH_MAP = new Map(DIGRAPHS);

/**
 * Transliterate Serbian Latin to Serbian Cyrillic.
 *
 * `fasader` → `фасадер`, `građevinski materijal` → `грађевински материјал`.
 * Characters outside the Serbian Latin alphabet — digits, punctuation, spaces,
 * and letters like `q w x y` that only occur in foreign words — pass through
 * untouched.
 *
 * **Caveat.** `nj`, `lj` and `dž` are ambiguous at a morpheme boundary:
 * `nadživeti` is `надживети`, not `наџивети`. This function always takes the
 * digraph reading, which is right for every term in the query inventory but
 * wrong for that class of word. Do not point it at arbitrary scraped text —
 * set `term_cyrillic` explicitly in `data/query-templates.json` instead.
 */
export function toCyrillic(value: string): string {
  return value
    .replace(DIGRAPH_PATTERN, (match) => DIGRAPH_MAP.get(match) ?? match)
    .replace(/./gu, (char) => LETTERS[char] ?? char);
}

/** True when the string contains at least one Cyrillic letter. */
export function hasCyrillic(value: string): boolean {
  return /\p{Script=Cyrillic}/u.test(value);
}

/**
 * Serbian Cyrillic → Latin, the direction scraped text actually needs.
 *
 * Unlike Latin → Cyrillic this mapping is unambiguous: `љ` is always `lj`, so
 * there is no digraph guess to get wrong. `Фасада` → `Fasada`,
 * `грађевински материјал` → `građevinski materijal`.
 *
 * A capital digraph is one letter written as two, so its case comes from the
 * letters around it — `ЉУБИЋ` → `LJUBIĆ`, `Љубић` → `Ljubić`, and word-final
 * `КОВИЉ` → `KOVILJ` rather than `KOVILj` (see `digraphCase`).
 */
export function toLatin(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    const mapped = CYRILLIC_TO_LATIN[char];
    if (mapped === undefined) {
      out += char;
      continue;
    }
    if (mapped.length === 2 && mapped[0] === mapped[0]?.toUpperCase()) {
      out += digraphCase(value, i) === 'upper' ? mapped.toUpperCase() : mapped;
      continue;
    }
    out += mapped;
  }
  return out;
}

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(LETTERS).map(([latin, cyrillic]) => [cyrillic, latin])),
  ...Object.fromEntries(DIGRAPHS.map(([latin, cyrillic]) => [cyrillic, latin])),
  // The digraph table above maps three Latin spellings onto each Cyrillic
  // letter; the last one written wins, so pin the two cased forms explicitly.
  Љ: 'Lj',
  љ: 'lj',
  Њ: 'Nj',
  њ: 'nj',
  Џ: 'Dž',
  џ: 'dž',
};
