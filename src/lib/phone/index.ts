/**
 * Serbian phone extraction and normalization.
 *
 * `extractPhones` finds the numbers on a page; `normalizePhone` turns one of
 * them into `+381641234567` and keeps the raw string next to it. Adapters call
 * the first, everything downstream calls the second.
 */
export { extractPhones, acceptedPhones, rejectedPhones } from './extract.js';
export type { ExtractOptions } from './extract.js';
export { normalizePhone } from './normalize.js';
export { toPhoneInput } from './to-phone-input.js';
export { areaCodeFor, inferCityFromAreaCode, isDatasetAreaCode } from './serbian-numbering.js';
export { isPhoneError } from './types.js';
export type {
  ExtractedPhone,
  NormalizedPhone,
  PhoneError,
  PhoneErrorCode,
  PhoneOrigin,
  PhoneType,
} from './types.js';
