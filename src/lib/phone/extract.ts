/**
 * Pull phone numbers out of Serbian web pages.
 *
 * Serbian listings write a number every way a person can think of — inside a
 * `tel:` link, in JSON-LD, in a `<meta>` tag, spaced out as `064 123 45 67`,
 * glued to a street number as `Vojvode Stepe 80-82 011 550907`, or two numbers
 * in one cell. Everything here is about getting all of them and nothing else.
 *
 * This is the one place in `src/lib` that knows what HTML is. It has to be:
 * a `tel:` href and a JSON-LD `telephone` field are the highest-yield sources
 * on the page and neither survives being flattened to text. It still knows
 * nothing about any particular website.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { foldForComparison, normalizeWhitespace } from '../text/fold.js';
import { normalizePhone } from './normalize.js';
import type { ExtractedPhone, PhoneErrorCode, PhoneOrigin } from './types.js';
import { isPhoneError } from './types.js';

export interface ExtractOptions {
  /** Parse the input as HTML — `tel:` links, JSON-LD, `<meta>` and microdata included. */
  readonly html?: boolean | undefined;
}

/** One separator between two digit groups. Two in a row means two different numbers. */
const SEPARATOR = String.raw`[ .\-/\\]`;

/**
 * A phone-shaped run. Three ways a Serbian number announces itself:
 * an international prefix, a bare `381`, or a trunk `0`. Nothing else is a
 * candidate — that single rule is what keeps nine-digit PIBs out.
 *
 * The lookbehind stops a match from starting mid-run, so `80-82 018 550907`
 * yields `018 550907` and not `82 018 550907`.
 */
const CANDIDATE = new RegExp(
  `(?<!\\d)(?:${[
    String.raw`(?:\+|00)\d{1,4}(?:${SEPARATOR}?(?:\(0\)|\d{1,4})){1,6}`,
    String.raw`381(?:${SEPARATOR}?\d{1,4}){2,4}`,
    String.raw`0\d{1,3}(?:${SEPARATOR}?\d{1,4}){1,4}`,
  ].join('|')})`,
  'g',
);

/**
 * Labels that mean the digits after them are a registration number, not a
 * phone: PIB, matični broj, a bank account, a JMBG. Folded and lower-cased
 * before matching, so `žiro`/`ziro` and `matični`/`maticni` both hit.
 *
 * One short digit group may sit between the label and the match, because a
 * Serbian account number is written `žiro račun 160-0000000000000-00` and the
 * candidate starts after the bank's three-digit prefix. The group is capped at
 * four digits so that `PIB 101234567 064/123-4567` still yields the phone.
 */
const REGISTRATION_LABEL =
  /(?:\bpib\b|\bmb\b|\bmaticni\b|\bmat\b|\bziro\b|\bracun\b|\bjmbg\b|\biban\b|\bswift\b|\bean\b|\bsifra\b|\bpak\b)(?:[^a-z0-9]{0,4}\d{1,4})?[^a-z0-9]{0,4}$/;

/** How far back to look for one of those labels. */
const LABEL_WINDOW = 32;

/** How much text to keep either side of a match so a reviewer can judge it. */
const CONTEXT_WINDOW = 40;

/**
 * Rejections worth showing a human. The rest — dates, five-digit postal codes,
 * a run of digits with no phone prefix at all — are page furniture, and putting
 * them in the validation report would bury the real problems.
 */
const REPORTABLE: ReadonlySet<PhoneErrorCode> = new Set([
  'invalid-for-region',
  'repeated-digits',
  'sequential-digits',
  'unsupported-type',
  'foreign',
  'too-long',
]);

/**
 * Elements a phone number never spans. Two numbers in neighbouring table cells
 * are two numbers; a number broken across `<span>`s is still one number, so
 * inline elements are deliberately absent from this list.
 */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'option',
  'p',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

/** Written between two block elements. Not a phone separator, so no match can cross it. */
const BLOCK_BREAK = ' ; ';

const TEL_SCHEMES = ['tel', 'callto', 'sms'];
const PHONE_ATTRIBUTES = ['data-phone', 'data-tel', 'data-telephone'];

/** `tel` also covers `telephone` and `telefon`; matching is case-insensitive. */
const PHONE_ATTR_FRAGMENTS = ['tel', 'phone'];

/** `<meta name="telephone">`, `<meta property="og:phone_number">`, `<meta itemprop="telephone">`. */
const META_SELECTOR = PHONE_ATTR_FRAGMENTS.flatMap((fragment) => [
  `meta[name*="${fragment}" i]`,
  `meta[property*="${fragment}" i]`,
  `meta[itemprop*="${fragment}" i]`,
]).join(', ');

/** Schema.org microdata: `<span itemprop="telephone">`. */
const MICRODATA_SELECTOR = PHONE_ATTR_FRAGMENTS.map(
  (fragment) => `[itemprop*="${fragment}" i]`,
).join(', ');

/** The JSON-LD keys worth reading a string out of. */
const PHONE_KEY = /phone|telefon|tel$/i;

interface Candidate {
  readonly value: string;
  readonly origin: PhoneOrigin;
  readonly context: string;
}

/**
 * Every phone number in a piece of text or a page, accepted ones and reportable
 * rejections alike, deduplicated by canonical form.
 *
 * Structured sources are read first, so when the same number appears both in a
 * `tel:` link and in the visible text the entry keeps the structured origin.
 */
export function extractPhones(text: string, opts?: ExtractOptions): ExtractedPhone[] {
  const candidates =
    opts?.html === true ? candidatesFromHtml(text) : candidatesFromText(text, 'text');
  const seen = new Set<string>();
  const found: ExtractedPhone[] = [];

  for (const candidate of candidates) {
    const result = normalizePhone(candidate.value);
    if (isPhoneError(result)) {
      if (!REPORTABLE.has(result.error.code)) continue;
      const key = `rejected:${result.error.code}:${candidate.value.replace(/\D/g, '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        raw: candidate.value,
        origin: candidate.origin,
        context: candidate.context,
        phone: null,
        error: result.error,
      });
      continue;
    }
    if (seen.has(result.e164)) continue;
    seen.add(result.e164);
    found.push({
      raw: candidate.value,
      origin: candidate.origin,
      context: candidate.context,
      phone: result,
      error: null,
    });
  }

  return found;
}

/** The numbers that survived, in the order they were found. */
export function acceptedPhones(extracted: readonly ExtractedPhone[]): ExtractedPhone[] {
  return extracted.filter((entry) => entry.phone !== null);
}

/** The candidates that looked like phones and were dropped, with the reason attached. */
export function rejectedPhones(extracted: readonly ExtractedPhone[]): ExtractedPhone[] {
  return extracted.filter((entry) => entry.error !== null);
}

function candidatesFromText(text: string, origin: PhoneOrigin): Candidate[] {
  const haystack = normalizeWhitespace(text);
  const candidates: Candidate[] = [];

  for (const match of haystack.matchAll(CANDIDATE)) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;
    // A digit still sitting after the match means the run was longer than any
    // phone number — an account number or an id, not a truncated phone.
    if (/\d/.test(haystack.charAt(end))) continue;
    if (
      REGISTRATION_LABEL.test(
        foldForComparison(haystack.slice(Math.max(0, start - LABEL_WINDOW), start)),
      )
    )
      continue;
    candidates.push({
      value,
      origin,
      context: normalizeWhitespace(
        haystack.slice(Math.max(0, start - CONTEXT_WINDOW), end + CONTEXT_WINDOW),
      ),
    });
  }

  return candidates;
}

function candidatesFromHtml(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];

  const push = (value: string | undefined, origin: PhoneOrigin, context: string): void => {
    if (value === undefined) return;
    const trimmed = normalizeWhitespace(value);
    if (trimmed === '') return;
    // A structured field can still hold two numbers, or a number wrapped in
    // prose — run the same matcher over it rather than trusting it whole.
    for (const candidate of candidatesFromText(trimmed, origin)) {
      candidates.push({ ...candidate, context: context === '' ? candidate.context : context });
    }
  };

  $('a').each((_, element) => {
    const href = $(element).attr('href');
    if (href === undefined) return;
    const scheme = href.slice(0, href.indexOf(':')).toLowerCase();
    if (!TEL_SCHEMES.includes(scheme)) return;
    push(
      href.slice(scheme.length + 1).replace(/%20/gi, ' '),
      'tel-link',
      snippet($(element).text()),
    );
  });

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const found of jsonLdPhones(parsed, 'json-ld'))
      push(found.value, 'json-ld', found.context);
  });

  $(META_SELECTOR).each((_, element) => {
    const el = $(element);
    const key = [el.attr('name'), el.attr('property'), el.attr('itemprop')].join(' ');
    push(el.attr('content'), 'meta', normalizeWhitespace(key));
  });

  $(MICRODATA_SELECTOR).each((_, element) => {
    const el = $(element);
    // `<meta itemprop="telephone" content="…">` puts the number in an attribute;
    // `<span itemprop="telephone">…</span>` puts it in the text.
    push(el.attr('content') ?? el.text(), 'microdata', snippet(el.text()));
  });

  for (const attribute of PHONE_ATTRIBUTES) {
    $(`[${attribute}]`).each((_, element) => {
      push($(element).attr(attribute), 'data-attribute', attribute);
    });
  }

  $('script, style, noscript, head').remove();
  candidates.push(...candidatesFromText(visibleText($.root().contents().toArray()), 'text'));

  return candidates;
}

/**
 * The page as a reader sees it, in document order.
 *
 * Text nodes join with a space, so a number broken across inline markup —
 * `<b>064</b> 123 4567` — still reads as one number. A block element writes a
 * break the phone matcher cannot cross, so two numbers in neighbouring table
 * cells stay two numbers instead of fusing into one twenty-digit non-number.
 */
function visibleText(nodes: readonly AnyNode[]): string {
  const parts: string[] = [];

  const walk = (node: AnyNode): void => {
    if (node.type === 'text') {
      parts.push(node.data);
      return;
    }
    if (!('children' in node)) return;
    const isBlock = 'name' in node && BLOCK_ELEMENTS.has(node.name);
    if (isBlock) parts.push(BLOCK_BREAK);
    for (const child of node.children) walk(child);
    if (isBlock) parts.push(BLOCK_BREAK);
  };

  for (const node of nodes) walk(node);
  return parts.join(' ');
}

function jsonLdPhones(value: unknown, path: string): Array<{ value: string; context: string }> {
  if (typeof value === 'string') return PHONE_KEY.test(path) ? [{ value, context: path }] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => jsonLdPhones(item, `${path}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => jsonLdPhones(child, `${path}.${key}`));
  }
  return [];
}

function snippet(text: string): string {
  return normalizeWhitespace(text).slice(0, CONTEXT_WINDOW * 2);
}
