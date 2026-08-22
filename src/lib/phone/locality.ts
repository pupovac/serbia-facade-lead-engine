/**
 * Which of a record's phone numbers actually ring at *this* address.
 *
 * One listing page routinely publishes a whole company's switchboard: the
 * pilot's `portal-srbija` record for `Srma group` carries six numbers — Zemun,
 * Kraljevo, Niš, Šabac and Vranje — under one Belgrade address, and
 * `gradjevinarstvo.rs` labels them outright (`021 xxxx xxx, CENTRALA BEČEJ`).
 * Stored flat, every one of those becomes an identity for the Belgrade lead,
 * and the dedup sweep then merges the four real branch leads into it. That is
 * exactly what happened to `GDC S.R.M.A` in the pilot: five correct leads, four
 * of them destroyed by a phone that was never theirs.
 *
 * So each number is scoped, and the scope decides one thing only: whether the
 * number may be used as an **identity**. Nothing is discarded — a branch number
 * is a real, dialable Serbian business line and the phone is this project's
 * deliverable — it simply stops being allowed to say "these two leads are the
 * same business".
 *
 * ## The two tells, and why each needs a guard
 *
 * 1. **The label names another place.** `CENTRALA BEČEJ` on a record filed in
 *    Belgrade is the source itself telling us the number is elsewhere. This is
 *    the strong tell and needs no corroboration.
 * 2. **The area code contradicts the record, and another number agrees with
 *    it.** A geographic landline whose network group does not contain the
 *    record's own municipality is suspicious — but only when the record also
 *    carries a number that *does* fit. A lone `019…` on a lead filed under
 *    Belgrade is far more likely to be a city that resolved wrong (the pilot
 *    has `DOO Zidar, Negotin` filed under `beograd`) than a branch, and
 *    demoting a business's only number would cost the lead its deliverable.
 *
 * Mobiles, toll-free and `0700` numbers are never scoped as branch lines: they
 * carry no geography at all, so there is nothing to contradict.
 */
import { getMunicipalityById, municipalities, municipalitiesByLandlinePrefix } from '../geo.js';
import { foldForComparison } from '../text/fold.js';
import { isDatasetAreaCode } from './serbian-numbering.js';
import type { PhoneScope } from '../db/schema.js';

export type { PhoneScope };

/** The minimum a scope decision needs to know about one number. */
export interface ScopablePhone {
  readonly type: string;
  readonly valid?: boolean | undefined;
  readonly areaCode?: string | undefined;
  readonly label?: string | undefined;
}

export interface ScopeContext {
  /** The municipality the record itself was filed under, or `null` when none resolved. */
  readonly municipalityId: string | null;
}

/**
 * Does this area code's network group contain that municipality?
 *
 * The comparison is against the whole RATEL group rather than the
 * municipality's own prefix, because a group covers several municipalities:
 * `011` is every Belgrade city municipality, and a Zemun business publishing an
 * `011` number is not a contradiction.
 */
export function areaCodeCovers(areaCode: string | undefined, municipalityId: string): boolean {
  if (!isDatasetAreaCode(areaCode)) return false;
  return municipalitiesByLandlinePrefix(areaCode as string).some((m) => m.id === municipalityId);
}

/** True when this number carries geography that can be checked at all. */
function isGeographic(phone: ScopablePhone): boolean {
  return phone.valid !== false && phone.type === 'landline' && isDatasetAreaCode(phone.areaCode);
}

/**
 * Does the label name a municipality other than the record's own?
 *
 * Only an exact municipality name counts. `PRODAJA` and `CENTRALA` name no
 * place and mean nothing here; `CENTRALA BEČEJ` names one.
 */
export function labelNamesAnotherPlace(
  label: string | undefined,
  municipalityId: string | null,
): boolean {
  if (label === undefined || label.trim() === '') return false;
  const words = foldForComparison(label)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return false;

  const own = municipalityId === null ? null : getMunicipalityById(municipalityId);
  const ownNames = own === undefined || own === null ? [] : [foldForComparison(own.name_sr)];

  for (const municipality of MUNICIPALITY_NAME_INDEX) {
    if (!containsPhrase(words, municipality.words)) continue;
    if (ownNames.includes(municipality.folded)) return false;
    return true;
  }
  return false;
}

function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Every municipality name, folded and pre-split, longest first so `Novi Sad`
 * is tested before `Sad` could ever matter.
 */
const MUNICIPALITY_NAME_INDEX: readonly {
  readonly folded: string;
  readonly words: readonly string[];
}[] = municipalityNameIndex();

function municipalityNameIndex(): readonly {
  readonly folded: string;
  readonly words: readonly string[];
}[] {
  const seen = new Set<string>();
  const index: { folded: string; words: readonly string[] }[] = [];
  for (const municipality of municipalities) {
    const folded = foldForComparison(municipality.name_sr);
    if (folded === '' || seen.has(folded)) continue;
    seen.add(folded);
    index.push({ folded, words: folded.split(/[^a-z0-9]+/).filter(Boolean) });
  }
  return index.sort((a, b) => b.words.length - a.words.length);
}

/**
 * Scope every phone on one record.
 *
 * Returns one scope per input, in the same order. Pure: the record's own
 * municipality is passed in, nothing is read from a database.
 */
export function scopePhones<T extends ScopablePhone>(
  phones: readonly T[],
  context: ScopeContext,
): readonly PhoneScope[] {
  const { municipalityId } = context;

  const agreeing =
    municipalityId === null
      ? 0
      : phones.filter(
          (phone) => isGeographic(phone) && areaCodeCovers(phone.areaCode, municipalityId),
        ).length;
  const nonGeographic = phones.filter(
    (phone) => phone.valid !== false && !isGeographic(phone),
  ).length;
  // A record that anchors itself — it has a number that fits its own address —
  // is one whose other-region numbers can be read as branches.
  const anchored = agreeing > 0 || nonGeographic > 0;

  return phones.map((phone) => {
    if (labelNamesAnotherPlace(phone.label, municipalityId)) return 'branch';
    if (municipalityId === null || !anchored) return 'business';
    if (!isGeographic(phone)) return 'business';
    return areaCodeCovers(phone.areaCode, municipalityId) ? 'business' : 'branch';
  });
}
