/**
 * The Serbian numbering plan, as far as this project needs it.
 *
 * `libphonenumber-js` answers "is this a valid Serbian number and what type is
 * it". It does not answer "which town is this landline in", which is the part
 * that matters here: a large share of Serbian listings give a phone and no
 * city, and the area code is the only location signal on the page.
 *
 * The geographic codes come from the coverage dataset itself, so this file and
 * `data/serbia-geo.json` can never drift apart.
 */
import { landlineGroupCenter, municipalities } from '../geo.js';

/** Mobile operator prefixes, trunk zero stripped. 067 is the 7–8 digit VoIP-style range. */
const MOBILE_CODES = ['60', '61', '62', '63', '64', '65', '66', '67', '68', '69'] as const;

/** Toll-free (0800) and the national-rate business range (0700). */
const SERVICE_CODES = ['800', '700'] as const;

/**
 * Area codes the geographic dataset does not carry.
 *
 * `data/serbia-geo.json` covers the 145 local self-government units of central
 * Serbia and Vojvodina; the Kosovo and Metohija network groups are outside it.
 * Their numbers are still real Serbian landlines and must normalize — they just
 * cannot infer a city, and `normalizePhone` scores them lower for it.
 */
const AREA_CODES_OUTSIDE_DATASET = ['28', '29', '38', '39'] as const;

/** Every geographic area code in the coverage dataset, trunk zero stripped. */
const DATASET_AREA_CODES: ReadonlySet<string> = new Set(
  municipalities.map((m) => m.landline_prefix.replace(/^0/, '')),
);

/**
 * Every national destination code we recognize, longest first.
 *
 * Longest-first is not cosmetic: Kikinda is `0230` and Zrenjanin is `023`, so a
 * shortest-match lookup would file every Kikinda number under Zrenjanin.
 */
const KNOWN_CODES: readonly string[] = [
  ...DATASET_AREA_CODES,
  ...AREA_CODES_OUTSIDE_DATASET,
  ...MOBILE_CODES,
  ...SERVICE_CODES,
].sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * The national destination code of a national significant number, in trunk
 * form: `641234567` → `064`, `230421555` → `0230`.
 *
 * Returns `undefined` for a code outside the plan tables above.
 */
export function areaCodeFor(nationalNumber: string): string | undefined {
  const code = KNOWN_CODES.find((candidate) => nationalNumber.startsWith(candidate));
  return code === undefined ? undefined : `0${code}`;
}

/** True when the geographic dataset knows this area code and can name a city for it. */
export function isDatasetAreaCode(areaCode: string | undefined): boolean {
  return areaCode !== undefined && DATASET_AREA_CODES.has(areaCode.replace(/^0/, ''));
}

/**
 * The municipality id a landline area code points at — the centre of its RATEL
 * network group, e.g. `021` → `novi-sad`, `032` → `cacak`.
 *
 * Undefined when the code is unknown or lies outside the geographic dataset.
 */
export function inferCityFromAreaCode(areaCode: string | undefined): string | undefined {
  return areaCode === undefined ? undefined : landlineGroupCenter(areaCode)?.id;
}
