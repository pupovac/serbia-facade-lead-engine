/**
 * Serbian text folding helpers.
 *
 * Every search query and every name comparison in this project needs a
 * diacritic form and an ASCII-folded form: `građevinski` / `gradjevinski`,
 * `Čačak` / `Cacak`. Sources are inconsistent about which one they publish, so
 * folding happens here once and both forms are used downstream.
 */

const UPPERCASE_NEXT = /[A-ZČĆŠŽĐ]/;

/**
 * Serbian Latin letters that Unicode decomposition cannot handle on its own:
 * `đ`/`Đ` are single code points with no combining-mark decomposition, and
 * `dž` has precomposed digraph forms. Everything else (č ć š ž) folds via NFD.
 */
const EXPLICIT_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/đ/g, 'dj'], // đ
  [new RegExp(`Đ(?=${UPPERCASE_NEXT.source})`, 'g'), 'DJ'], // Đ before an uppercase letter
  [/Đ/g, 'Dj'], // Đ
  [/ǆ/g, 'dz'], // ǆ
  [/ǅ/g, 'Dz'], // ǅ
  [/Ǆ/g, 'DZ'], // Ǆ
];

/** Zero-width characters that scraped HTML sprinkles into names; they carry no meaning here. */
const ZERO_WIDTH = /\u200b|\u200c|\u200d|\ufeff/gu;
const WHITESPACE = /[\s\u00a0]+/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/gu;

/**
 * Drop the zero-width characters scraped HTML is full of, collapse every run of
 * whitespace — non-breaking spaces included — into a single space, and trim.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(ZERO_WIDTH, '').replace(WHITESPACE, ' ').trim();
}

/**
 * Fold Serbian Latin diacritics to their ASCII equivalents.
 *
 * `Čačak` → `Cacak`, `građevinski` → `gradjevinski`, `Užice` → `Uzice`.
 * Casing is preserved; unrelated characters pass through untouched.
 */
export function foldDiacritics(value: string): string {
  let folded = value;
  for (const [pattern, replacement] of EXPLICIT_FOLDS) {
    folded = folded.replace(pattern, replacement);
  }
  return folded.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/**
 * The comparison key for a piece of free text: whitespace-collapsed,
 * diacritic-folded and lower-cased. Used for query generation and as the cheap
 * pre-filter before the real dedup scoring.
 */
export function foldForComparison(value: string): string {
  return foldDiacritics(normalizeWhitespace(value)).toLowerCase();
}

/**
 * Both spellings of a term, in a stable order: the original first, the ASCII
 * fold second when it actually differs.
 */
export function diacriticVariants(term: string): string[] {
  const original = normalizeWhitespace(term);
  const folded = foldDiacritics(original);
  return folded === original ? [original] : [original, folded];
}
