/**
 * `scoreMatch` — are these two records the same business?
 *
 * Pure, and deliberately so: no database, no side effects, no reads of anything
 * but its two arguments and the quarantine it is handed. Every rule in the
 * project's data contract is a branch in here, and every one of them is tested
 * against the messy cases rather than the happy path.
 *
 * ## The rules, strongest first
 *
 * 1. **Shared normalized phone** — decisive on its own.
 * 2. **Shared website domain** — decisive.
 * 3. **Shared business email** — decisive.
 *    (Registration number sits above all three: it is a state-issued key.)
 * 4. **Name similarity above threshold, same city** — strong, and *never*
 *    decisive alone. It needs one corroborating signal — a shared address, a
 *    shared social profile, the same landline area code — before it merges.
 * 5. **Same normalized address + similar name** — that is rule 4 with its
 *    corroboration, and it merges.
 *
 * **Never merge on name similarity alone.** Two `Fasade Petrović` in different
 * cities are two businesses, and two in the same city might still be.
 *
 * ## Why the decision is not a threshold on the score
 *
 * Because the rules are structural. A shared phone merges regardless of how
 * different the names are — that is what "decisive" means — and a 0.99 name
 * match with nothing behind it does not merge however high it scores. So the
 * rules pick the band and the score is clamped into it; inside a band the score
 * orders the review queue. A single number that had to do both jobs would end
 * up doing neither, and the first tuning change would silently move real
 * merges into the review queue.
 *
 * ## The middle band
 *
 * `review` is a first-class outcome, not a failure to decide. It is what the
 * Stage 5 UI lists, it carries its signals the same way a classification
 * carries its evidence, and a reviewer's `no` is remembered so the pair is not
 * proposed again.
 */
import { RECOMMENDED_NAME_MATCH_THRESHOLD, normalizedNameSimilarity } from '../normalize/index.js';
import { areaCodeFor } from '../phone/index.js';
import {
  BANDS,
  CITY_CONFLICT_PENALTY,
  NAME_WEIGHT,
  SIGNAL_WEIGHTS,
  WEAK_NAME_MIN,
  WEAK_NAME_WEIGHT,
} from './weights.js';
import {
  NO_QUARANTINE,
  type LeadRecord,
  type MatchDecision,
  type MatchScore,
  type MatchSignalName,
  type Quarantine,
  type Signal,
} from './types.js';

export interface ScoreMatchOptions {
  /** Which decisive values have lost the right to decide. Defaults to none. */
  readonly quarantine?: Quarantine | undefined;
}

/**
 * Weigh two records against each other and say what should happen to them.
 *
 * The pair is unordered: `scoreMatch(a, b)` and `scoreMatch(b, a)` return the
 * same decision and the same score.
 */
export function scoreMatch(
  a: LeadRecord,
  b: LeadRecord,
  options: ScoreMatchOptions = {},
): MatchScore {
  const quarantine = options.quarantine ?? NO_QUARANTINE;
  const signals: Signal[] = [];

  /* -- Registration number: the state's own key ---------------------------- */

  const registrationMatch = sameValue(a.registrationNumber, b.registrationNumber);
  const registrationConflict =
    a.registrationNumber != null &&
    b.registrationNumber != null &&
    a.registrationNumber !== b.registrationNumber;

  if (registrationMatch != null) {
    signals.push({
      kind: 'registration_number',
      value: registrationMatch,
      weight: SIGNAL_WEIGHTS.registrationNumber,
      role: 'decisive',
      detail: `both registered as ${registrationMatch}`,
    });
  }
  if (registrationConflict) {
    signals.push({
      kind: 'registration_conflict',
      value: `${a.registrationNumber} vs ${b.registrationNumber}`,
      weight: 1,
      role: 'opposing',
      detail: 'two different registration numbers: two registered businesses',
    });
  }

  /* -- Phones, domains, emails: decisive unless quarantined ---------------- */

  for (const phone of overlap(a.phones, b.phones)) {
    const blocked = quarantine.has('phone', phone);
    signals.push({
      kind: blocked ? 'quarantined_identifier' : 'phone',
      value: phone,
      weight: SIGNAL_WEIGHTS.phone,
      role: blocked ? 'blocked' : 'decisive',
      detail: blocked
        ? `${phone} is published by too many different businesses to identify one`
        : `both publish ${phone}`,
    });
  }

  for (const domain of overlap(a.websiteDomains, b.websiteDomains)) {
    const blocked = quarantine.has('website_domain', domain);
    signals.push({
      kind: blocked ? 'quarantined_identifier' : 'website_domain',
      value: domain,
      weight: SIGNAL_WEIGHTS.websiteDomain,
      role: blocked ? 'blocked' : 'decisive',
      detail: blocked
        ? `${domain} is a shared or directory-owned domain, not a business identity`
        : `both link to ${domain}`,
    });
  }

  for (const email of overlap(a.emails, b.emails)) {
    const blocked = quarantine.has('email', email);
    signals.push({
      kind: blocked ? 'quarantined_identifier' : 'email',
      value: email,
      weight: SIGNAL_WEIGHTS.email,
      role: blocked ? 'blocked' : 'decisive',
      detail: blocked
        ? `${email} is a directory-owned or widely shared address`
        : `both publish ${email}`,
    });
  }

  /* -- Place ---------------------------------------------------------------- */

  const sameCity = a.cityId != null && b.cityId != null && a.cityId === b.cityId;
  const sameMunicipality =
    a.municipalityId != null && b.municipalityId != null && a.municipalityId === b.municipalityId;
  const cityConflict =
    a.cityId != null && b.cityId != null && a.cityId !== b.cityId && !sameMunicipality;

  if (cityConflict) {
    signals.push({
      kind: 'city_conflict',
      value: `${a.cityId} vs ${b.cityId}`,
      weight: CITY_CONFLICT_PENALTY,
      role: 'opposing',
      detail: 'placed in two different municipalities',
    });
  }

  /* -- Name: strong, never decisive ---------------------------------------- */

  const similarity = normalizedNameSimilarity(a.nameKey, b.nameKey);
  // The same place, by city or by the municipality the two cities roll up to.
  // A name only ever counts when the place agrees: `Fasade Petrović` in Niš and
  // in Novi Sad are two businesses, and no name score changes that.
  const samePlace = sameCity || sameMunicipality;
  const nameKey = a.nameKey.ascii || b.nameKey.ascii;

  let strongName = false;
  if (samePlace && similarity >= RECOMMENDED_NAME_MATCH_THRESHOLD) {
    strongName = true;
    signals.push({
      kind: 'name_city',
      value: nameKey,
      weight: nameWeight(similarity),
      role: 'corroborating',
      detail: `${round(similarity)} name similarity in the same place`,
    });
  } else if (samePlace && similarity >= WEAK_NAME_MIN) {
    signals.push({
      kind: 'name_weak',
      value: nameKey,
      weight:
        (WEAK_NAME_WEIGHT * (similarity - WEAK_NAME_MIN)) /
        (RECOMMENDED_NAME_MATCH_THRESHOLD - WEAK_NAME_MIN),
      role: 'supporting',
      detail: `${round(similarity)} name similarity in the same place, below the merge threshold`,
    });
  }

  /* -- Corroboration -------------------------------------------------------- */

  const address = sameValue(a.addressNormalized, b.addressNormalized);
  if (address != null) {
    signals.push({
      kind: 'address',
      value: address,
      weight: SIGNAL_WEIGHTS.address,
      role: 'corroborating',
      detail: `both at ${address}`,
    });
  }

  for (const profile of overlap(a.socialUrls, b.socialUrls)) {
    signals.push({
      kind: 'social_profile',
      value: profile,
      weight: SIGNAL_WEIGHTS.socialProfile,
      role: 'corroborating',
      detail: `both linked to ${profile}`,
    });
  }

  // A quarantined number may not corroborate through its own prefix either:
  // the guard disarmed that number, and letting its area code back in as
  // "supporting evidence" would be laundering the signal it just refused.
  const trustedPhones = (phones: readonly string[]): string[] =>
    phones.filter((phone) => !quarantine.has('phone', phone));
  const landlines = sharedLandlinePrefix(trustedPhones(a.phones), trustedPhones(b.phones));
  if (landlines != null) {
    signals.push({
      kind: 'phone_area_code',
      value: landlines.prefix,
      weight: landlines.sameBlock ? SIGNAL_WEIGHTS.phoneBlock : SIGNAL_WEIGHTS.phoneAreaCode,
      role: landlines.sameBlock ? 'corroborating' : 'supporting',
      detail: landlines.sameBlock
        ? `two landlines in the same subscriber range (${landlines.prefix})`
        : `landlines in the same area code (${landlines.prefix})`,
    });
  }

  /* -- The verdict ---------------------------------------------------------- */

  const decisive = signals.filter((s) => s.role === 'decisive');
  const blocked = signals.filter((s) => s.role === 'blocked');
  const corroborating = signals.filter((s) => s.role === 'corroborating' && s.kind !== 'name_city');

  let decision: MatchDecision;
  let reason: string;

  if (decisive.length > 0 && registrationConflict) {
    decision = 'review';
    reason =
      'a decisive signal matches, but the two records carry different registration numbers — a human decides';
  } else if (decisive.length > 0) {
    decision = 'merge';
    reason = `decisive signal: ${decisive[0]?.detail ?? ''}`;
  } else if (blocked.length > 0 && (strongName || corroborating.length > 0)) {
    decision = 'review';
    reason = `the decisive signal is quarantined: ${blocked[0]?.detail ?? ''}`;
  } else if (blocked.length > 0) {
    // A value the quarantine has ruled cannot identify a business, and nothing
    // corroborating it — a shared area code is not corroboration, for the same
    // reason it is not corroboration anywhere else. Queueing this would ask a
    // human to re-decide what the guard decided, and one switchboard across two
    // hundred leads is twenty thousand such pairs: a review queue nobody opens
    // twice. The `shared_identifiers` row is the artifact to review instead.
    decision = 'distinct';
    reason = `the only thing these share is quarantined: ${blocked[0]?.detail ?? ''}`;
  } else if (registrationConflict) {
    decision = 'distinct';
    reason = 'two different registration numbers';
  } else if (strongName && corroborating.length > 0) {
    decision = 'merge';
    reason = `name match in the same place, corroborated by ${corroborating[0]?.kind}`;
  } else if (strongName) {
    decision = 'review';
    reason = 'a strong name match in the same place, with nothing corroborating it';
  } else if (corroborating.length > 0) {
    decision = 'review';
    reason = `${corroborating[0]?.detail ?? 'corroborating evidence'}, but the names do not match`;
  } else {
    decision = 'distinct';
    reason = 'no signal strong enough to connect these two records';
  }

  const raw = combine(signals);
  const band = BANDS[decision];
  const score = clamp(raw, band.min, band.max);
  const top = topSignal(signals);

  return {
    score: round(score),
    signals,
    decision,
    topSignal: top.name,
    topSignalValue: top.value,
    reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Arithmetic                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Noisy-or over the evidence for, discounted by the evidence against.
 *
 * Two independent signals reinforce each other and never sum past 1, which is
 * the property a plain weighted sum does not have and the reason a lead with
 * five weak signals does not out-score a lead with one decisive one.
 */
function combine(signals: readonly Signal[]): number {
  let against = 1;
  let notFor = 1;
  for (const signal of signals) {
    if (signal.role === 'opposing') against *= 1 - clamp(signal.weight, 0, 1);
    else if (signal.role !== 'blocked') notFor *= 1 - clamp(signal.weight, 0, 1);
  }
  return (1 - notFor) * against;
}

function nameWeight(similarity: number): number {
  const span = 1 - RECOMMENDED_NAME_MATCH_THRESHOLD;
  const position = span === 0 ? 1 : (similarity - RECOMMENDED_NAME_MATCH_THRESHOLD) / span;
  return NAME_WEIGHT.min + (NAME_WEIGHT.max - NAME_WEIGHT.min) * clamp(position, 0, 1);
}

const SIGNAL_NAMES: Partial<Record<Signal['kind'], MatchSignalName>> = {
  registration_number: 'registration_number',
  phone: 'phone',
  website_domain: 'website_domain',
  email: 'email',
  name_city: 'name_city',
  address: 'address',
  social_profile: 'social_profile',
};

/**
 * The signal a merge would be filed under — the rule that decided it, not
 * merely the heaviest thing observed.
 *
 * Order: a decisive signal, because it decides on its own; then the name match,
 * because when a pair merges without one of those, rule 4 is what merged it and
 * the corroboration only unlocked it; then whatever else argued for the pair.
 * A blocked signal is the headline only when nothing positive is left, which is
 * exactly the quarantined-identifier review case. A pair with nothing at all
 * reports an empty `name_city` — its `distinct` verdict is what a caller reads,
 * not this.
 */
function topSignal(signals: readonly Signal[]): { name: MatchSignalName; value: string } {
  const named = (signal: Signal): { name: MatchSignalName; value: string } => ({
    name: SIGNAL_NAMES[signal.kind] ?? 'name_city',
    value: signal.value,
  });

  const decisive = signals
    .filter((s) => s.role === 'decisive')
    .sort((x, y) => y.weight - x.weight)[0];
  if (decisive) return named(decisive);

  const nameCity = signals.find((s) => s.kind === 'name_city');
  if (nameCity) return named(nameCity);

  const rest = signals
    .filter((s) => s.role !== 'opposing' && s.role !== 'blocked' && SIGNAL_NAMES[s.kind] != null)
    .sort((x, y) => y.weight - x.weight)[0];
  if (rest) return named(rest);

  const blocked = signals.find((s) => s.role === 'blocked');
  if (blocked) {
    const kind: MatchSignalName = blocked.value.startsWith('+')
      ? 'phone'
      : blocked.value.includes('@')
        ? 'email'
        : 'website_domain';
    return { name: kind, value: blocked.value };
  }
  return { name: 'name_city', value: '' };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function overlap(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const other = new Set(b);
  return [...new Set(a)].filter((value) => other.has(value));
}

function sameValue(a: string | null, b: string | null): string | null {
  if (a == null || b == null) return null;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === '' || left !== right) return null;
  return left;
}

/**
 * What two sets of landlines have in common.
 *
 * Two levels, because they mean very different things:
 *
 * - **The same area code** is almost nothing. Every business in Belgrade has an
 *   `011` number, and a name match already requires the same city, so this adds
 *   no information at all — it is recorded as weight and never as corroboration.
 * - **The same subscriber range** — every digit but the last two — is real
 *   evidence. `011 444 5501` and `011 444 5502` are two extensions of one PBX
 *   far more often than they are two unrelated companies, and that is what
 *   "overlapping phone prefix" is worth as corroboration for a name match.
 *   Anything shorter picks up the town exchange instead, which is the `011`
 *   problem one level down.
 *
 * Mobile prefixes are ignored at both levels: `064` says which operator sold
 * the SIM, and would otherwise "corroborate" a quarter of Serbia.
 */
function sharedLandlinePrefix(
  a: readonly string[],
  b: readonly string[],
): { readonly prefix: string; readonly sameBlock: boolean } | null {
  const blocks = (phones: readonly string[]): Map<string, Set<string>> => {
    const found = new Map<string, Set<string>>();
    for (const phone of phones) {
      if (!phone.startsWith('+381')) continue;
      const national = phone.slice(4);
      const code = areaCodeFor(national);
      // `06x` is an operator prefix, not a place.
      if (code == null || code.startsWith('06')) continue;
      // Everything but the last two digits: `011 444 5501` and `011 444 5502`
      // are two extensions of one range, while `024 666 1122` and
      // `024 666 3344` merely share a town exchange and mean nothing.
      const subscriber = national.slice(code.length - 1);
      if (subscriber.length < 4) continue;
      const set = found.get(code) ?? new Set<string>();
      set.add(subscriber.slice(0, -2));
      found.set(code, set);
    }
    return found;
  };

  const left = blocks(a);
  const right = blocks(b);
  let areaCodeOnly: string | null = null;
  for (const [code, rightBlocks] of right) {
    const leftBlocks = left.get(code);
    if (leftBlocks == null) continue;
    for (const block of rightBlocks) {
      if (leftBlocks.has(block)) return { prefix: `${code} ${block}`, sameBlock: true };
    }
    areaCodeOnly ??= code;
  }
  return areaCodeOnly == null ? null : { prefix: areaCodeOnly, sameBlock: false };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
