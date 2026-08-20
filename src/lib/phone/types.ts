/**
 * The shapes the phone module hands to the rest of the system.
 *
 * A normalized phone is the single strongest deduplication key we have and the
 * one field the whole product exists to deliver, so both the accepted and the
 * rejected shape are part of the contract: a dropped number always carries the
 * reason it was dropped, and the validation report prints it.
 */
import type { CountryCode } from 'libphonenumber-js/max';
import type { PhoneType } from '../db/schema.js';

/**
 * `lead_phones.type`, re-exported so nothing downstream has to reach into the
 * schema for it. The union is the database's, not this module's — a parallel
 * phone model is exactly what the persistence layer asked us not to build.
 *
 * Serbian `0700` national-rate lines have no slot of their own and land in
 * `unknown` rather than being thrown away: a stovarište that publishes one
 * publishes it as its sales line.
 */
export type { PhoneType };

export interface NormalizedPhone {
  /** Canonical E.164 form, e.g. `+381641234567`. The deduplication key. */
  readonly e164: string;
  /** The original string exactly as it was scraped. Never discarded — audits need it. */
  readonly raw: string;
  /** `064 1234567` — the form a Serbian salesperson actually dials. */
  readonly nationalFormat: string;
  readonly type: PhoneType;
  /**
   * National destination code in trunk form: a geographic area code for a
   * landline (`011`, `0230`), the operator prefix for a mobile (`064`), the
   * service code for the rest (`0800`). Undefined only for a code the Serbian
   * numbering plan tables here do not know.
   */
  readonly areaCode?: string | undefined;
  /**
   * Municipality id inferred from a landline area code — the network group's
   * centre, e.g. `021` → `novi-sad`. This is how a listing that never states a
   * city still gets one. Undefined for mobiles and for area codes outside the
   * geographic dataset.
   */
  readonly inferredCityId?: string | undefined;
  /** 0–1. How much the parse should be trusted; see `normalizePhone` for the exact ladder. */
  readonly confidence: number;
}

export type PhoneErrorCode =
  /** No digits at all. */
  | 'empty'
  /** Fewer digits than the shortest Serbian number. Postal codes and prices land here. */
  | 'too-short'
  /** More digits than E.164 allows. Bank account numbers land here. */
  | 'too-long'
  /** A date, not a number — `01.01.2024`, `2024-01-01`. */
  | 'date'
  /** Letters or symbols that are not part of a phone number. */
  | 'not-a-number'
  /**
   * A bare 8–9 digit run with no `+381`, `00381`, `381` or trunk `0` in front.
   * A Serbian PIB is 9 digits and a matični broj is 8, so this shape is a
   * registration number far more often than it is a phone.
   */
  | 'ambiguous-national-number'
  /** Parsed, but not a valid number in the Serbian numbering plan. */
  | 'invalid-for-region'
  /** Valid, but not a line a business can be called on — premium rate, voicemail. */
  | 'unsupported-type'
  /** `000000000`, `064 000 0000` — a placeholder, not a number. */
  | 'repeated-digits'
  /** `0123456789` — one consecutive digit run end to end. */
  | 'sequential-digits'
  /** Valid and parseable, but not Serbian. Flagged with its country, never coerced to +381. */
  | 'foreign';

export interface PhoneError {
  readonly code: PhoneErrorCode;
  /** One line, aimed at the validation report a human reads. */
  readonly reason: string;
  /** The input, unchanged. */
  readonly raw: string;
  /** Set for `foreign`: the country the number really belongs to, when known. */
  readonly country?: CountryCode | undefined;
  /**
   * The canonical form `libphonenumber-js` did manage to produce, when it
   * produced one — a foreign number keeps its own country's E.164 form, and an
   * invalid Serbian one keeps what it parsed to, so a `valid: false` row still
   * carries something.
   *
   * Deliberately absent for `repeated-digits` and `sequential-digits`: those
   * are placeholders, and letting `+381640000000` into the canonical column
   * would merge every unrelated lead that published the same fake.
   */
  readonly e164?: string | undefined;
}

/** Where in a page a candidate came from. Structured origins are more trustworthy than prose. */
export type PhoneOrigin = 'tel-link' | 'json-ld' | 'meta' | 'microdata' | 'data-attribute' | 'text';

export interface ExtractedPhone {
  /** The exact substring that was matched, before normalization. */
  readonly raw: string;
  readonly origin: PhoneOrigin;
  /** Surrounding text, trimmed to a short window — what a reviewer needs to judge a rejection. */
  readonly context: string;
  /** The normalized number, or `null` when the candidate was rejected. */
  readonly phone: NormalizedPhone | null;
  /** The rejection, or `null` when the candidate was accepted. */
  readonly error: PhoneError | null;
}

/** Narrow a `normalizePhone` result to its failure branch. */
export function isPhoneError(
  result: NormalizedPhone | { error: PhoneError },
): result is { error: PhoneError } {
  return 'error' in result;
}
