/**
 * The department label a Serbian directory prints next to a phone number.
 *
 * `gradjevinarstvo.rs` publishes its numbers as `034 xxx xxx, PRODAJA` — the
 * number, a comma, and who answers it. `normalizePhone` is strict about what a
 * phone-shaped string may contain, so every one of those strings failed to
 * parse and was stored with `valid = 0`: 621 rows in the pilot corpus, of which
 * 111 carried a number that existed nowhere else in the database. The phone is
 * the deliverable, so losing 111 of them to a punctuation mark is not
 * acceptable.
 *
 * Two shapes are recognized, and the difference between them is the whole
 * safety argument:
 *
 * - **Separated.** A comma, colon, semicolon, pipe, slash, dash or newline with
 *   a run of letters on one side of it. The separator is the evidence; the
 *   words themselves are never consulted, so `021 xxxx xxx, CENTRALA BEČEJ`
 *   and `024 xxx xxx, SALON` both work without anyone maintaining a list.
 * - **Unseparated.** `PRODAJA 034 xxx xxx`, with nothing but a space. Here the
 *   words *are* the evidence, and only the vocabulary below counts — stripping
 *   any leading word would turn `Ulica 15 broj 3` into a phone number.
 *
 * The label is returned rather than thrown away. It says which desk answers,
 * which a salesperson wants to know, and when it names a *place* it says the
 * number belongs to another branch — which is what `locality.ts` reads it for.
 */
import { foldDiacritics } from '../text/fold.js';

export interface SplitPhone {
  /** The phone-shaped part, ready for `normalizePhone`. */
  readonly number: string;
  /** What was printed next to it, as published. `null` when there was nothing. */
  readonly label: string | null;
}

/**
 * Serbian department and desk words, ASCII-folded and lower-cased.
 *
 * Only consulted for the unseparated shape. Kept deliberately short: a word
 * that is not here simply means the number keeps its label and parses exactly
 * as it does today, which is the safe direction to fail in.
 */
const LABEL_WORDS: ReadonlySet<string> = new Set([
  'prodaja',
  'maloprodaja',
  'veleprodaja',
  'servis',
  'centrala',
  'magacin',
  'stovariste',
  'direktor',
  'direkcija',
  'uprava',
  'finansije',
  'racunovodstvo',
  'komercijala',
  'nabavka',
  'marketing',
  'proizvodnja',
  'pogon',
  'fabrika',
  'salon',
  'showroom',
  'izlozbeni',
  'kancelarija',
  'poslovnica',
  'radnja',
  'recepcija',
  'sekretarica',
  'sluzba',
  'tehnika',
  'podrska',
  'info',
  'kontakt',
  'lokal',
  'telefon',
  'tel',
  'mob',
  'mobilni',
  'fax',
  'faks',
]);

/** What may separate a number from its label. A comma does it 98% of the time. */
const SEPARATOR = /[,;:|/\n\r]|\s[-–—]\s/;

/** A run long enough to be a subscriber number rather than `LOKAL 118`. */
const NUMBER_RUN = /\d{5,}/;

/** `0` + two-digit area code + five-digit subscriber is the shortest real number. */
const MIN_PHONE_DIGITS = 8;

const HAS_LETTER = /\p{L}/u;

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

/** Could this side of the separator be the number? */
function looksLikeNumber(value: string): boolean {
  return digitCount(value.replace(/\s/g, '')) >= MIN_PHONE_DIGITS;
}

/**
 * Could this side of the separator be the label?
 *
 * It has to read as words, and it must not contain a digit run long enough to
 * be a second phone number: `011 xxxx xxx, 011 xxxx xxx` is two numbers, and
 * treating the tail as a label would silently drop one of them.
 */
function looksLikeLabel(value: string): boolean {
  return HAS_LETTER.test(value) && !NUMBER_RUN.test(value);
}

function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Split `034 xxx xxx, PRODAJA` into its number and its label.
 *
 * Returns the input unchanged as `number` with a `null` label whenever the
 * shape is not confidently a labelled number — including when both sides carry
 * a real digit run, which is two numbers rather than one labelled one.
 */
export function splitPhoneLabel(raw: string): SplitPhone {
  const input = raw.replace(/\u00a0/g, ' ');
  const separated = splitOnSeparator(input);
  if (separated !== null) return separated;
  return splitOnVocabulary(input);
}

function splitOnSeparator(input: string): SplitPhone | null {
  const at = input.search(SEPARATOR);
  if (at < 0) return null;

  const match = SEPARATOR.exec(input);
  /* c8 ignore next -- `search` just found it; this narrows the type */
  if (match === null) return null;
  const head = tidy(input.slice(0, at));
  const tail = tidy(input.slice(at + match[0].length));
  if (head === '' || tail === '') return null;

  if (looksLikeNumber(head) && looksLikeLabel(tail)) return { number: head, label: tail };
  // `PRODAJA: 034 xxx xxx` — the label leads.
  if (looksLikeLabel(head) && looksLikeNumber(tail)) return { number: tail, label: head };
  return null;
}

function splitOnVocabulary(input: string): SplitPhone {
  const unchanged = { number: input, label: null } as const;
  if (!HAS_LETTER.test(input)) return unchanged;

  const words = tidy(input).split(' ');
  const isLabelWord = (word: string): boolean =>
    LABEL_WORDS.has(foldDiacritics(word.replace(/[.:]+$/, '')).toLowerCase());

  let start = 0;
  while (start < words.length && isLabelWord(words[start] as string)) start += 1;
  let end = words.length;
  while (end > start && isLabelWord(words[end - 1] as string)) end -= 1;

  if (start === 0 && end === words.length) return unchanged;
  const number = words.slice(start, end).join(' ');
  if (!looksLikeNumber(number)) return unchanged;

  const label = tidy([...words.slice(0, start), ...words.slice(end)].join(' '));
  return { number, label: label === '' ? null : label };
}
