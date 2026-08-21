/**
 * `RawLead` → a lead in the database.
 *
 * Everything between the adapter and the repository happens here, and it
 * happens in exactly one place: normalization, city resolution, classification,
 * scoring, provenance and the raw-record archive. An adapter that wanted to do
 * any of it would be re-implementing `src/lib`, which is the boundary this file
 * exists to hold.
 *
 * `normalizeRawLead` is pure — no database, no clock it does not receive — so
 * the mapping from "what a Serbian directory published" to "what goes in the
 * leads table" is unit-testable on its own, and `--dry-run` gets the real
 * answer without opening a database.
 *
 * Two conventions are worth knowing before reading the code:
 *
 * - **An explicit field becomes a link.** A source that publishes a website or
 *   a Facebook page as a field has it turned into a link candidate and passed
 *   through the same `src/lib/contact` extractor as an anchor scraped off the
 *   page, so the directory's own domain, a share intent and a vendor credit are
 *   rejected by the documented rules rather than by whatever the adapter
 *   happened to think of.
 * - **An adapter's phone claim is kept even when it does not parse; a phone
 *   found in prose is not.** `phones: ['064/123-4567']` is the source saying
 *   "this is the number", and an unparseable one is evidence worth storing with
 *   `valid: false`. A regex hit inside a paragraph is a guess, and a bad guess
 *   is noise.
 */
import {
  applyGrading,
  attachSource,
  distinctPhones,
  leadContactClaims,
  leadSourceRows,
  getLead,
  saveRawRecord,
  upsertLead,
  type ContactInput,
  type Db,
  type LeadInput,
  type PhoneInput,
  type Provenance,
  type UpsertLeadResult,
} from '@/lib/db';
import { classifyLead, type ClassificationResult } from '@/lib/classify';
import {
  extractEmails,
  extractSocials,
  extractWebsite,
  toContactInputs,
  type LinkCandidate,
} from '@/lib/contact';
import {
  normalizeAddress,
  normalizeCompanyName,
  resolveCityDetailed,
  type CityMatch,
} from '@/lib/normalize';
import { extractPhones, normalizePhone, toPhoneInput } from '@/lib/phone';
import { scoreLead, toScoreInput, type LeadScore } from '@/lib/score';
import { normalizeWhitespace } from '@/lib/text/fold.js';
import type { RawLead } from './raw-lead.js';

export interface NormalizeOptions {
  /** Addresses the directory itself publishes on every listing. From the adapter. */
  readonly sourceOwnedEmails?: readonly string[] | undefined;
  /** Social profiles the directory owns, when its brand name does not match its domain. */
  readonly sourceOwnedProfiles?: readonly string[] | undefined;
}

/** One raw record, resolved into everything the repository and the score need. */
export interface NormalizedLead {
  /** Ready for `upsertLead`. */
  readonly input: LeadInput;
  readonly city: CityMatch | null;
  /** Why the city did not resolve, when it did not. Reported, not swallowed. */
  readonly cityFailure: string | null;
  readonly classification: ClassificationResult;
  /** Distinct canonical numbers on this record. The primary deliverable, counted. */
  readonly phoneCount: number;
  /** The score this record would earn on its own, before corroboration from other sources. */
  readonly score: LeadScore;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = normalizeWhitespace(value);
  return trimmed === '' ? null : trimmed;
}

/**
 * The matching key for a published address, or null when the source gave
 * nothing a matcher can use. `leads.address` keeps the string as published.
 */
function addressKey(value: string | null | undefined): string | null {
  const raw = trimOrNull(value);
  if (raw === null) return null;
  const address = normalizeAddress(raw);
  return address.tokens.length === 0 ? null : address.ascii;
}

/** Explicit fields, folded into the link list the `src/lib` extractors read. */
function linkCandidates(lead: RawLead): LinkCandidate[] {
  const links: LinkCandidate[] = lead.links.map((link) => ({
    href: link.href,
    ...(link.text === undefined ? {} : { text: link.text }),
    ...(link.rel === undefined ? {} : { rel: link.rel }),
  }));
  if (lead.website !== null && lead.website !== undefined) {
    links.unshift({ href: lead.website, text: lead.website });
  }
  for (const social of lead.socials) links.push({ href: social, text: social });
  for (const email of lead.emails) links.push({ href: `mailto:${email}`, text: email });
  return links;
}

/**
 * Every phone claim on the record, strongest evidence first.
 *
 * Ordering matters beyond tidiness: the first entry is marked primary, and a
 * salesperson calling down the export dials that one.
 */
function phoneInputs(lead: RawLead): PhoneInput[] {
  const byE164 = new Map<string, PhoneInput>();
  const add = (input: PhoneInput): void => {
    const existing = byE164.get(input.e164);
    // A valid reading of a number always beats an invalid one of the same string.
    if (existing === undefined || (existing.valid === false && input.valid !== false)) {
      byE164.set(input.e164, input);
    }
  };

  for (const raw of lead.phones) add(toPhoneInput(normalizePhone(raw)));

  for (const link of lead.links) {
    if (!/^tel:/i.test(link.href)) continue;
    add(toPhoneInput(normalizePhone(decodeURIComponent(link.href.slice(4)))));
  }

  const text = lead.text;
  if (text !== null && text !== undefined && text.trim() !== '') {
    for (const found of extractPhones(text)) {
      // Prose is a guess. Only a number that actually parsed is worth keeping.
      if (found.phone === null) continue;
      add(toPhoneInput(found.phone));
    }
  }

  const inputs = [...byE164.values()];
  return inputs.map((input, index) => ({ ...input, isPrimary: index === 0 }));
}

function contactInputs(lead: RawLead, options: NormalizeOptions): ContactInput[] {
  const sourceDomain = new URL(lead.sourceUrl).host;
  const links = linkCandidates(lead);
  const hrefs = links.map((link) => link.href);
  const text = [lead.text ?? '', ...lead.emails].join('\n');

  const emails = extractEmails(text, {
    sourceDomain,
    links: hrefs,
    ...(options.sourceOwnedEmails === undefined
      ? {}
      : { sourceOwnedEmails: options.sourceOwnedEmails }),
  });
  const website = extractWebsite(links, { sourceDomain });
  const socials = extractSocials(links, {
    sourceDomain,
    ...(options.sourceOwnedProfiles === undefined
      ? {}
      : { sourceOwnedProfiles: options.sourceOwnedProfiles }),
  });

  return toContactInputs({ emails, website, socials });
}

/**
 * The whole normalization step, as a pure function.
 *
 * `now` is passed in rather than read, because the score's recency component
 * would otherwise make this untestable.
 */
export function normalizeRawLead(
  lead: RawLead,
  options: NormalizeOptions = {},
  now: Date = new Date(),
): NormalizedLead {
  const name = normalizeWhitespace(lead.name);
  const normalizedName = normalizeCompanyName(name);
  const phones = phoneInputs(lead);
  const contacts = contactInputs(lead, options);

  // The address is a fallback for the city, not a second field to resolve: a
  // directory that prints `Bulevar oslobođenja 12, Novi Sad` and nothing in a
  // city column still knows where the business is.
  const placeText = trimOrNull(lead.city) ?? trimOrNull(lead.address) ?? '';
  const firstValidPhone = phones.find((phone) => phone.valid !== false);
  const cityResolution = resolveCityDetailed(placeText, {
    ...(firstValidPhone === undefined ? {} : { phone: firstValidPhone.e164 }),
  });
  const city = cityResolution.ok ? cityResolution.match : null;

  const classification = classifyLead({
    name,
    ...(trimOrNull(lead.description) === null
      ? {}
      : { description: trimOrNull(lead.description) as string }),
    ...(lead.categories.length === 0 ? {} : { categories: lead.categories }),
    ...(() => {
      const website = contacts.find((contact) => contact.kind === 'website');
      return website === undefined ? {} : { website: website.value };
    })(),
  });

  const score = scoreLead({
    phones: phones.map((phone) => ({ e164: phone.e164, type: phone.type, valid: phone.valid })),
    emails: contacts.filter((c) => c.kind === 'email').map((c) => c.value),
    websites: contacts.filter((c) => c.kind === 'website').map((c) => c.value),
    socials: contacts
      .filter((c) => c.kind === 'facebook' || c.kind === 'instagram' || c.kind === 'google_maps')
      .map((c) => c.value),
    city,
    classification: { label: classification.label, confidence: classification.confidence },
    sourceIds: lead.sourceId === undefined ? [] : [lead.sourceId],
    lastSeenAt: now,
    now,
  });

  const input: LeadInput = {
    name,
    nameNormalized: normalizedName.ascii,
    legalForm: trimOrNull(lead.legalForm) ?? normalizedName.legalForm ?? null,
    registrationNumber: trimOrNull(lead.registrationNumber),
    taxId: trimOrNull(lead.taxId),
    classification: classification.label,
    classificationConfidence: classification.confidence,
    classificationEvidence: JSON.stringify(classification),
    cityId: city?.cityId ?? null,
    municipalityId: city?.municipalityId ?? null,
    cityRaw: placeText === '' ? null : placeText,
    address: trimOrNull(lead.address),
    addressNormalized: addressKey(lead.address),
    postalCode: trimOrNull(lead.postalCode),
    latitude: lead.latitude ?? null,
    longitude: lead.longitude ?? null,
    description: trimOrNull(lead.description),
    openingHours: trimOrNull(lead.openingHours),
    leadScore: score.score,
    scoreBreakdown: JSON.stringify(score.components),
    phones,
    contacts,
  };

  return {
    input,
    city,
    cityFailure: cityResolution.ok ? null : `${cityResolution.reason}: ${cityResolution.detail}`,
    classification,
    phoneCount: phones.filter((phone) => phone.valid !== false).length,
    score,
  };
}

/** What one record did to the database. Summed into the run statistics. */
export interface PersistResult {
  readonly leadId: number;
  readonly created: boolean;
  readonly phonesAdded: number;
  readonly contactsAdded: number;
  readonly conflictsRecorded: number;
  readonly matchedBy: UpsertLeadResult['matchedBy'];
  readonly rawRecordId: number;
  /** Re-computed over every source that has seen this lead, not just this record. */
  readonly score: number;
}

/**
 * Write one record: the raw payload, the lead, the provenance, the grading.
 *
 * The order is deliberate. `raw_records` is written **first** and unconditionally,
 * so a parser bug is recoverable without a re-crawl — `merge, never delete`
 * starts here. The grading is written **last**, from the merged lead as it now
 * stands in the database, because the score of a business three directories
 * agree on is not the score of one listing.
 */
export function persistLead(
  db: Db,
  lead: RawLead,
  normalized: NormalizedLead,
  options: { runId?: number | null | undefined; now?: Date | undefined } = {},
): PersistResult {
  const now = options.now ?? new Date();
  const runId = options.runId ?? null;
  const sourceId = lead.sourceId ?? '';

  const raw = saveRawRecord(db, {
    sourceId,
    sourceUrl: lead.sourceUrl,
    payload: JSON.stringify(lead),
    runId,
    status: 'normalized',
    seenAt: now,
  });

  const provenance: Provenance = {
    sourceId,
    sourceUrl: lead.sourceUrl,
    seenAt: now,
    runId,
    rawRecordId: raw.id,
  };

  const result = upsertLead(db, normalized.input, provenance);
  attachSource(db, result.leadId, provenance);

  const stored = getLead(db, result.leadId);
  /* c8 ignore next -- upsertLead just wrote it; this is a type narrowing, not a case */
  if (stored === undefined) throw new Error(`lead ${result.leadId} vanished after upsert`);

  const rescored = scoreLead(
    toScoreInput({
      lead: stored,
      phones: distinctPhones(db, result.leadId),
      contacts: leadContactClaims(db, result.leadId),
      sources: leadSourceRows(db, result.leadId),
      city: normalized.city,
      now,
    }),
  );

  applyGrading(
    db,
    result.leadId,
    {
      classification: normalized.classification.label,
      classificationConfidence: normalized.classification.confidence,
      classificationEvidence: JSON.stringify(normalized.classification),
      leadScore: rescored.score,
      scoreBreakdown: JSON.stringify(rescored.components),
    },
    now,
  );

  return {
    leadId: result.leadId,
    created: result.created,
    phonesAdded: result.phonesAdded,
    contactsAdded: result.contactsAdded,
    conflictsRecorded: result.conflictsRecorded,
    matchedBy: result.matchedBy,
    rawRecordId: raw.id,
    score: rescored.score,
  };
}

/**
 * Archive a record that failed the zod boundary.
 *
 * It is stored, with its error, rather than dropped — a silently discarded
 * record is a bug nobody can find later, and `raw_records` is where the
 * validation report reads from.
 */
export function persistRejected(
  db: Db,
  sourceId: string,
  sourceUrl: string,
  payload: unknown,
  error: string,
  now: Date = new Date(),
): void {
  saveRawRecord(db, {
    sourceId,
    sourceUrl,
    payload: JSON.stringify(payload ?? null),
    status: 'rejected',
    validationError: error,
    seenAt: now,
  });
}
