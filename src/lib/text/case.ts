/**
 * Casing for a letter that expands into two.
 *
 * Serbian has letters that are one letter in one script and two in the other:
 * `Њ` is `Nj`, and `Đ` ASCII-folds to `Dj`. Writing the expansion means
 * choosing a case the source never wrote, and the naive choice — always the
 * title form — is what turns `КОВИЉ` into `KOVILj` and `ĐORĐ` into `DJORDj`.
 *
 * The neighbouring letters are the evidence. Inside a word the letter *after*
 * the digraph decides: `ЊЕГОШ` → `NJEGOŠ`, `Његош` → `Njegoš`. At the end of a
 * word there is no letter after it — `КОВИЉ`, `ĐORĐ` — so the letter before
 * decides instead. A one-letter word has neither, and takes the title form.
 */

/** `upper` for `NJ`/`DJ`, `title` for `Nj`/`Dj`. */
export type DigraphCase = 'upper' | 'title';

function caseOf(char: string | undefined): 'upper' | 'lower' | undefined {
  if (char === undefined || !/\p{L}/u.test(char)) return undefined;
  if (/\p{Lu}/u.test(char)) return 'upper';
  if (/\p{Ll}/u.test(char)) return 'lower';
  // A caseless letter carries no evidence either way.
  return undefined;
}

/**
 * Which case a two-letter expansion should take.
 *
 * `source` is the string being rewritten, `index` where the expanded letter
 * sits in it and `length` how many code units it occupies — 1 for `Њ` and `Đ`.
 */
export function digraphCase(source: string, index: number, length = 1): DigraphCase {
  const after = caseOf(source[index + length]);
  if (after !== undefined) return after === 'upper' ? 'upper' : 'title';
  return caseOf(source[index - 1]) === 'upper' ? 'upper' : 'title';
}
