/**
 * The bridge from a parse result to a row the repository will accept.
 *
 * `src/lib/db` never parses a number — canonicalization is entirely this
 * module's job — and it never drops one either: a number `libphonenumber-js`
 * refuses is stored with `valid: false` so the raw string survives as evidence
 * of what the source actually published. This function is the one place that
 * rule is implemented.
 */
import { normalizeWhitespace } from '../text/fold.js';
import type { PhoneInput } from '../db/repo.js';
import type { NormalizedPhone, PhoneError } from './types.js';
import { isPhoneError } from './types.js';

/** A rejected number carries no confidence; the column stays honest about that. */
const REJECTED_CONFIDENCE = 0;

/**
 * Turn either outcome of `normalizePhone` into a `PhoneInput`.
 *
 * A rejection keeps whatever canonical form `libphonenumber-js` managed to
 * produce. When it produced nothing — or when the number is a recognized
 * placeholder, where a canonical form would false-merge every lead that
 * published the same fake — `e164` falls back to the raw string, which can
 * never collide with a real `+381…` value.
 */
export function toPhoneInput(result: NormalizedPhone | { error: PhoneError }): PhoneInput {
  if (isPhoneError(result)) {
    return {
      e164: result.error.e164 ?? normalizeWhitespace(result.error.raw),
      raw: result.error.raw,
      nationalFormat: null,
      type: 'unknown',
      valid: false,
      confidence: REJECTED_CONFIDENCE,
    };
  }

  return {
    e164: result.e164,
    raw: result.raw,
    nationalFormat: result.nationalFormat,
    type: result.type,
    valid: true,
    confidence: result.confidence,
  };
}
