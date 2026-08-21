/**
 * Turning a verdict into rows.
 *
 * `findingsFrom` is pure — what this page adds that the lead has not already
 * got — and everything else is the write path for the two outcomes that write
 * anything: a `merge` attaches the values to the lead, a `suggest` queues them
 * for a human. `discard` writes nothing by design; it is counted and logged.
 *
 * ## Why this does not go through the scraper pipeline
 *
 * `normalizeRawLead` + `persistLead` is the adapter write path, and enrichment
 * cannot use it for two independent reasons.
 *
 * **It would re-classify.** `persistLead` re-grades the lead from the record it
 * just wrote, label included. That is right for an adapter — a directory
 * listing describes the business, so its categories and its prose are evidence
 * about what the business *is*. It is wrong here: a contact page is evidence
 * about how to *reach* a business, and running the classifier over a page whose
 * only text is "Kontakt" would turn a confident `FACADE_CONTRACTOR` into
 * `UNKNOWN` and drop the lead out of the export.
 *
 * **It would re-run the extractors with the wrong `sourceDomain`.**
 * `normalizeRawLead` derives that from `sourceUrl`, which for enrichment is the
 * business's own page — so `info@mikafasade.rs`, read off mikafasade.rs, comes
 * back out classified as a directory-owned address and is dropped. `page.ts`
 * has already run those extractors, correctly, and hands the results over on
 * `PageEvidence.contacts`; this file selects from them rather than asking for
 * them twice.
 *
 * So enrichment writes the claims, re-computes the **score** over the enlarged
 * lead, and leaves the label exactly where the classifier put it.
 *
 * ## Why it goes through `upsertLead` at all
 *
 * Because `upsertLead` fills blanks and never overwrites. A page that disagrees
 * with a stored value records a claim in `lead_field_values` with its own
 * provenance and reports a conflict; it does not win. That is the behaviour
 * enrichment needs and it already exists — re-implementing it here would be a
 * second, subtly different set of merge rules.
 *
 * `matching: 'caller'` is what makes the target binding real: the confidence
 * rules have already decided which lead this page belongs to, with the full
 * rule set, and letting `upsertLead`'s exact matcher re-decide on a phone would
 * quietly re-point the write at a different lead.
 */
import {
  applyGrading,
  attachSource,
  distinctPhones,
  getLead,
  leadContactClaims,
  leadSourceRows,
  rejectedValues,
  recordSuggestion,
  saveRawRecord,
  upsertLead,
  type Db,
  type LeadInput,
  type PhoneInput,
  type Provenance,
  type SuggestionKind,
} from '@/lib/db';
import { scoreLead, toScoreInput } from '@/lib/score';
import { normalizeAddress, normalizeCompanyName, resolveCityDetailed } from '@/lib/normalize';
import { normalizePhone, toPhoneInput } from '@/lib/phone';
import { validateRawLead, type RawLeadInput } from '../raw-lead.js';
import type {
  ConfidenceVerdict,
  EnrichableField,
  EnrichmentFinding,
  EnrichmentTarget,
  PageEvidence,
} from './types.js';

/** Which `SuggestionKind` each social network is stored under. */
const SOCIAL_KIND: Record<string, SuggestionKind> = {
  facebook: 'facebook',
  instagram: 'instagram',
  googleMaps: 'google_maps',
};

/**
 * What this page would add to this lead.
 *
 * Only values the lead has not already got: re-attaching a phone it already
 * carries is not enrichment, and counting it as "a field added" would make the
 * run report meaningless. Pure, so the report's numbers are testable without a
 * database.
 */
export function findingsFrom(target: EnrichmentTarget, page: PageEvidence): EnrichmentFinding[] {
  const record = target.record;
  const findings: EnrichmentFinding[] = [];

  const knownPhones = new Set(record.phones);
  for (const phone of page.phones) {
    if (knownPhones.has(phone.e164)) continue;
    findings.push({ kind: 'phone', value: phone.e164, valueRaw: phone.raw, field: 'phone' });
  }

  const knownEmails = new Set(record.emails.map((email) => email.toLowerCase()));
  for (const email of page.emails) {
    if (knownEmails.has(email.toLowerCase())) continue;
    findings.push({ kind: 'email', value: email, valueRaw: email, field: 'email' });
  }

  if (page.website !== null && page.websiteDomain !== null) {
    const known = new Set(record.websiteDomains);
    // Compared on the registrable domain, which is what the lead stores and
    // what dedup keys on — `www.firma.rs` is not a new website.
    if (![...known].some((domain) => page.websiteDomain?.endsWith(domain) === true)) {
      findings.push({
        kind: 'website',
        value: page.website,
        valueRaw: page.website,
        field: 'website',
      });
    }
  }

  const knownSocials = new Set(record.socialUrls);
  for (const social of page.socials) {
    if (knownSocials.has(social.url)) continue;
    findings.push({
      kind: SOCIAL_KIND[social.network] ?? 'other',
      value: social.url,
      valueRaw: social.url,
      field: 'social',
    });
  }

  if (
    page.address !== null &&
    (record.addressNormalized === null || record.addressNormalized === '')
  ) {
    findings.push({
      kind: 'address',
      value: page.address,
      valueRaw: page.address,
      field: 'address',
    });
  }

  if (page.cityId !== null && record.cityId === null && record.municipalityId === null) {
    findings.push({
      kind: 'city',
      value: page.cityId,
      valueRaw: page.cityRaw,
      field: 'city',
    });
  }

  return findings;
}

export interface ApplyOptions {
  /** The pseudo-source the claims are written under. See `sources.ts`. */
  readonly sourceId: string;
  readonly runId?: number | null | undefined;
  readonly now?: Date | undefined;
}

export interface ApplyResult {
  readonly leadId: number;
  readonly phonesAdded: number;
  readonly contactsAdded: number;
  readonly conflictsRecorded: number;
  /** How many findings of each kind were written. Keyed as the report prints them. */
  readonly fieldsAdded: Readonly<Partial<Record<EnrichableField, number>>>;
  /** The lead score after the enrichment, recomputed over the whole lead. */
  readonly score: number;
  /** The score before it, so the report can state what enrichment was worth. */
  readonly scoreBefore: number;
}

/**
 * Attach a merge-tier page's findings to the lead.
 *
 * A value a reviewer has already rejected for this lead is skipped, whatever
 * this run's evidence says. A later run finding one more corroborating signal
 * must not overturn a human, and the queue is the only place that decision was
 * ever recorded.
 */
export function applyMerge(
  db: Db,
  target: EnrichmentTarget,
  page: PageEvidence,
  verdict: ConfidenceVerdict,
  findings: readonly EnrichmentFinding[],
  options: ApplyOptions,
): ApplyResult {
  const now = options.now ?? new Date();
  const rejected = rejectedValues(db, target.leadId);
  const kept = findings.filter((finding) => !rejected.has(`${finding.kind}:${finding.value}`));

  const before = getLead(db, target.leadId);
  const scoreBefore = before?.leadScore ?? 0;

  const raw = rawLeadFrom(target, page, kept, options.sourceId, verdict);
  const validated = validateRawLead(raw, options.sourceId);
  /* c8 ignore next 3 -- the payload is built here from validated pieces */
  if (!validated.ok) {
    throw new Error(`enrichment record failed validation: ${validated.error}`);
  }
  const lead = validated.lead;

  const archived = saveRawRecord(db, {
    sourceId: options.sourceId,
    sourceUrl: page.finalUrl,
    payload: JSON.stringify({ raw: lead, verdict: verdictPayload(verdict) }),
    runId: options.runId ?? null,
    status: 'normalized',
    seenAt: now,
  });

  const provenance: Provenance = {
    sourceId: options.sourceId,
    sourceUrl: page.finalUrl,
    seenAt: now,
    runId: options.runId ?? null,
    rawRecordId: archived.id,
  };

  const result = upsertLead(db, leadInputFrom(target, page, kept), provenance, {
    matching: 'caller',
  });
  attachSource(db, result.leadId, provenance);

  const stored = getLead(db, result.leadId);
  /* c8 ignore next -- `upsertLead` just wrote it */
  if (stored === undefined) throw new Error(`lead ${result.leadId} vanished after enrichment`);

  // Re-score over the whole lead, and keep the classifier's label. Enrichment
  // learns how to reach a business, never what it is.
  const city =
    stored.cityId === null
      ? null
      : (() => {
          const resolution = resolveCityDetailed(stored.cityRaw ?? stored.cityId);
          return resolution.ok ? resolution.match : null;
        })();

  const rescored = scoreLead(
    toScoreInput({
      lead: stored,
      phones: distinctPhones(db, result.leadId),
      contacts: leadContactClaims(db, result.leadId),
      sources: leadSourceRows(db, result.leadId),
      city,
      now,
    }),
  );

  applyGrading(
    db,
    result.leadId,
    {
      classification: stored.classification,
      classificationConfidence: stored.classificationConfidence ?? 0,
      classificationEvidence: stored.classificationEvidence ?? null,
      leadScore: rescored.score,
      scoreBreakdown: JSON.stringify(rescored.components),
    },
    now,
  );

  return {
    leadId: result.leadId,
    phonesAdded: result.phonesAdded,
    contactsAdded: result.contactsAdded,
    conflictsRecorded: result.conflictsRecorded,
    fieldsAdded: countByField(kept),
    score: rescored.score,
    scoreBefore,
  };
}

/**
 * Queue a medium-confidence page's findings for review.
 *
 * One row per proposed value rather than one per page: a reviewer accepting the
 * phone number and rejecting the address is the normal case, and a
 * page-shaped row would force them to take both or neither.
 */
export function queueSuggestions(
  db: Db,
  target: EnrichmentTarget,
  page: PageEvidence,
  verdict: ConfidenceVerdict,
  findings: readonly EnrichmentFinding[],
  options: ApplyOptions,
): number {
  const now = options.now ?? new Date();
  const evidence = JSON.stringify(verdictPayload(verdict));
  let queued = 0;

  for (const finding of findings) {
    const result = recordSuggestion(db, {
      leadId: target.leadId,
      kind: finding.kind,
      value: finding.value,
      valueRaw: finding.valueRaw,
      sourceUrl: page.finalUrl,
      origin: verdict.rule === 'own_site' ? 'own_site' : 'discovered',
      confidence: verdict.confidence,
      rule: verdict.rule,
      reason: verdict.reason,
      evidence,
      runId: options.runId ?? null,
      seenAt: now,
    });
    if (result.created) queued += 1;
  }
  return queued;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The findings in the standard `RawLead` shape, for `raw_records` only.
 *
 * It is not what gets written to the lead — `leadInputFrom` is — but the
 * archive is the insurance policy against a parser bug, and a payload in the
 * shape every other archived record uses is one a future re-normalization pass
 * can read without a special case.
 *
 * The **lead's own name** goes on the record, not the page's `<title>`. The
 * page is evidence about contact details; letting it also restate the business
 * name would file `Kontakt | Fasade Petrović` as a competing claim for the name
 * field on every enrichment run.
 */
function rawLeadFrom(
  target: EnrichmentTarget,
  page: PageEvidence,
  findings: readonly EnrichmentFinding[],
  sourceId: string,
  verdict: ConfidenceVerdict,
): RawLeadInput {
  const of = (field: EnrichableField): EnrichmentFinding[] =>
    findings.filter((finding) => finding.field === field);

  const address = of('address')[0];
  const city = of('city')[0];
  const website = of('website')[0];

  return {
    sourceId,
    sourceUrl: page.finalUrl,
    name: target.name,
    phones: of('phone').map((finding) => finding.valueRaw ?? finding.value),
    emails: of('email').map((finding) => finding.value),
    ...(website === undefined ? {} : { website: website.value }),
    socials: of('social').map((finding) => finding.value),
    ...(address === undefined ? {} : { address: address.value }),
    ...(city === undefined ? {} : { city: city.valueRaw ?? city.value }),
    ...(page.postalCode === null ? {} : { postalCode: page.postalCode }),
    extra: {
      enrichment: {
        rule: verdict.rule,
        tier: verdict.tier,
        confidence: verdict.confidence,
        pageUrl: page.url,
      },
    },
  };
}

/**
 * What actually gets written to the lead.
 *
 * Every value here has already been through `src/lib`: the phones through
 * `normalizePhone`, the contacts through `toContactInputs`, the city through
 * `resolveCityDetailed`. This function selects and shapes; it normalizes
 * nothing.
 *
 * `leadId` is set and `upsertLead` is called with `matching: 'caller'`, so the
 * lead the confidence rules chose is the lead that is written to — the exact
 * matcher does not get to re-decide on a phone number it recognises.
 */
function leadInputFrom(
  target: EnrichmentTarget,
  page: PageEvidence,
  findings: readonly EnrichmentFinding[],
): LeadInput {
  const of = (field: EnrichableField): EnrichmentFinding[] =>
    findings.filter((finding) => finding.field === field);

  const phones: PhoneInput[] = of('phone').map((finding, index) => ({
    ...toPhoneInput(normalizePhone(finding.valueRaw ?? finding.value)),
    isPrimary: index === 0 && target.record.phones.length === 0,
  }));

  const wanted = new Set(
    findings.filter((finding) => finding.field !== 'phone').map((finding) => finding.value),
  );
  const contacts = page.contacts.filter((contact) => wanted.has(contact.value));

  const address = of('address')[0];
  const city = of('city')[0];

  return {
    leadId: target.leadId,
    name: target.name,
    nameNormalized: normalizeCompanyName(target.name).ascii,
    ...(address === undefined
      ? {}
      : { address: address.value, addressNormalized: normalizeAddress(address.value).ascii }),
    ...(address === undefined || page.postalCode === null ? {} : { postalCode: page.postalCode }),
    ...(city === undefined
      ? {}
      : {
          cityId: city.value,
          municipalityId: page.municipalityId,
          cityRaw: city.valueRaw ?? city.value,
        }),
    phones,
    contacts,
  };
}

/** The verdict as it is stored: the reason, the rule, and every signal weighed. */
function verdictPayload(verdict: ConfidenceVerdict): Record<string, unknown> {
  return {
    tier: verdict.tier,
    rule: verdict.rule,
    confidence: verdict.confidence,
    reason: verdict.reason,
    decision: verdict.match.decision,
    score: verdict.match.score,
    signals: verdict.match.signals,
  };
}

function countByField(
  findings: readonly EnrichmentFinding[],
): Readonly<Partial<Record<EnrichableField, number>>> {
  const counts: Partial<Record<EnrichableField, number>> = {};
  for (const finding of findings) {
    counts[finding.field] = (counts[finding.field] ?? 0) + 1;
  }
  return counts;
}
