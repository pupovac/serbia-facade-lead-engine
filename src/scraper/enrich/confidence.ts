/**
 * `assessCandidate` — is this page the same business as this lead?
 *
 * This is the function the whole issue exists for. Everything else in the
 * enrichment crawler is plumbing that can be re-run; a wrong answer here writes
 * a competitor's phone number onto a lead, ships it in the XLSX, and nobody
 * ever notices, because the row looks exactly like a good one.
 *
 * So it is pure: two records and an origin in, a verdict out. No database, no
 * network, no clock. The negative fixture set in `confidence.test.ts` — pages
 * of genuinely different businesses with genuinely similar names — runs against
 * it directly, and its measured false-merge rate is the acceptance criterion.
 *
 * ## It does not have a second opinion about identity
 *
 * `src/lib/dedup`'s `scoreMatch` already answers "are these the same business",
 * with a weighted signal model, a quarantine for shared identifiers and a
 * three-band verdict. Enrichment asks the same question about a page instead of
 * a stored row, so it *calls* that function rather than inventing a rival
 * ruleset which would drift from it the first time either was tuned.
 *
 * What this file adds is the three things `scoreMatch` has no reason to know:
 *
 * 1. **Ownership beats inference.** A page on a domain the lead already carries
 *    is the business's own site. Nothing has to be matched — the evidence is
 *    that the business publishes the page.
 * 2. **An arbitrary page off the open web can be a listing.** `scoreMatch`
 *    compares two records that each describe one business. A search result can
 *    be a directory category page carrying forty companies' phone numbers, and
 *    reading one as "the business" is the failure mode this crawler is most
 *    able to cause. It is a hard veto, not a penalty.
 * 3. **A merge here is not symmetric with a merge there.** The deduplicator
 *    merging two stored leads keeps both rows and can be walked back through
 *    `merge_log`; enrichment attaching a phone to a lead leaves a claim with
 *    provenance but no undo. So where the two could disagree, this file only
 *    ever moves in one direction — it demotes what `scoreMatch` would merge and
 *    never promotes what it would not.
 *
 * The thresholds, in one table, are in `thresholds.ts`.
 */
import { KNOWN_DIRECTORY_DOMAINS, SOCIAL_DOMAINS, registrableDomain } from '@/lib/contact';
import { scoreMatch, type MatchScore, type Signal } from '@/lib/dedup';
import {
  CONFIDENCE_BANDS,
  MAX_BUSINESSES_ON_PAGE,
  MAX_PHONES_ON_PAGE,
  OWN_SITE_CONFIDENCE,
} from './thresholds.js';
import type {
  ConfidenceInput,
  ConfidenceRuleId,
  ConfidenceVerdict,
  EnrichmentTier,
} from './types.js';

/** Which rule belongs to which outcome. The table in `thresholds.ts`, as code. */
export const RULE_TIER: Record<ConfidenceRuleId, EnrichmentTier> = {
  own_site: 'merge',
  decisive_identifier: 'merge',
  name_city_corroborated: 'merge',
  name_city_alone: 'suggest',
  corroboration_without_name: 'suggest',
  quarantined_identifier: 'suggest',
  page_is_a_listing: 'discard',
  origin_is_a_directory: 'discard',
  lead_has_no_place: 'discard',
  no_connection: 'discard',
  nothing_to_add: 'discard',
};

const DECISIVE_KINDS = new Set(['phone', 'website_domain', 'email', 'registration_number']);

/**
 * Weigh a fetched page against a stored lead and say what may be done with it.
 *
 * The order below is the rule order, and it is deliberate: the vetoes run
 * before anything can promote, and ownership runs before anything has to be
 * inferred.
 */
export function assessCandidate(input: ConfidenceInput): ConfidenceVerdict {
  const { lead, page, origin } = input;
  const match = scoreMatch(lead, page.candidateRecord, {
    ...(input.quarantine === undefined ? {} : { quarantine: input.quarantine }),
  });

  /* -- Veto 1: the page is about more than one business --------------------- */

  if (page.businessesOnPage > MAX_BUSINESSES_ON_PAGE || page.phones.length > MAX_PHONES_ON_PAGE) {
    return verdict(
      'page_is_a_listing',
      `the page publishes ${page.phones.length} numbers across ${page.businessesOnPage} businesses — ` +
        'a listing, not one business’s contact page',
      match,
      match.signals,
    );
  }

  /* -- Ownership: the page is on a domain the lead already carries ---------- */

  // Judged on the URL the response actually came from, not the one asked for:
  // a redirect from `firma.rs` to a parked-domain marketplace must not inherit
  // the trust of the domain that was requested. Everything below is gated on
  // `trusted`, so an own-site fetch that landed somewhere else is put through
  // exactly the checks a search result gets.
  const host = page.websiteDomain ?? hostOf(page.finalUrl);
  const registrable = host === null ? null : registrableDomain(host);
  const owned =
    registrable !== null && lead.websiteDomains.some((domain) => domain === registrable);
  const trusted = origin === 'own_site' && owned;

  if (trusted) {
    return {
      tier: 'merge',
      confidence: OWN_SITE_CONFIDENCE,
      rule: 'own_site',
      reason: `${registrable} is the lead’s own domain — the business publishes this page`,
      signals: match.signals,
      match,
    };
  }

  /* -- Veto 2: a directory or a platform ------------------------------------ */

  // A domain the lead already carries has been through `src/lib/contact`'s
  // rejection rules, which is where a directory link is supposed to be caught;
  // anything else reaching this crawler has not.
  if (
    registrable !== null &&
    (KNOWN_DIRECTORY_DOMAINS.has(registrable) || SOCIAL_DOMAINS.has(registrable))
  ) {
    return verdict(
      'origin_is_a_directory',
      `${registrable} is a directory or a platform, not the business’s own page`,
      match,
      match.signals,
    );
  }

  const decisive = match.signals.filter((signal) => DECISIVE_KINDS.has(signal.kind));
  const blocked = match.signals.filter((signal) => signal.role === 'blocked');
  const nameCity = match.signals.find((signal) => signal.kind === 'name_city');

  /* -- Veto 3: a lead with no city can never have a name corroborated ------- */

  // `scoreMatch` reaches the same verdict — a name only counts when the place
  // agrees — but it reports it as "no signal strong enough", which reads like a
  // weak page rather than like a lead that cannot be matched by name at all.
  // Saying so precisely is what makes the rejection tally actionable.
  if (decisive.length === 0 && lead.cityId === null && lead.municipalityId === null) {
    return verdict(
      'lead_has_no_place',
      'the lead has no city, so a matching name is not evidence — Serbia has many of every name',
      match,
      match.signals,
    );
  }

  /* -- The ladder ----------------------------------------------------------- */

  if (match.decision === 'merge') {
    // There is no city-conflict branch here, and that is not an omission. A
    // name only ever counts when the place agrees, so a name match and a city
    // conflict cannot both be true; and a *decisive* identifier legitimately
    // crosses municipalities — one business with a yard in Novi Sad and an
    // office in Belgrade publishes the same number on both. `city_conflict`
    // reaches this function only as an opposing weight, which is what it is.
    if (decisive.length > 0) {
      return verdict(
        'decisive_identifier',
        `the page and the lead share ${decisive[0]?.detail ?? 'a decisive identifier'}`,
        match,
        decisive,
      );
    }
    const corroborating = match.signals.filter(
      (signal) => signal.role === 'corroborating' && signal.kind !== 'name_city',
    );
    return verdict(
      'name_city_corroborated',
      `name match in the same place, corroborated by ${corroborating[0]?.detail ?? 'a second signal'}`,
      match,
      match.signals.filter((signal) => signal.role === 'corroborating'),
    );
  }

  if (match.decision === 'review') {
    if (blocked.length > 0) {
      return verdict(
        'quarantined_identifier',
        `the only decisive signal is quarantined: ${blocked[0]?.detail ?? ''}`,
        match,
        blocked,
      );
    }
    if (nameCity !== undefined) {
      return verdict(
        'name_city_alone',
        'a strong name match in the same place, with nothing corroborating it — a human decides',
        match,
        [nameCity],
      );
    }
    return verdict(
      'corroboration_without_name',
      `${match.reason} — a human decides`,
      match,
      match.signals.filter((signal) => signal.role === 'corroborating'),
    );
  }

  return verdict('no_connection', match.reason, match, match.signals);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the verdict, clamping the underlying match score into the band its rule
 * chose.
 *
 * The rule picks the band and the score orders the queue inside it — the same
 * split `src/lib/dedup` makes, for the same reason: one number that had to do
 * both jobs would do neither, and the first tuning change would silently move
 * real merges into the review queue.
 */
function verdict(
  rule: ConfidenceRuleId,
  reason: string,
  match: MatchScore,
  signals: readonly Signal[],
): ConfidenceVerdict {
  const tier = RULE_TIER[rule];
  const band = CONFIDENCE_BANDS[tier];
  const confidence = Math.round(Math.min(Math.max(match.score, band.min), band.max) * 1000) / 1000;
  return { tier, confidence, rule, reason, signals, match };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
