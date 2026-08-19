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
