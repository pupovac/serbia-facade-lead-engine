/**
 * Turning stored rows into the shape the matcher compares.
 *
 * The repository stays free of matching rules and `score.ts` stays free of
 * Drizzle; this is the one file that knows both. It reads through the collapsed
 * accessors (`distinctPhones`, `leadContactClaims`) rather than the raw claim
 * rows, so the per-source duplication that those tables exist to preserve does
 * not leak into the comparison as false corroboration.
 */
import type { Db } from '../db/client.js';
import type { ContactKind, Lead } from '../db/schema.js';
import {
  distinctPhones,
  getLead,
  leadContactClaims,
  leadSourceRows,
  type Executor,
} from '../db/repo.js';
import { normalizeAddress, normalizeCompanyName } from '../normalize/index.js';
import type { NormalizedAddress } from '../normalize/index.js';
import type { LeadRecord } from './types.js';

/**
 * Parse whatever the pipeline stored into the key the matcher compares.
 *
 * Parsing is idempotent, so a row written before `normalizeAddress` existed —
 * `address.toLowerCase()`, commas and postal code intact — keys the same way a
 * freshly written one does, and no backfill stands between an old database and
 * a correct comparison.
 */
function toAddressKey(raw: string | null): NormalizedAddress | null {
  if (raw === null) return null;
  const address = normalizeAddress(raw);
  return address.tokens.length === 0 ? null : address;
}

/** `lead_contacts.kind` values that are a social profile rather than a channel. */
const SOCIAL_KINDS: ReadonlySet<ContactKind> = new Set([
  'facebook',
  'instagram',
  'google_maps',
  'linkedin',
  'youtube',
]);

/**
 * Read one stored lead and everything hanging off it into a comparable record.
 *
 * Only valid phones are carried: an unparseable string stays on the lead for
 * auditing, and it must never be the thing two businesses are merged on.
 */
export function toLeadRecord(db: Executor, leadId: number): LeadRecord | undefined {
  const lead = getLead(db, leadId);
  if (!lead) return undefined;

  const contacts = leadContactClaims(db, leadId);
  const websiteDomains = new Set<string>();
  const emails = new Set<string>();
  const socialUrls = new Set<string>();
  for (const contact of contacts) {
    if (contact.valid === false) continue;
    if (contact.kind === 'website') {
      if (contact.domain) websiteDomains.add(contact.domain);
    } else if (contact.kind === 'email') {
      emails.add(contact.value.toLowerCase());
    } else if (SOCIAL_KINDS.has(contact.kind)) {
      socialUrls.add(contact.value);
    }
  }

  return {
    id: lead.id,
    name: lead.name,
    nameKey: normalizeCompanyName(lead.name),
    cityId: lead.cityId,
    municipalityId: lead.municipalityId,
    addressNormalized: lead.addressNormalized ?? lead.address,
    addressKey: toAddressKey(lead.addressNormalized ?? lead.address),
    registrationNumber: lead.registrationNumber,
    taxId: lead.taxId,
    phones: distinctPhones(db, leadId)
      .filter((phone) => phone.valid)
      .map((phone) => phone.e164),
    websiteDomains: [...websiteDomains],
    emails: [...emails],
    socialUrls: [...socialUrls],
    sourceIds: [...new Set(leadSourceRows(db, leadId).map((row) => row.sourceId))],
    firstSeenAt: lead.firstSeenAt,
    lastSeenAt: lead.lastSeenAt,
  };
}

/** `toLeadRecord`, for a lead row already in hand. Throws if the lead is gone. */
export function requireLeadRecord(db: Executor, leadId: number): LeadRecord {
  const record = toLeadRecord(db, leadId);
  if (!record) throw new Error(`lead ${leadId} not found`);
  return record;
}

/**
 * A record for something not yet stored — an adapter asking what an incoming
 * business would match before it decides to write it.
 *
 * Everything is optional except the name, because a name, a city and a phone is
 * a good lead and the matcher must work on exactly that much.
 */
export function leadRecord(
  input: Partial<Omit<LeadRecord, 'name' | 'nameKey'>> & { readonly name: string },
): LeadRecord {
  return {
    id: input.id ?? null,
    name: input.name,
    nameKey: normalizeCompanyName(input.name),
    cityId: input.cityId ?? null,
    municipalityId: input.municipalityId ?? null,
    addressNormalized: input.addressNormalized ?? null,
    addressKey: input.addressKey ?? toAddressKey(input.addressNormalized ?? null),
    registrationNumber: input.registrationNumber ?? null,
    taxId: input.taxId ?? null,
    phones: input.phones ?? [],
    websiteDomains: input.websiteDomains ?? [],
    emails: input.emails ?? [],
    socialUrls: input.socialUrls ?? [],
    sourceIds: input.sourceIds ?? [],
    firstSeenAt: input.firstSeenAt ?? null,
    lastSeenAt: input.lastSeenAt ?? null,
  };
}

/**
 * How complete a record is, used only to pick which of two equal leads survives
 * a merge. Not the lead score — that is `src/lib/score`, it is 0-100, it means
 * something to a salesperson, and it is recomputed after the merge anyway.
 */
export function completeness(record: LeadRecord): number {
  return (
    record.phones.length * 3 +
    record.emails.length * 2 +
    record.websiteDomains.length * 2 +
    record.socialUrls.length +
    record.sourceIds.length * 2 +
    (record.cityId ? 2 : 0) +
    (record.addressNormalized ? 2 : 0) +
    (record.registrationNumber ? 3 : 0)
  );
}

/** The lead rows a `LeadRecord` was built from, for callers that need both. */
export function leadRows(db: Db, ids: readonly number[]): Map<number, Lead> {
  const rows = new Map<number, Lead>();
  for (const id of ids) {
    const lead = getLead(db, id);
    if (lead) rows.set(id, lead);
  }
  return rows;
}
