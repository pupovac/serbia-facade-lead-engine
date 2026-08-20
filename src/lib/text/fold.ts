/**
 * Serbian text folding helpers.
 *
 * Every search query and every name comparison in this project needs a
 * diacritic form and an ASCII-folded form: `građevinski` / `gradjevinski`,
 * `Čačak` / `Cacak`. Sources are inconsistent about which one they publish, so
 * folding happens here once and both forms are used downstream.
 *
 * Cyrillic is a script, not a spelling: `Фасаде Милош` and `Fasade Miloš` are
 * the same business, so `foldForComparison` transliterates before it folds and
 * every comparison key in the project is script-insensitive. `foldDiacritics`
 * deliberately does not — the query generator needs a Cyrillic query to stay
 * Cyrillic.
 */
import { hasCyrillic, toLatin } from './cyrillic.js';
import { digraphCase } from './case.js';

/**
 * Serbian Latin letters that Unicode decomposition cannot handle on its own.
 *
 * `đ`/`Đ` are single code points with no combining-mark decomposition, and the
 * three digraphs have precomposed single-code-point forms in three cases each
 * (`Ǉ ǈ ǉ`). Everything else (č ć š ž) folds via NFD.
 */
const EXPLICIT_FOLDS: Readonly<Record<string, string>> = {
  đ: 'dj',
  ǉ: 'lj',
  ǈ: 'Lj',
  Ǉ: 'LJ',
  ǌ: 'nj',
  ǋ: 'Nj',
  Ǌ: 'NJ',
  ǆ: 'dz',
  ǅ: 'Dz',
  Ǆ: 'DZ',
  ǳ: 'dz',
  ǲ: 'Dz',
  Ǳ: 'DZ',
};

const EXPLICIT_PATTERN = new RegExp(`[${Object.keys(EXPLICIT_FOLDS).join('')}]`, 'gu');

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
  const folded = value
    // `Đ` is one letter and `DJ` is two, so the fold has to choose a case the
    // source never wrote: `ĐORĐ` is `DJORDJ`, not `DJORDj`.
    .replace(/Đ/gu, (_match, index: number) =>
      digraphCase(value, index) === 'upper' ? 'DJ' : 'Dj',
    )
    .replace(EXPLICIT_PATTERN, (match: string) => EXPLICIT_FOLDS[match] ?? match);
  return folded.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/**
 * The comparison key for a piece of free text: transliterated to Latin when it
 * is Cyrillic, whitespace-collapsed, diacritic-folded and lower-cased. Used by
 * the classifier, the geography index and as the cheap pre-filter before the
 * real dedup scoring — all of which want `ГРАЂЕВИНСКО СТОВАРИШТЕ` and
 * `Građevinsko stovarište` to be one key.
 */
export function foldForComparison(value: string): string {
  const latin = hasCyrillic(value) ? toLatin(value) : value;
  return foldDiacritics(normalizeWhitespace(latin)).toLowerCase();
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
