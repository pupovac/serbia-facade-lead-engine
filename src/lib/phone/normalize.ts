/**
 * Canonicalize one Serbian phone number.
 *
 * The phone is the deliverable and the strongest deduplication key, so this
 * function is deliberately strict: it would rather report a rejection with a
 * reason than guess. Everything it rejects comes back as a `PhoneError` the
 * validation report can print, so nothing is dropped silently.
 *
 * It expects a phone-shaped string — a number pulled out of prose is
 * `extractPhones`' job, not this one. The one concession is the department
 * label Serbian directories print next to a number (`034 xxx xxx, PRODAJA`):
 * `splitPhoneLabel` takes it off before parsing and hands it back on the
 * result, because the alternative was rejecting the number entirely.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { NumberType } from 'libphonenumber-js/max';
import { normalizeWhitespace } from '../text/fold.js';
import { splitPhoneLabel } from './label.js';
import { areaCodeFor, inferCityFromAreaCode } from './serbian-numbering.js';
import type { NormalizedPhone, PhoneError, PhoneErrorCode, PhoneType } from './types.js';

/** `tel:` and friends, as they arrive from an `href` or a JSON-LD field. */
const SCHEME = /^(?:tel|callto|sms|phone|telefon)\s*:\s*/i;

/** Everything a written phone number is allowed to be made of. */
const PHONE_CHARACTERS = /^[\d\s+()./-]+$/;

/** `01.01.2024`, `1/1/24`, `2024-01-01` — the shapes a Serbian page writes dates in. */
const DATE_SHAPE = /^(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\.?|\d{4}-\d{1,2}-\d{1,2})$/;

/** One digit, repeated to the end. */
const ALL_ONE_DIGIT = /^(\d)\1+$/;

/** Four or more of the same digit in a row — legal, but the shape of a placeholder. */
const LONG_DIGIT_RUN = /(\d)\1{3,}/;

const SERBIA_CALLING_CODE = '381';

/** `0` + two-digit area code + five-digit subscriber is the shortest real Serbian number. */
const MIN_DIGITS = 8;
/** E.164's ceiling. */
const MAX_DIGITS = 15;
/** A tail of this many identical digits is a placeholder, not a subscriber number. */
const PLACEHOLDER_TAIL = 6;
/** Only call a number sequential when the run is at least this long. */
const MIN_SEQUENTIAL_RUN = 8;

const BASE_CONFIDENCE = 1;
/** Trunk form leans on `RS` being the assumed region; an explicit +381 does not. */
const NATIONAL_FORM_CONFIDENCE = 0.95;
/** A landline whose area code the geographic dataset cannot place. */
const UNPLACEABLE_LANDLINE_PENALTY = 0.15;
/** A valid number that still looks like a placeholder. */
const DIGIT_RUN_PENALTY = 0.05;

/**
 * `libphonenumber-js`' verdict, mapped onto `lead_phones.type`.
 *
 * Serbia's metadata only ever produces `FIXED_LINE`, `MOBILE`, `TOLL_FREE`,
 * `UAN` and `PREMIUM_RATE`. `UAN` is the `0700` national-rate range — a real
 * sales line with no slot in the schema union, so it is kept as `unknown`
 * rather than discarded. `VOIP` is mapped for completeness; nothing in the
 * Serbian plan reports it today. `PREMIUM_RATE` is deliberately absent: 090x is
 * not a line a business can be sold to, and it falls out as `unsupported-type`.
 */
const TYPE_BY_NUMBER_TYPE = new Map<NumberType, PhoneType>([
  ['MOBILE', 'mobile'],
  ['FIXED_LINE', 'landline'],
  ['TOLL_FREE', 'toll_free'],
  ['VOIP', 'voip'],
  ['UAN', 'unknown'],
]);

/** How the number announced its country: explicitly, or by leaning on region `RS`. */
type NumberForm = 'international' | 'country-code' | 'national';

/**
 * Canonicalize a Serbian phone number to `+381641234567`.
 *
 * Accepts every written form Serbian sites use — `064 123 4567`,
 * `064/123-4567`, `+381 64 123 4567`, `00381 64 123 4567`, `381641234567`,
 * `+381(0)64 123 4567`, `011 2345 678`, `021/456-789` — and keeps the raw
 * original next to the canonical one.
 *
 * Returns `{ error }` for anything it will not vouch for, including numbers
 * that are perfectly valid somewhere else: a Croatian mobile comes back as
 * `foreign` with its own E.164 form intact, never bent into `+381`.
 */
export function normalizePhone(raw: string): NormalizedPhone | { error: PhoneError } {
  const scheme = normalizeWhitespace(raw).replace(SCHEME, '').trim();
  // The label comes off before anything else looks at the string, so every
  // rule below — the date shape, the character set, the digit counts — reads
  // the number the source published rather than the number plus a department.
  const { number: cleaned, label } = splitPhoneLabel(scheme);
  const digits = cleaned.replace(/\D/g, '');

  if (digits.length === 0) return fail(raw, 'empty', 'no digits in the input');
  if (DATE_SHAPE.test(cleaned)) return fail(raw, 'date', 'reads as a date, not a phone number');
  if (!PHONE_CHARACTERS.test(cleaned)) {
    return fail(raw, 'not-a-number', 'contains characters a phone number cannot contain');
  }
  if (digits.length < MIN_DIGITS) {
    return fail(
      raw,
      'too-short',
      `${digits.length} digits — the shortest Serbian number has ${MIN_DIGITS}`,
    );
  }
  if (digits.length > MAX_DIGITS) {
    return fail(raw, 'too-long', `${digits.length} digits — more than E.164 allows`);
  }

  const form = detectForm(cleaned, digits);
  if (form === null) {
    return fail(
      raw,
      'ambiguous-national-number',
      'no +381, 00381, 381 or trunk 0 in front — a bare 8 or 9 digit run is a PIB or a matični broj far more often than a phone',
    );
  }

  const parsed = parsePhoneNumberFromString(cleaned, 'RS');
  if (!parsed) return fail(raw, 'not-a-number', 'no number could be read out of it');

  if (parsed.countryCallingCode !== SERBIA_CALLING_CODE) {
    return {
      error: {
        code: 'foreign',
        reason: `+${parsed.countryCallingCode} is not Serbia — kept as it is, not coerced to +381`,
        raw,
        country: parsed.country,
        e164: parsed.number,
      },
    };
  }

  // Placeholder detection runs before validity so the report says "somebody
  // typed zeros here" rather than the far less useful "invalid number".
  const national = String(parsed.nationalNumber);
  if (ALL_ONE_DIGIT.test(national)) {
    return fail(raw, 'repeated-digits', 'the same digit end to end');
  }
  if (ALL_ONE_DIGIT.test(national.slice(-PLACEHOLDER_TAIL))) {
    return fail(
      raw,
      'repeated-digits',
      `the last ${PLACEHOLDER_TAIL} digits are one digit repeated`,
    );
  }
  if (isConsecutiveRun(national)) {
    return fail(raw, 'sequential-digits', 'the whole number is one consecutive digit run');
  }

  if (!parsed.isValid()) {
    return {
      error: {
        code: 'invalid-for-region',
        reason: 'not a valid number in the Serbian numbering plan',
        raw,
        e164: parsed.number,
      },
    };
  }

  const numberType = parsed.getType();
  const type = TYPE_BY_NUMBER_TYPE.get(numberType);
  if (type === undefined) {
    return {
      error: {
        code: 'unsupported-type',
        reason: `${numberType} numbers are not business contact lines`,
        raw,
        e164: parsed.number,
      },
    };
  }

  const areaCode = areaCodeFor(national);
  const inferredCityId = type === 'landline' ? inferCityFromAreaCode(areaCode) : undefined;

  return {
    e164: parsed.number,
    raw,
    nationalFormat: parsed.formatNational(),
    type,
    areaCode,
    inferredCityId,
    label: label ?? undefined,
    confidence: confidenceOf(form, type, inferredCityId, national),
  };
}

function fail(raw: string, code: PhoneErrorCode, reason: string): { error: PhoneError } {
  return { error: { code, reason, raw } };
}

/**
 * How the number states its country. `null` means it states nothing — which is
 * what a PIB, a matični broj and a postal code all look like.
 */
function detectForm(cleaned: string, digits: string): NumberForm | null {
  if (cleaned.startsWith('+')) return 'international';
  if (digits.startsWith('00')) return 'international';
  if (digits.startsWith(SERBIA_CALLING_CODE)) return 'country-code';
  if (digits.startsWith('0')) return 'national';
  return null;
}

/**
 * True when every step between neighbouring digits is the same ±1.
 *
 * Only the whole national number counts. `064 123 4567` has a sequential
 * subscriber part and is one of the most common real Serbian mobile shapes, so
 * a subscriber-level rule would throw away good leads; `0123456789` end to end
 * is a fake.
 */
function isConsecutiveRun(digits: string): boolean {
  if (digits.length < MIN_SEQUENTIAL_RUN) return false;
  const step = Number(digits.charAt(1)) - Number(digits.charAt(0));
  if (step !== 1 && step !== -1) return false;
  for (let i = 2; i < digits.length; i += 1) {
    if (Number(digits.charAt(i)) - Number(digits.charAt(i - 1)) !== step) return false;
  }
  return true;
}

/**
 * The confidence ladder, in full:
 *
 * - `1.00` — valid, and it said `+381` / `00381` / `381` itself.
 * - `0.95` — valid in trunk form (`064…`), which leans on `RS` being assumed.
 * - `−0.15` — a landline no city can be inferred for (a Kosovo network group,
 *   or a code outside the coverage dataset).
 * - `−0.05` — four or more identical digits in a row: valid, but the shape a
 *   placeholder number takes.
 */
function confidenceOf(
  form: NumberForm,
  type: PhoneType,
  inferredCityId: string | undefined,
  national: string,
): number {
  let confidence = form === 'national' ? NATIONAL_FORM_CONFIDENCE : BASE_CONFIDENCE;
  if (type === 'landline' && inferredCityId === undefined)
    confidence -= UNPLACEABLE_LANDLINE_PENALTY;
  if (LONG_DIGIT_RUN.test(national)) confidence -= DIGIT_RUN_PENALTY;
  return Math.round(confidence * 100) / 100;
}
