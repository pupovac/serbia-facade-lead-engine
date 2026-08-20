/**
 * The repository — every read and write of a lead goes through here.
 *
 * No raw SQL in a route handler, no `db.insert()` in an adapter. The rules that
 * make a lead trustworthy are enforced in one place:
 *
 * - **Fill blanks, never clobber.** An update sets a column only where the
 *   stored one is empty. A second, different value for a field already filled
 *   is recorded in `lead_field_values` as a conflict and left for a deliberate
 *   `promoteFieldValue()` — by the merge engine or by a reviewer — instead of
 *   being decided by whoever wrote last.
 * - **Every write carries provenance.** `Provenance` is a required argument,
 *   not an option, so there is no code path that stores a value without knowing
 *   where it came from.
 * - **Merge, never delete.** `recordMerge()` moves children onto the survivor,
 *   keeps the merged-away row as a tombstone, and stores enough state for
 *   `revertMerge()` to undo it.
 *
 * Writes run inside a transaction. `better-sqlite3` is synchronous, so
 * everything here is synchronous too — no `await`, and no way for a half-written
 * lead to be observed.
 *
 * **Portability:** no `INSERT OR REPLACE`, no `strftime`, no SQLite-only
 * functions. Reads and writes are plain `select` / `insert` / `update` that
 * Drizzle renders identically for Postgres.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  type ContactKind,
  type CrawlStateStatus,
  crawlRuns,
  crawlState,
  erasureBlocklist,
  erasureLog,
  type Lead,
  type LeadClassification,
  type LeadContact,
  type LeadFieldValue,
  type LeadPhone,
  type LeadSource,
  leadContacts,
  leadFieldValues,
  leadPhones,
  leadSources,
  leads,
  type IdentifierKind,
  type MergeCandidate,
  type MergeCandidateStatus,
  type MatchSignalName,
  type MergeLogEntry,
  type MergeSignal,
  type NewSource,
  type QuarantineReason,
  type SharedIdentifier,
  type PhoneType,
  type ProvenanceField,
  type RawRecord,
  type RawRecordStatus,
  type RunStatus,
  mergeCandidates,
  mergeLog,
  sharedIdentifiers,
  rawRecords,
  sources,
} from './schema.js';

/** Anything that can run a statement: the database, or an open transaction. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a value came from. Required on every write — an adapter that cannot say
 * which URL it read a phone number at has no business storing it.
 */
export interface Provenance {
  /** `sources.id`, the registry slug. */
  readonly sourceId: string;
  /** The exact page the value was read from, not the source's homepage. */
  readonly sourceUrl: string;
  /** Defaults to now. Pass it explicitly when replaying a saved payload. */
  readonly seenAt?: Date | undefined;
  readonly runId?: number | null | undefined;
  readonly rawRecordId?: number | null | undefined;
}

export interface PhoneInput {
  /** Canonical `+381641234567`, from `src/lib/phone`. */
  readonly e164: string;
  /** The string the source published, verbatim. */
  readonly raw: string;
  readonly nationalFormat?: string | null | undefined;
  readonly type?: PhoneType | undefined;
  readonly isPrimary?: boolean | undefined;
  /** `false` keeps an unparseable number for auditing instead of dropping it. */
  readonly valid?: boolean | undefined;
  readonly confidence?: number | null | undefined;
}

export interface ContactInput {
  readonly kind: ContactKind;
  readonly value: string;
  readonly valueRaw?: string | undefined;
  /** Registrable domain — dedup paths 2 and 3 index this. */
  readonly domain?: string | null | undefined;
  readonly handle?: string | null | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly valid?: boolean | undefined;
  readonly confidence?: number | null | undefined;
}

/**
 * One business as a source described it, already normalized by `src/lib` and
 * validated at the adapter boundary. Every field except the name is optional:
 * a name, a city and a phone is a good lead.
 */
export interface LeadInput {
  /** Skip matching and write to this lead. Used by the merge engine and the UI. */
  readonly leadId?: number | undefined;
  readonly name: string;
  /** `normalizeCompanyName(name).ascii`. Supplied by the caller so `src/lib/db` stays free of text rules. */
  readonly nameNormalized: string;
  readonly legalForm?: string | null | undefined;
  readonly registrationNumber?: string | null | undefined;
  readonly taxId?: string | null | undefined;
  readonly classification?: LeadClassification | undefined;
  readonly classificationConfidence?: number | null | undefined;
  /** JSON from `classifyLead`, so the label can be explained without re-running it. */
  readonly classificationEvidence?: string | null | undefined;
  /** `data/serbia-geo.json` id of the most specific unit matched. */
  readonly cityId?: string | null | undefined;
  /** `data/serbia-geo.json` id of the local self-government unit it rolls up to. */
  readonly municipalityId?: string | null | undefined;
  /** The place string as published, before it was matched to a slug. */
  readonly cityRaw?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly addressNormalized?: string | null | undefined;
  readonly postalCode?: string | null | undefined;
  readonly latitude?: number | null | undefined;
  readonly longitude?: number | null | undefined;
  readonly description?: string | null | undefined;
  readonly openingHours?: string | null | undefined;
  readonly leadScore?: number | undefined;
  readonly scoreBreakdown?: string | null | undefined;
  readonly phones?: readonly PhoneInput[] | undefined;
  readonly contacts?: readonly ContactInput[] | undefined;
}

export interface UpsertLeadResult {
  readonly leadId: number;
  readonly created: boolean;
  /** Which dedup signal attached this record to an existing lead. */
  readonly matchedBy: MatchSignal | null;
  readonly phonesAdded: number;
  readonly contactsAdded: number;
  /** Field claims that disagreed with a value already promoted onto the lead. */
  readonly conflictsRecorded: number;
}

/** The exact-match lookups `upsertLead` runs, strongest first. */
export type MatchSignal = 'lead_id' | 'phone' | 'website_domain' | 'email' | 'name_city';

export interface UpsertLeadOptions {
  /**
   * Who decided which lead this record belongs to.
   *
   * - `'exact'` (default) runs the built-in exact matcher: phone, website
   *   domain, email, then name + city.
   * - `'caller'` runs nothing and trusts `input.leadId` alone. The caller has
   *   already matched with the full rule set, and letting the exact matcher
   *   second-guess it would undo the decision — a shared phone across two
   *   *differently registered* companies is a `review` verdict the merge engine
   *   reached on purpose, and the exact matcher would attach them anyway.
   *
   * `src/lib/dedup`'s `ingestLead` is the caller this exists for, and it is the
   * entry point an adapter should be writing through.
   */
  readonly matching?: 'exact' | 'caller' | undefined;
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Insert or update a registry row. Re-seeding is idempotent: `created_at`
 * survives, everything else is refreshed from the registry.
 */
export function upsertSource(
  db: Executor,
  source: Omit<NewSource, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date },
): void {
  const now = source.updatedAt ?? new Date();
  const existing = db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.id, source.id))
    .get();
  if (existing) {
    const { id: _id, createdAt: _createdAt, ...rest } = source;
    db.update(sources)
      .set({ ...rest, updatedAt: now })
      .where(eq(sources.id, source.id))
      .run();
    return;
  }
  db.insert(sources)
    .values({ ...source, createdAt: source.createdAt ?? now, updatedAt: now })
    .run();
}

export function getSource(db: Executor, id: string) {
  return db.select().from(sources).where(eq(sources.id, id)).get();
}

/* -------------------------------------------------------------------------- */
/* Lookups — the dedup paths                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Follow `merged_into_id` to the lead that is actually alive.
 *
 * Every id ever handed out keeps resolving, which is what lets a merge be
 * non-destructive. The hop limit is a guard against a cycle that a bug in the
 * merge engine could otherwise turn into an infinite loop.
 */
export function resolveLead(db: Executor, leadId: number): Lead | undefined {
  let current = db.select().from(leads).where(eq(leads.id, leadId)).get();
  for (let hops = 0; current?.mergedIntoId != null && hops < 16; hops += 1) {
    const next: Lead | undefined = db
      .select()
      .from(leads)
      .where(eq(leads.id, current.mergedIntoId))
      .get();
    if (!next || next.id === current.id) break;
    current = next;
  }
  return current;
}

/**
 * Dedup path 1 — the strongest signal. `e164` must already be canonical; this
 * function does not normalize, because normalization lives in `src/lib/phone`
 * and must not be duplicated here.
 */
export function findByPhone(db: Executor, e164: string): Lead | undefined {
  const hit = db
    .select({ leadId: leadPhones.leadId })
    .from(leadPhones)
    .where(eq(leadPhones.e164, e164))
    .get();
  return hit ? resolveLead(db, hit.leadId) : undefined;
}

/** Dedup path 2 — website domain. Pass the registrable domain, lower-cased. */
export function findByDomain(db: Executor, domain: string): Lead | undefined {
  const hit = db
    .select({ leadId: leadContacts.leadId })
    .from(leadContacts)
    .where(and(eq(leadContacts.kind, 'website'), eq(leadContacts.domain, domain)))
    .get();
  return hit ? resolveLead(db, hit.leadId) : undefined;
}

/** Dedup path 3 — email address, canonical (lower-cased) form. */
export function findByEmail(db: Executor, email: string): Lead | undefined {
  const hit = db
    .select({ leadId: leadContacts.leadId })
    .from(leadContacts)
    .where(and(eq(leadContacts.kind, 'email'), eq(leadContacts.value, email)))
    .get();
  return hit ? resolveLead(db, hit.leadId) : undefined;
}

/**
 * Dedup path 4 — company name + city.
 *
 * The weakest signal that is still exact, and the reason it requires a city:
 * "Fasada Plus" in Novi Sad and "Fasada Plus" in Niš are two businesses until
 * something stronger says otherwise. Never merge on a similar name alone.
 */
export function findByNameAndCity(
  db: Executor,
  nameNormalized: string,
  cityId: string,
): Lead | undefined {
  const hit = db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.nameNormalized, nameNormalized), eq(leads.cityId, cityId)))
    .get();
  return hit ? resolveLead(db, hit.id) : undefined;
}

export function getLead(db: Executor, leadId: number): Lead | undefined {
  return db.select().from(leads).where(eq(leads.id, leadId)).get();
}

/* -------------------------------------------------------------------------- */
/* Reading a lead's children                                                  */
/* -------------------------------------------------------------------------- */

export function leadPhoneClaims(db: Executor, leadId: number): LeadPhone[] {
  return db.select().from(leadPhones).where(eq(leadPhones.leadId, leadId)).all();
}

export function leadContactClaims(db: Executor, leadId: number): LeadContact[] {
  return db.select().from(leadContacts).where(eq(leadContacts.leadId, leadId)).all();
}

export function leadSourceRows(db: Executor, leadId: number): LeadSource[] {
  return db.select().from(leadSources).where(eq(leadSources.leadId, leadId)).all();
}

export function leadFieldClaims(db: Executor, leadId: number): LeadFieldValue[] {
  return db.select().from(leadFieldValues).where(eq(leadFieldValues.leadId, leadId)).all();
}

/** One entry per distinct number, with the sources that corroborate it. */
export interface DistinctPhone {
  readonly e164: string;
  readonly type: PhoneType;
  readonly isPrimary: boolean;
  readonly valid: boolean;
  /** Every raw spelling seen, in first-seen order. */
  readonly rawVariants: readonly string[];
  /** Distinct `sources.id` values that published this number. Feeds the lead score. */
  readonly sourceIds: readonly string[];
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/**
 * Collapse the per-source claims into the phone list a human sees.
 *
 * `lead_phones` stores one row per claiming source on purpose; the UI and the
 * XLSX export both need the collapsed view, so the collapsing rule lives here
 * once rather than in each of them.
 */
export function distinctPhones(db: Executor, leadId: number): DistinctPhone[] {
  const claims = db
    .select()
    .from(leadPhones)
    .where(eq(leadPhones.leadId, leadId))
    .orderBy(leadPhones.firstSeenAt, leadPhones.id)
    .all();

  const byNumber = new Map<
    string,
    DistinctPhone & { rawVariants: string[]; sourceIds: string[] }
  >();
  for (const claim of claims) {
    const existing = byNumber.get(claim.e164);
    if (!existing) {
      byNumber.set(claim.e164, {
        e164: claim.e164,
        type: claim.type,
        isPrimary: claim.isPrimary,
        valid: claim.valid,
        rawVariants: [claim.raw],
        sourceIds: [claim.sourceId],
        firstSeenAt: claim.firstSeenAt,
        lastSeenAt: claim.lastSeenAt,
      });
      continue;
    }
    if (!existing.rawVariants.includes(claim.raw)) existing.rawVariants.push(claim.raw);
    if (!existing.sourceIds.includes(claim.sourceId)) existing.sourceIds.push(claim.sourceId);
    byNumber.set(claim.e164, {
      ...existing,
      // A `mobile` verdict from one source beats `unknown` from another.
      type: existing.type === 'unknown' ? claim.type : existing.type,
      isPrimary: existing.isPrimary || claim.isPrimary,
      valid: existing.valid || claim.valid,
      firstSeenAt:
        claim.firstSeenAt < existing.firstSeenAt ? claim.firstSeenAt : existing.firstSeenAt,
      lastSeenAt: claim.lastSeenAt > existing.lastSeenAt ? claim.lastSeenAt : existing.lastSeenAt,
    });
  }
  return [...byNumber.values()];
}

/** A field two sources disagree about, with every claimed value and its provenance. */
export interface FieldConflict {
  readonly field: ProvenanceField;
  readonly current: string | null;
  readonly claims: readonly LeadFieldValue[];
}

/**
 * Every field where more than one distinct value has been claimed.
 *
 * This is the "conflicts are recorded, not silently resolved" rule made
 * readable: the review UI lists these, a human picks, `promoteFieldValue()`
 * applies the choice.
 */
export function fieldConflicts(db: Executor, leadId: number): FieldConflict[] {
  const claims = leadFieldClaims(db, leadId);
  const byField = new Map<ProvenanceField, LeadFieldValue[]>();
  for (const claim of claims) {
    const slot = byField.get(claim.field);
    if (slot) slot.push(claim);
    else byField.set(claim.field, [claim]);
  }

  const conflicts: FieldConflict[] = [];
  for (const [field, fieldClaims] of byField) {
    const distinct = new Set(fieldClaims.map((c) => c.valueNormalized ?? c.value));
    if (distinct.size < 2) continue;
    conflicts.push({
      field,
      current: fieldClaims.find((c) => c.isCurrent)?.value ?? null,
      claims: fieldClaims,
    });
  }
  return conflicts;
}

/* -------------------------------------------------------------------------- */
/* Writing a lead                                                             */
/* -------------------------------------------------------------------------- */

/** `leads` columns a field claim can be promoted onto. */
const FIELD_TO_COLUMN = {
  name: 'name',
  legal_form: 'legalForm',
  address: 'address',
  postal_code: 'postalCode',
  city: 'cityRaw',
  municipality: 'municipalityId',
  classification: 'classification',
  description: 'description',
  opening_hours: 'openingHours',
  registration_number: 'registrationNumber',
  tax_id: 'taxId',
  coordinates: null,
} as const satisfies Record<ProvenanceField, keyof Lead | null>;

interface FieldClaim {
  readonly field: ProvenanceField;
  readonly value: string;
  readonly valueNormalized: string | null;
}

function fieldClaimsFrom(input: LeadInput): FieldClaim[] {
  const claims: FieldClaim[] = [
    { field: 'name', value: input.name, valueNormalized: input.nameNormalized },
  ];
  const add = (field: ProvenanceField, value: string | null | undefined, normalized?: string) => {
    if (value == null || value === '') return;
    claims.push({ field, value, valueNormalized: normalized ?? null });
  };
  add('legal_form', input.legalForm);
  add('address', input.address, input.addressNormalized ?? undefined);
  add('postal_code', input.postalCode);
  add('city', input.cityRaw, input.cityId ?? undefined);
  add('municipality', input.municipalityId);
  add('description', input.description);
  add('opening_hours', input.openingHours);
  add('registration_number', input.registrationNumber);
  add('tax_id', input.taxId);
  if (input.classification && input.classification !== 'UNKNOWN') {
    add('classification', input.classification);
  }
  if (input.latitude != null && input.longitude != null) {
    add('coordinates', `${input.latitude},${input.longitude}`);
  }
  return claims;
}

/**
 * Insert a business, or attach this sighting to the one already stored.
 *
 * Matching runs the **exact** dedup signals only — phone, website domain,
 * email, then name + city — in that order. Fuzzy matching (near-duplicate
 * names, two locations of one business, address similarity) is the merge
 * engine's job: it runs afterwards, over stored leads, and calls
 * `recordMerge()`. Keeping the two apart is what stops an adapter from silently
 * collapsing two businesses on a weak signal.
 *
 * An existing lead is **updated by filling blanks**. A value that disagrees
 * with one already promoted is stored as a claim and reported in
 * `conflictsRecorded`, never written over the stored one.
 *
 * A quarantined identifier is skipped rather than matched on. Attaching is
 * **irreversible** — unlike a merge, it leaves no `merge_log` row to undo — so
 * a call-centre number that ten unrelated companies publish must not attach
 * every one of them to whichever lead happened to be inserted first. See
 * `shared_identifiers` and `src/lib/dedup/quarantine.ts`.
 *
 * `options.matching = 'caller'` hands the whole decision to the caller;
 * `src/lib/dedup/ingest.ts` is what that is for.
 */
export function upsertLead(
  db: Db,
  input: LeadInput,
  provenance: Provenance,
  options: UpsertLeadOptions = {},
): UpsertLeadResult {
  return db.transaction((tx) => {
    const at = provenance.seenAt ?? new Date();
    const matched = matchLead(tx, input, options);
    const existing = matched?.lead;

    const leadId = existing ? existing.id : insertLead(tx, input, at);
    if (existing) updateLeadFillingBlanks(tx, existing, input, at);

    let conflictsRecorded = 0;
    const current = existing ? (getLead(tx, leadId) ?? existing) : undefined;
    for (const claim of fieldClaimsFrom(input)) {
      const column = FIELD_TO_COLUMN[claim.field];
      const promoted =
        current == null || column == null
          ? true
          : String(current[column] ?? '') === claim.value ||
            current[column] == null ||
            current[column] === '';
      if (!promoted) conflictsRecorded += 1;
      recordFieldClaim(tx, leadId, claim, promoted, provenance, at);
    }

    let phonesAdded = 0;
    for (const phone of input.phones ?? []) {
      if (upsertPhoneClaim(tx, leadId, phone, provenance, at)) phonesAdded += 1;
    }

    let contactsAdded = 0;
    for (const contact of input.contacts ?? []) {
      if (upsertContactClaim(tx, leadId, contact, provenance, at)) contactsAdded += 1;
    }

    attachSourceTx(tx, leadId, provenance, at);

    return {
      leadId,
      created: !existing,
      matchedBy: matched?.signal ?? null,
      phonesAdded,
      contactsAdded,
      conflictsRecorded,
    };
  });
}

function matchLead(
  tx: Executor,
  input: LeadInput,
  options: UpsertLeadOptions,
): { lead: Lead; signal: MatchSignal } | undefined {
  if (input.leadId != null) {
    const lead = resolveLead(tx, input.leadId);
    if (lead) return { lead, signal: 'lead_id' };
  }
  if (options.matching === 'caller') return undefined;
  for (const phone of input.phones ?? []) {
    if (isQuarantined(tx, 'phone', phone.e164)) continue;
    const lead = findByPhone(tx, phone.e164);
    if (lead) return { lead, signal: 'phone' };
  }
  for (const contact of input.contacts ?? []) {
    if (contact.kind !== 'website' || !contact.domain) continue;
    if (isQuarantined(tx, 'website_domain', contact.domain)) continue;
    const lead = findByDomain(tx, contact.domain);
    if (lead) return { lead, signal: 'website_domain' };
  }
  for (const contact of input.contacts ?? []) {
    if (contact.kind !== 'email') continue;
    if (isQuarantined(tx, 'email', contact.value)) continue;
    const lead = findByEmail(tx, contact.value);
    if (lead) return { lead, signal: 'email' };
  }
  if (input.cityId) {
    const lead = findByNameAndCity(tx, input.nameNormalized, input.cityId);
    if (lead) return { lead, signal: 'name_city' };
  }
  return undefined;
}

function insertLead(tx: Executor, input: LeadInput, at: Date): number {
  const row = tx
    .insert(leads)
    .values({
      name: input.name,
      nameNormalized: input.nameNormalized,
      legalForm: input.legalForm ?? null,
      registrationNumber: input.registrationNumber ?? null,
      taxId: input.taxId ?? null,
      classification: input.classification ?? 'UNKNOWN',
      classificationConfidence: input.classificationConfidence ?? null,
      classificationEvidence: input.classificationEvidence ?? null,
      cityId: input.cityId ?? null,
      municipalityId: input.municipalityId ?? null,
      cityRaw: input.cityRaw ?? null,
      address: input.address ?? null,
      addressNormalized: input.addressNormalized ?? null,
      postalCode: input.postalCode ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      description: input.description ?? null,
      openingHours: input.openingHours ?? null,
      leadScore: input.leadScore ?? 0,
      scoreBreakdown: input.scoreBreakdown ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
      lastScrapedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: leads.id })
    .get();
  return row.id;
}

/**
 * Fill the blanks on a stored lead and move its timestamps forward.
 *
 * A column that already holds a value is never overwritten here, with two
 * deliberate exceptions: `UNKNOWN` is not a classification, it is the absence
 * of one, and the lead score is a derived number the scorer owns outright.
 */
function updateLeadFillingBlanks(tx: Executor, existing: Lead, input: LeadInput, at: Date): void {
  const patch: Partial<typeof leads.$inferInsert> = {};
  const fill = <K extends keyof typeof leads.$inferInsert>(
    key: K,
    incoming: (typeof leads.$inferInsert)[K] | null | undefined,
  ) => {
    const stored = existing[key as keyof Lead];
    if (incoming == null || incoming === '') return;
    if (stored != null && stored !== '') return;
    patch[key] = incoming;
  };

  fill('legalForm', input.legalForm);
  fill('registrationNumber', input.registrationNumber);
  fill('taxId', input.taxId);
  fill('cityId', input.cityId);
  fill('municipalityId', input.municipalityId);
  fill('cityRaw', input.cityRaw);
  fill('address', input.address);
  fill('addressNormalized', input.addressNormalized);
  fill('postalCode', input.postalCode);
  fill('latitude', input.latitude);
  fill('longitude', input.longitude);
  fill('description', input.description);
  fill('openingHours', input.openingHours);

  if (input.classification && input.classification !== 'UNKNOWN') {
    if (existing.classification === 'UNKNOWN') {
      patch.classification = input.classification;
      patch.classificationConfidence = input.classificationConfidence ?? null;
      patch.classificationEvidence = input.classificationEvidence ?? null;
    }
  }
  if (input.leadScore != null) patch.leadScore = input.leadScore;
  if (input.scoreBreakdown != null) patch.scoreBreakdown = input.scoreBreakdown;

  patch.lastSeenAt = at > existing.lastSeenAt ? at : existing.lastSeenAt;
  patch.lastScrapedAt =
    existing.lastScrapedAt == null || at > existing.lastScrapedAt ? at : existing.lastScrapedAt;
  if (at < existing.firstSeenAt) patch.firstSeenAt = at;
  patch.updatedAt = at;

  tx.update(leads).set(patch).where(eq(leads.id, existing.id)).run();
}

function recordFieldClaim(
  tx: Executor,
  leadId: number,
  claim: FieldClaim,
  isCurrent: boolean,
  provenance: Provenance,
  at: Date,
): void {
  const existing = tx
    .select({ id: leadFieldValues.id })
    .from(leadFieldValues)
    .where(
      and(
        eq(leadFieldValues.leadId, leadId),
        eq(leadFieldValues.field, claim.field),
        eq(leadFieldValues.value, claim.value),
        eq(leadFieldValues.sourceId, provenance.sourceId),
      ),
    )
    .get();

  if (existing) {
    tx.update(leadFieldValues)
      .set({ lastSeenAt: at, sourceUrl: provenance.sourceUrl })
      .where(eq(leadFieldValues.id, existing.id))
      .run();
  } else {
    tx.insert(leadFieldValues)
      .values({
        leadId,
        field: claim.field,
        value: claim.value,
        valueNormalized: claim.valueNormalized,
        isCurrent: false,
        sourceId: provenance.sourceId,
        sourceUrl: provenance.sourceUrl,
        firstSeenAt: at,
        lastSeenAt: at,
      })
      .run();
  }

  if (isCurrent) setCurrentFieldValue(tx, leadId, claim.field, claim.value);
}

/** Exactly one claim per (lead, field) carries `is_current`; it mirrors the `leads` column. */
function setCurrentFieldValue(
  tx: Executor,
  leadId: number,
  field: ProvenanceField,
  value: string,
): void {
  tx.update(leadFieldValues)
    .set({ isCurrent: false })
    .where(and(eq(leadFieldValues.leadId, leadId), eq(leadFieldValues.field, field)))
    .run();
  tx.update(leadFieldValues)
    .set({ isCurrent: true })
    .where(
      and(
        eq(leadFieldValues.leadId, leadId),
        eq(leadFieldValues.field, field),
        eq(leadFieldValues.value, value),
      ),
    )
    .run();
}

/**
 * Resolve a recorded conflict: promote one claimed value onto the lead.
 *
 * The deliberate counterpart to "fill blanks, never clobber" — a reviewer in
 * the UI or the merge engine decides, and the losing values stay in
 * `lead_field_values` with their provenance intact.
 */
export function promoteFieldValue(
  db: Db,
  leadId: number,
  field: ProvenanceField,
  value: string,
): void {
  db.transaction((tx) => {
    const claim = tx
      .select()
      .from(leadFieldValues)
      .where(
        and(
          eq(leadFieldValues.leadId, leadId),
          eq(leadFieldValues.field, field),
          eq(leadFieldValues.value, value),
        ),
      )
      .get();
    if (!claim) throw new Error(`no claim for lead ${leadId}, field ${field}, value ${value}`);

    const column = FIELD_TO_COLUMN[field];
    if (column != null) {
      const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
      if (column === 'name') {
        patch.name = value;
        if (claim.valueNormalized) patch.nameNormalized = claim.valueNormalized;
      } else if (column === 'classification') {
        patch.classification = value as LeadClassification;
      } else {
        (patch as Record<string, unknown>)[column] = value;
      }
      tx.update(leads).set(patch).where(eq(leads.id, leadId)).run();
    }
    setCurrentFieldValue(tx, leadId, field, value);
  });
}

/** Returns true when this was a new (lead, number, source) claim. */
function upsertPhoneClaim(
  tx: Executor,
  leadId: number,
  phone: PhoneInput,
  provenance: Provenance,
  at: Date,
): boolean {
  const existing = tx
    .select({ id: leadPhones.id })
    .from(leadPhones)
    .where(
      and(
        eq(leadPhones.leadId, leadId),
        eq(leadPhones.e164, phone.e164),
        eq(leadPhones.sourceId, provenance.sourceId),
      ),
    )
    .get();

  if (existing) {
    tx.update(leadPhones)
      .set({ lastSeenAt: at, sourceUrl: provenance.sourceUrl })
      .where(eq(leadPhones.id, existing.id))
      .run();
    return false;
  }

  tx.insert(leadPhones)
    .values({
      leadId,
      e164: phone.e164,
      raw: phone.raw,
      nationalFormat: phone.nationalFormat ?? null,
      type: phone.type ?? 'unknown',
      isPrimary: phone.isPrimary ?? false,
      valid: phone.valid ?? true,
      confidence: phone.confidence ?? null,
      sourceId: provenance.sourceId,
      sourceUrl: provenance.sourceUrl,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .run();
  return true;
}

/** Returns true when this was a new (lead, kind, value, source) claim. */
function upsertContactClaim(
  tx: Executor,
  leadId: number,
  contact: ContactInput,
  provenance: Provenance,
  at: Date,
): boolean {
  const existing = tx
    .select({ id: leadContacts.id })
    .from(leadContacts)
    .where(
      and(
        eq(leadContacts.leadId, leadId),
        eq(leadContacts.kind, contact.kind),
        eq(leadContacts.value, contact.value),
        eq(leadContacts.sourceId, provenance.sourceId),
      ),
    )
    .get();

  if (existing) {
    tx.update(leadContacts)
      .set({ lastSeenAt: at, sourceUrl: provenance.sourceUrl })
      .where(eq(leadContacts.id, existing.id))
      .run();
    return false;
  }

  tx.insert(leadContacts)
    .values({
      leadId,
      kind: contact.kind,
      value: contact.value,
      valueRaw: contact.valueRaw ?? contact.value,
      domain: contact.domain ?? null,
      handle: contact.handle ?? null,
      isPrimary: contact.isPrimary ?? false,
      valid: contact.valid ?? true,
      confidence: contact.confidence ?? null,
      sourceId: provenance.sourceId,
      sourceUrl: provenance.sourceUrl,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .run();
  return true;
}

/**
 * Record that this source saw this lead at this exact URL.
 *
 * Never collapsed to one row per source: a business listed on three pages of
 * one directory is three rows, and the count of *distinct* sources — which is
 * what feeds the lead score and the merge confidence — is a query over them,
 * not a number someone maintained by hand.
 */
/** What `classifyLead` and `scoreLead` produced for one lead. */
export interface GradingInput {
  readonly classification: LeadClassification;
  readonly classificationConfidence: number;
  /** `JSON.stringify` of the classification result — evidence, suppressions, arithmetic. */
  readonly classificationEvidence?: string | null | undefined;
  readonly leadScore: number;
  /** `JSON.stringify` of the score components. */
  readonly scoreBreakdown?: string | null | undefined;
}

/**
 * Write a re-computed classification and lead score onto an existing lead.
 *
 * Unlike `upsertLead`, which only ever fills a gap, this overwrites: grading is
 * derived data, and a re-run over better text is meant to replace the previous
 * verdict rather than lose to it. A reviewer's own decision lives in
 * `leads.status` and `review_note`, which this never touches.
 */
export function applyGrading(db: Db, leadId: number, grading: GradingInput, at = new Date()): void {
  db.update(leads)
    .set({
      classification: grading.classification,
      classificationConfidence: grading.classificationConfidence,
      classificationEvidence: grading.classificationEvidence ?? null,
      leadScore: grading.leadScore,
      scoreBreakdown: grading.scoreBreakdown ?? null,
      updatedAt: at,
    })
    .where(eq(leads.id, leadId))
    .run();
}

export function attachSource(db: Db, leadId: number, provenance: Provenance): void {
  db.transaction((tx) => {
    attachSourceTx(tx, leadId, provenance, provenance.seenAt ?? new Date());
  });
}

function attachSourceTx(tx: Executor, leadId: number, provenance: Provenance, at: Date): void {
  const existing = tx
    .select()
    .from(leadSources)
    .where(
      and(
        eq(leadSources.leadId, leadId),
        eq(leadSources.sourceId, provenance.sourceId),
        eq(leadSources.sourceUrl, provenance.sourceUrl),
      ),
    )
    .get();

  if (existing) {
    tx.update(leadSources)
      .set({
        timesSeen: existing.timesSeen + 1,
        lastSeenAt: at > existing.lastSeenAt ? at : existing.lastSeenAt,
        lastScrapedAt: at > existing.lastScrapedAt ? at : existing.lastScrapedAt,
        lastRunId: provenance.runId ?? existing.lastRunId,
        rawRecordId: provenance.rawRecordId ?? existing.rawRecordId,
      })
      .where(eq(leadSources.id, existing.id))
      .run();
    return;
  }

  tx.insert(leadSources)
    .values({
      leadId,
      sourceId: provenance.sourceId,
      sourceUrl: provenance.sourceUrl,
      rawRecordId: provenance.rawRecordId ?? null,
      firstRunId: provenance.runId ?? null,
      lastRunId: provenance.runId ?? null,
      timesSeen: 1,
      firstSeenAt: at,
      lastSeenAt: at,
      lastScrapedAt: at,
    })
    .run();
}

/** How many independent sources have seen this lead. Feeds the score and merge confidence. */
export function distinctSourceCount(db: Executor, leadId: number): number {
  const row = db
    .select({ count: sql<number>`count(distinct ${leadSources.sourceId})` })
    .from(leadSources)
    .where(eq(leadSources.leadId, leadId))
    .get();
  return row?.count ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Raw records                                                                */
/* -------------------------------------------------------------------------- */

export interface RawRecordInput {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly payload: string;
  readonly runId?: number | null | undefined;
  readonly status?: RawRecordStatus | undefined;
  readonly validationError?: string | null | undefined;
  readonly leadId?: number | null | undefined;
  readonly seenAt?: Date | undefined;
  /** Defaults to the SHA-256 of `payload`. */
  readonly contentHash?: string | undefined;
}

/**
 * Store what the adapter emitted, before normalization.
 *
 * A re-run that fetches an unchanged page finds the same `(source, hash)` and
 * bumps `seen_count` — it does not accumulate identical copies. A record that
 * failed validation is stored with `status = 'rejected'` and its error, because
 * a silently dropped record is a bug nobody can find later.
 */
export function saveRawRecord(db: Executor, input: RawRecordInput): RawRecord {
  const at = input.seenAt ?? new Date();
  const contentHash = input.contentHash ?? sha256(input.payload);
  const existing = db
    .select()
    .from(rawRecords)
    .where(and(eq(rawRecords.sourceId, input.sourceId), eq(rawRecords.contentHash, contentHash)))
    .get();

  if (existing) {
    return db
      .update(rawRecords)
      .set({
        lastSeenAt: at,
        seenCount: existing.seenCount + 1,
        sourceUrl: input.sourceUrl,
        runId: input.runId ?? existing.runId,
        status: input.status ?? existing.status,
        validationError: input.validationError ?? existing.validationError,
        leadId: input.leadId ?? existing.leadId,
      })
      .where(eq(rawRecords.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(rawRecords)
    .values({
      sourceId: input.sourceId,
      runId: input.runId ?? null,
      sourceUrl: input.sourceUrl,
      contentHash,
      payload: input.payload,
      status: input.status ?? 'pending',
      validationError: input.validationError ?? null,
      leadId: input.leadId ?? null,
      seenCount: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .returning()
    .get();
}

/* -------------------------------------------------------------------------- */
/* Crawl bookkeeping                                                          */
/* -------------------------------------------------------------------------- */

export function startRun(
  db: Executor,
  sourceId: string,
  options: { trigger?: string; scope?: string | null; startedAt?: Date } = {},
): number {
  const row = db
    .insert(crawlRuns)
    .values({
      sourceId,
      startedAt: options.startedAt ?? new Date(),
      status: 'running',
      trigger: options.trigger ?? 'manual',
      scope: options.scope ?? null,
    })
    .returning({ id: crawlRuns.id })
    .get();
  return row.id;
}

export interface RunStats {
  readonly requestsMade?: number;
  readonly pagesFetched?: number;
  readonly recordsEmitted?: number;
  readonly recordsRejected?: number;
  readonly leadsCreated?: number;
  readonly leadsUpdated?: number;
  readonly phonesAdded?: number;
  readonly mergesPerformed?: number;
  readonly error?: string | null;
  readonly notes?: string | null;
}

export function finishRun(
  db: Executor,
  runId: number,
  status: RunStatus,
  stats: RunStats = {},
  finishedAt: Date = new Date(),
): void {
  db.update(crawlRuns)
    .set({ ...stats, status, finishedAt })
    .where(eq(crawlRuns.id, runId))
    .run();
}

export function getCrawlState(db: Executor, sourceId: string, scopeKey: string) {
  return db
    .select()
    .from(crawlState)
    .where(and(eq(crawlState.sourceId, sourceId), eq(crawlState.scopeKey, scopeKey)))
    .get();
}

/**
 * Record where a scope got to, so the next run resumes instead of restarting.
 * `attempts` counts every visit — a scope that keeps failing is visible without
 * reading a log file.
 */
export function saveCrawlState(
  db: Executor,
  sourceId: string,
  scopeKey: string,
  update: {
    cursor?: string | null;
    status?: CrawlStateStatus;
    lastRunId?: number | null;
    lastError?: string | null;
    seenAt?: Date;
  } = {},
): void {
  const at = update.seenAt ?? new Date();
  const existing = getCrawlState(db, sourceId, scopeKey);
  const status = update.status ?? existing?.status ?? 'pending';

  if (existing) {
    db.update(crawlState)
      .set({
        cursor: update.cursor !== undefined ? update.cursor : existing.cursor,
        status,
        attempts: existing.attempts + 1,
        lastRunId: update.lastRunId ?? existing.lastRunId,
        lastError: update.lastError !== undefined ? update.lastError : existing.lastError,
        lastSeenAt: at,
        completedAt: status === 'done' ? at : existing.completedAt,
      })
      .where(eq(crawlState.id, existing.id))
      .run();
    return;
  }

  db.insert(crawlState)
    .values({
      sourceId,
      scopeKey,
      cursor: update.cursor ?? null,
      status,
      attempts: 1,
      lastRunId: update.lastRunId ?? null,
      lastError: update.lastError ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
      completedAt: status === 'done' ? at : null,
    })
    .run();
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

export interface MergeInput {
  readonly survivingLeadId: number;
  readonly mergedLeadId: number;
  readonly signal: MergeSignal;
  readonly signalValue: string;
  readonly score?: number | null | undefined;
  /** `JSON.stringify` of every signal `scoreMatch` weighed, not just the winner. */
  readonly signals?: string | null | undefined;
  readonly actor?: string | undefined;
  readonly runId?: number | null | undefined;
  readonly mergedAt?: Date | undefined;
}

export interface MergeResult {
  readonly mergeLogId: number;
  readonly survivingLeadId: number;
  readonly mergedLeadId: number;
  readonly phonesMoved: number;
  readonly contactsMoved: number;
  readonly sourcesMoved: number;
  /** Child rows the survivor already had, identical down to the source. */
  readonly duplicatesAbsorbed: number;
}

/** What `revert_merge` needs to put everything back exactly as it was. */
interface MergeSnapshot {
  readonly mergedLead: Lead;
  readonly survivorBefore: Lead;
  readonly movedPhoneIds: number[];
  readonly movedContactIds: number[];
  readonly movedFieldValueIds: number[];
  readonly movedSourceIds: number[];
  readonly movedRawRecordIds: number[];
  /** Rows deleted because the survivor held the identical claim; re-inserted on revert. */
  readonly absorbedPhones: LeadPhone[];
  readonly absorbedContacts: LeadContact[];
  readonly absorbedFieldValues: LeadFieldValue[];
  readonly absorbedSources: LeadSource[];
}

/**
 * Merge two leads into one — the only way two leads ever become one.
 *
 * **Nothing is deleted.** Every phone, contact, field claim and source URL from
 * the merged-away lead moves to the survivor; fields the survivor lacked are
 * filled from it; the merged-away row stays as a tombstone with
 * `merged_into_id` set, so every id ever handed out still resolves. Only an
 * exact duplicate claim — same value, same source, already on the survivor — is
 * collapsed, and its row is kept in the snapshot so a revert restores it.
 *
 * The snapshot makes the merge reversible; `signal` and `signal_value` make it
 * explainable.
 */
export function recordMerge(db: Db, input: MergeInput): MergeResult {
  return db.transaction((tx) => {
    const at = input.mergedAt ?? new Date();
    const survivor = getLead(tx, input.survivingLeadId);
    const merged = getLead(tx, input.mergedLeadId);
    if (!survivor) throw new Error(`surviving lead ${input.survivingLeadId} not found`);
    if (!merged) throw new Error(`merged lead ${input.mergedLeadId} not found`);
    if (survivor.id === merged.id) throw new Error('cannot merge a lead into itself');
    if (merged.mergedIntoId != null) {
      throw new Error(`lead ${merged.id} was already merged into ${merged.mergedIntoId}`);
    }

    const snapshot: MergeSnapshot = {
      mergedLead: merged,
      survivorBefore: survivor,
      movedPhoneIds: [],
      movedContactIds: [],
      movedFieldValueIds: [],
      movedSourceIds: [],
      movedRawRecordIds: [],
      absorbedPhones: [],
      absorbedContacts: [],
      absorbedFieldValues: [],
      absorbedSources: [],
    };

    // Phones — unique on (lead, e164, source).
    for (const phone of leadPhoneClaims(tx, merged.id)) {
      const clash = tx
        .select()
        .from(leadPhones)
        .where(
          and(
            eq(leadPhones.leadId, survivor.id),
            eq(leadPhones.e164, phone.e164),
            eq(leadPhones.sourceId, phone.sourceId),
          ),
        )
        .get();
      if (clash) {
        tx.update(leadPhones)
          .set({
            firstSeenAt: earlier(clash.firstSeenAt, phone.firstSeenAt),
            lastSeenAt: later(clash.lastSeenAt, phone.lastSeenAt),
            isPrimary: clash.isPrimary || phone.isPrimary,
          })
          .where(eq(leadPhones.id, clash.id))
          .run();
        tx.delete(leadPhones).where(eq(leadPhones.id, phone.id)).run();
        snapshot.absorbedPhones.push(phone);
      } else {
        tx.update(leadPhones).set({ leadId: survivor.id }).where(eq(leadPhones.id, phone.id)).run();
        snapshot.movedPhoneIds.push(phone.id);
      }
    }

    // Contacts — unique on (lead, kind, value, source).
    for (const contact of leadContactClaims(tx, merged.id)) {
      const clash = tx
        .select()
        .from(leadContacts)
        .where(
          and(
            eq(leadContacts.leadId, survivor.id),
            eq(leadContacts.kind, contact.kind),
            eq(leadContacts.value, contact.value),
            eq(leadContacts.sourceId, contact.sourceId),
          ),
        )
        .get();
      if (clash) {
        tx.update(leadContacts)
          .set({
            firstSeenAt: earlier(clash.firstSeenAt, contact.firstSeenAt),
            lastSeenAt: later(clash.lastSeenAt, contact.lastSeenAt),
            isPrimary: clash.isPrimary || contact.isPrimary,
          })
          .where(eq(leadContacts.id, clash.id))
          .run();
        tx.delete(leadContacts).where(eq(leadContacts.id, contact.id)).run();
        snapshot.absorbedContacts.push(contact);
      } else {
        tx.update(leadContacts)
          .set({ leadId: survivor.id })
          .where(eq(leadContacts.id, contact.id))
          .run();
        snapshot.movedContactIds.push(contact.id);
      }
    }

    // Field claims — unique on (lead, field, value, source). The merged lead's
    // promoted values become plain claims on the survivor: they are exactly the
    // conflicts a reviewer needs to see, not values to overwrite with.
    for (const claim of leadFieldClaims(tx, merged.id)) {
      const clash = tx
        .select()
        .from(leadFieldValues)
        .where(
          and(
            eq(leadFieldValues.leadId, survivor.id),
            eq(leadFieldValues.field, claim.field),
            eq(leadFieldValues.value, claim.value),
            eq(leadFieldValues.sourceId, claim.sourceId),
          ),
        )
        .get();
      if (clash) {
        tx.update(leadFieldValues)
          .set({
            firstSeenAt: earlier(clash.firstSeenAt, claim.firstSeenAt),
            lastSeenAt: later(clash.lastSeenAt, claim.lastSeenAt),
          })
          .where(eq(leadFieldValues.id, clash.id))
          .run();
        tx.delete(leadFieldValues).where(eq(leadFieldValues.id, claim.id)).run();
        snapshot.absorbedFieldValues.push(claim);
      } else {
        tx.update(leadFieldValues)
          .set({ leadId: survivor.id, isCurrent: false })
          .where(eq(leadFieldValues.id, claim.id))
          .run();
        snapshot.movedFieldValueIds.push(claim.id);
      }
    }

    // Source sightings — unique on (lead, source, url). Never collapsed across URLs.
    for (const row of leadSourceRows(tx, merged.id)) {
      const clash = tx
        .select()
        .from(leadSources)
        .where(
          and(
            eq(leadSources.leadId, survivor.id),
            eq(leadSources.sourceId, row.sourceId),
            eq(leadSources.sourceUrl, row.sourceUrl),
          ),
        )
        .get();
      if (clash) {
        tx.update(leadSources)
          .set({
            timesSeen: clash.timesSeen + row.timesSeen,
            firstSeenAt: earlier(clash.firstSeenAt, row.firstSeenAt),
            lastSeenAt: later(clash.lastSeenAt, row.lastSeenAt),
            lastScrapedAt: later(clash.lastScrapedAt, row.lastScrapedAt),
          })
          .where(eq(leadSources.id, clash.id))
          .run();
        tx.delete(leadSources).where(eq(leadSources.id, row.id)).run();
        snapshot.absorbedSources.push(row);
      } else {
        tx.update(leadSources).set({ leadId: survivor.id }).where(eq(leadSources.id, row.id)).run();
        snapshot.movedSourceIds.push(row.id);
      }
    }

    for (const raw of tx
      .select({ id: rawRecords.id })
      .from(rawRecords)
      .where(eq(rawRecords.leadId, merged.id))
      .all()) {
      tx.update(rawRecords).set({ leadId: survivor.id }).where(eq(rawRecords.id, raw.id)).run();
      snapshot.movedRawRecordIds.push(raw.id);
    }

    // The survivor inherits every field it did not have. Merge, never delete.
    const inherited: Partial<typeof leads.$inferInsert> = {};
    for (const key of INHERITABLE_COLUMNS) {
      const stored = survivor[key];
      const incoming = merged[key];
      if (stored != null && stored !== '') continue;
      if (incoming == null || incoming === '') continue;
      (inherited as Record<string, unknown>)[key] = incoming;
    }
    if (survivor.classification === 'UNKNOWN' && merged.classification !== 'UNKNOWN') {
      inherited.classification = merged.classification;
      inherited.classificationConfidence = merged.classificationConfidence;
      inherited.classificationEvidence = merged.classificationEvidence;
    }
    tx.update(leads)
      .set({
        ...inherited,
        firstSeenAt: earlier(survivor.firstSeenAt, merged.firstSeenAt),
        lastSeenAt: later(survivor.lastSeenAt, merged.lastSeenAt),
        lastScrapedAt: laterOrNull(survivor.lastScrapedAt, merged.lastScrapedAt),
        updatedAt: at,
      })
      .where(eq(leads.id, survivor.id))
      .run();

    tx.update(leads)
      .set({ mergedIntoId: survivor.id, status: 'merged', updatedAt: at })
      .where(eq(leads.id, merged.id))
      .run();

    const logRow = tx
      .insert(mergeLog)
      .values({
        survivingLeadId: survivor.id,
        mergedLeadId: merged.id,
        signal: input.signal,
        signalValue: input.signalValue,
        score: input.score ?? null,
        signals: input.signals ?? null,
        actor: input.actor ?? 'pipeline',
        runId: input.runId ?? null,
        snapshot: JSON.stringify(snapshot),
        mergedAt: at,
      })
      .returning({ id: mergeLog.id })
      .get();

    return {
      mergeLogId: logRow.id,
      survivingLeadId: survivor.id,
      mergedLeadId: merged.id,
      phonesMoved: snapshot.movedPhoneIds.length,
      contactsMoved: snapshot.movedContactIds.length,
      sourcesMoved: snapshot.movedSourceIds.length,
      duplicatesAbsorbed:
        snapshot.absorbedPhones.length +
        snapshot.absorbedContacts.length +
        snapshot.absorbedFieldValues.length +
        snapshot.absorbedSources.length,
    };
  });
}

/** Columns the survivor may inherit from a merged-away lead when it has none of its own. */
const INHERITABLE_COLUMNS = [
  'legalForm',
  'registrationNumber',
  'taxId',
  'cityId',
  'municipalityId',
  'cityRaw',
  'address',
  'addressNormalized',
  'postalCode',
  'latitude',
  'longitude',
  'description',
  'openingHours',
] as const satisfies readonly (keyof Lead)[];

export function getMergeLogEntry(db: Executor, mergeLogId: number): MergeLogEntry | undefined {
  return db.select().from(mergeLog).where(eq(mergeLog.id, mergeLogId)).get();
}

/** Every merge recorded for a lead, whichever side of it the lead was on. */
export function mergeHistoryFor(db: Executor, leadId: number): MergeLogEntry[] {
  return db
    .select()
    .from(mergeLog)
    .where(or(eq(mergeLog.survivingLeadId, leadId), eq(mergeLog.mergedLeadId, leadId)))
    .orderBy(asc(mergeLog.id))
    .all();
}

/**
 * Undo a merge, using the snapshot taken when it happened.
 *
 * The merge engine will sometimes be wrong — two branches of one company, two
 * businesses sharing an accountant's phone number. Reversibility is what makes
 * an aggressive dedup rule safe to try.
 */
export function revertMerge(db: Db, mergeLogId: number, note?: string): void {
  db.transaction((tx) => {
    const entry = tx.select().from(mergeLog).where(eq(mergeLog.id, mergeLogId)).get();
    if (!entry) throw new Error(`merge log entry ${mergeLogId} not found`);
    if (entry.revertedAt != null) throw new Error(`merge ${mergeLogId} was already reverted`);

    // The snapshot describes two specific rows. If either has moved since --
    // the survivor merged onward into a third lead, or the merged-away lead
    // re-pointed somewhere else -- putting it back would restore stale columns
    // onto a tombstone. Later merges are undone first, newest to oldest.
    const survivorNow = getLead(tx, entry.survivingLeadId);
    if (survivorNow?.mergedIntoId != null) {
      throw new Error(
        `lead ${entry.survivingLeadId} has since been merged into ${survivorNow.mergedIntoId}: ` +
          'revert that merge first',
      );
    }
    const mergedNow = getLead(tx, entry.mergedLeadId);
    if (mergedNow != null && mergedNow.mergedIntoId !== entry.survivingLeadId) {
      throw new Error(
        `lead ${entry.mergedLeadId} is no longer merged into ${entry.survivingLeadId}`,
      );
    }

    const snapshot = JSON.parse(entry.snapshot) as MergeSnapshot;
    const mergedId = entry.mergedLeadId;

    if (snapshot.movedPhoneIds.length > 0) {
      tx.update(leadPhones)
        .set({ leadId: mergedId })
        .where(inArray(leadPhones.id, snapshot.movedPhoneIds))
        .run();
    }
    if (snapshot.movedContactIds.length > 0) {
      tx.update(leadContacts)
        .set({ leadId: mergedId })
        .where(inArray(leadContacts.id, snapshot.movedContactIds))
        .run();
    }
    if (snapshot.movedFieldValueIds.length > 0) {
      tx.update(leadFieldValues)
        .set({ leadId: mergedId })
        .where(inArray(leadFieldValues.id, snapshot.movedFieldValueIds))
        .run();
    }
    if (snapshot.movedSourceIds.length > 0) {
      tx.update(leadSources)
        .set({ leadId: mergedId })
        .where(inArray(leadSources.id, snapshot.movedSourceIds))
        .run();
    }
    if (snapshot.movedRawRecordIds.length > 0) {
      tx.update(rawRecords)
        .set({ leadId: mergedId })
        .where(inArray(rawRecords.id, snapshot.movedRawRecordIds))
        .run();
    }

    // Absorbed rows are re-inserted without their old ids: reusing a primary
    // key is a SQLite-only liberty and Postgres sequences would not agree.
    for (const phone of snapshot.absorbedPhones) {
      const { id: _id, ...values } = phone;
      tx.insert(leadPhones)
        .values({ ...values, leadId: mergedId, ...revivedTimestamps(phone) })
        .run();
    }
    for (const contact of snapshot.absorbedContacts) {
      const { id: _id, ...values } = contact;
      tx.insert(leadContacts)
        .values({ ...values, leadId: mergedId, ...revivedTimestamps(contact) })
        .run();
    }
    for (const claim of snapshot.absorbedFieldValues) {
      const { id: _id, ...values } = claim;
      tx.insert(leadFieldValues)
        .values({ ...values, leadId: mergedId, ...revivedTimestamps(claim) })
        .run();
    }
    for (const row of snapshot.absorbedSources) {
      const { id: _id, ...values } = row;
      tx.insert(leadSources)
        .values({
          ...values,
          leadId: mergedId,
          firstSeenAt: new Date(row.firstSeenAt),
          lastSeenAt: new Date(row.lastSeenAt),
          lastScrapedAt: new Date(row.lastScrapedAt),
        })
        .run();
    }

    const before = snapshot.survivorBefore;
    const restoredSurvivor: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
    for (const key of INHERITABLE_COLUMNS) {
      (restoredSurvivor as Record<string, unknown>)[key] = before[key];
    }
    restoredSurvivor.classification = before.classification;
    restoredSurvivor.classificationConfidence = before.classificationConfidence;
    restoredSurvivor.classificationEvidence = before.classificationEvidence;
    restoredSurvivor.firstSeenAt = new Date(before.firstSeenAt);
    restoredSurvivor.lastSeenAt = new Date(before.lastSeenAt);
    restoredSurvivor.lastScrapedAt =
      before.lastScrapedAt == null ? null : new Date(before.lastScrapedAt);
    tx.update(leads).set(restoredSurvivor).where(eq(leads.id, entry.survivingLeadId)).run();

    tx.update(leads)
      .set({ mergedIntoId: null, status: snapshot.mergedLead.status, updatedAt: new Date() })
      .where(eq(leads.id, mergedId))
      .run();

    tx.update(mergeLog)
      .set({ revertedAt: new Date(), revertNote: note ?? null })
      .where(eq(mergeLog.id, mergeLogId))
      .run();
  });
}

/** JSON round-tripping turns `Date` into a string; Drizzle needs it back as a `Date`. */
function revivedTimestamps(row: { firstSeenAt: Date; lastSeenAt: Date }) {
  return { firstSeenAt: new Date(row.firstSeenAt), lastSeenAt: new Date(row.lastSeenAt) };
}

function earlier(a: Date, b: Date): Date {
  return a <= b ? a : b;
}

function later(a: Date, b: Date): Date {
  return a >= b ? a : b;
}

function laterOrNull(a: Date | null, b: Date | null): Date | null {
  if (a == null) return b;
  if (b == null) return a;
  return later(a, b);
}

/* -------------------------------------------------------------------------- */
/* Candidate lookups — the merge engine's reads                               */
/* -------------------------------------------------------------------------- */

/**
 * The singular `findBy…` helpers above answer "is this business already here?",
 * which is all an insert needs. The merge engine asks a different question —
 * "which stored leads share this value?" — and a phone published by three
 * separate rows is exactly the case it exists to fix, so these return every
 * match, resolved through `merged_into_id` and de-duplicated by id.
 */
function resolveAll(db: Executor, leadIds: readonly number[]): Lead[] {
  const seen = new Map<number, Lead>();
  for (const id of leadIds) {
    const lead = resolveLead(db, id);
    if (lead && !seen.has(lead.id)) seen.set(lead.id, lead);
  }
  return [...seen.values()];
}

export function findAllByPhone(db: Executor, e164: string): Lead[] {
  const rows = db
    .selectDistinct({ leadId: leadPhones.leadId })
    .from(leadPhones)
    .where(eq(leadPhones.e164, e164))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.leadId),
  );
}

export function findAllByDomain(db: Executor, domain: string): Lead[] {
  const rows = db
    .selectDistinct({ leadId: leadContacts.leadId })
    .from(leadContacts)
    .where(and(eq(leadContacts.kind, 'website'), eq(leadContacts.domain, domain)))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.leadId),
  );
}

export function findAllByEmail(db: Executor, email: string): Lead[] {
  const rows = db
    .selectDistinct({ leadId: leadContacts.leadId })
    .from(leadContacts)
    .where(and(eq(leadContacts.kind, 'email'), eq(leadContacts.value, email)))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.leadId),
  );
}

/** Social profiles are corroboration, never a decisive signal — hence `kind` as an argument. */
export function findAllByContact(db: Executor, kind: ContactKind, value: string): Lead[] {
  const rows = db
    .selectDistinct({ leadId: leadContacts.leadId })
    .from(leadContacts)
    .where(and(eq(leadContacts.kind, kind), eq(leadContacts.value, value)))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.leadId),
  );
}

/** Maticni broj — an exact identifier the state issued, so it never needs a guard. */
export function findAllByRegistrationNumber(db: Executor, registrationNumber: string): Lead[] {
  const rows = db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.registrationNumber, registrationNumber))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.id),
  );
}

/** Every live lead carrying this `name_normalized`, in any city. */
export function findAllByNameKey(db: Executor, nameNormalized: string): Lead[] {
  const rows = db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.nameNormalized, nameNormalized), isNull(leads.mergedIntoId)))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.id),
  );
}

/**
 * The blocking query behind fuzzy name matching: every live lead in one city.
 *
 * Index-backed on `leads_city_idx`. A near-duplicate name is only ever compared
 * against the leads in the same place, which is both the correct rule — two
 * `Fasade Petrovic` in different cities are two businesses — and what keeps the
 * comparison from being quadratic over the whole table.
 */
export function findLeadsInCity(db: Executor, cityId: string): Lead[] {
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.cityId, cityId), isNull(leads.mergedIntoId)))
    .orderBy(asc(leads.id))
    .all();
}

/**
 * Every live lead already attached to this exact page.
 *
 * The strongest identity there is for an incremental re-crawl: the same source
 * saying the same thing at the same URL is the same sighting, not a new
 * business. Without it a re-run re-inserts every record whose only other
 * signals the merge engine declines to decide on — a quarantined phone, a name
 * match with no corroboration — and the database grows by a full crawl each
 * time.
 *
 * A listing page that carries several businesses returns several leads, so the
 * caller still has to pick by name.
 */
export function findLeadsBySourceUrl(db: Executor, sourceId: string, sourceUrl: string): Lead[] {
  const rows = db
    .selectDistinct({ leadId: leadSources.leadId })
    .from(leadSources)
    .where(and(eq(leadSources.sourceId, sourceId), eq(leadSources.sourceUrl, sourceUrl)))
    .all();
  return resolveAll(
    db,
    rows.map((r) => r.leadId),
  );
}

/** Every lead that has not been merged away. The sweep iterates this. */
export function activeLeads(db: Executor): Lead[] {
  return db.select().from(leads).where(isNull(leads.mergedIntoId)).orderBy(asc(leads.id)).all();
}

export function activeLeadCount(db: Executor): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .where(isNull(leads.mergedIntoId))
    .get();
  return row?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* shared_identifiers — the quarantine                                        */
/* -------------------------------------------------------------------------- */

/** One (identifier, lead) sighting, with the name that lead carries. */
export interface IdentifierOccurrence {
  readonly kind: IdentifierKind;
  readonly value: string;
  readonly leadId: number;
  readonly name: string;
  readonly nameNormalized: string;
}

/**
 * Every live (identifier, lead) pair of one kind, with the lead's name.
 *
 * This is the raw material the quarantine is computed from: the guard has to
 * count *businesses*, not rows, and only the name can say whether two rows are
 * two businesses. Invalid phones are excluded — a number that did not parse is
 * kept for auditing and must never anchor a merge.
 */
export function identifierOccurrences(db: Executor, kind: IdentifierKind): IdentifierOccurrence[] {
  if (kind === 'phone') {
    return db
      .selectDistinct({
        value: leadPhones.e164,
        leadId: leads.id,
        name: leads.name,
        nameNormalized: leads.nameNormalized,
      })
      .from(leadPhones)
      .innerJoin(leads, eq(leads.id, leadPhones.leadId))
      .where(and(eq(leadPhones.valid, true), isNull(leads.mergedIntoId)))
      .all()
      .map((row) => ({ kind, ...row }));
  }

  const column = kind === 'website_domain' ? leadContacts.domain : leadContacts.value;
  const contactKind: ContactKind = kind === 'website_domain' ? 'website' : 'email';
  return db
    .selectDistinct({
      value: column,
      leadId: leads.id,
      name: leads.name,
      nameNormalized: leads.nameNormalized,
    })
    .from(leadContacts)
    .innerJoin(leads, eq(leads.id, leadContacts.leadId))
    .where(and(eq(leadContacts.kind, contactKind), isNull(leads.mergedIntoId)))
    .all()
    .filter((row): row is typeof row & { value: string } => row.value != null && row.value !== '')
    .map((row) => ({ kind, ...row }));
}

export interface SharedIdentifierInput {
  readonly kind: IdentifierKind;
  readonly value: string;
  readonly distinctLeads: number;
  readonly distinctBusinesses: number;
  readonly quarantined: boolean;
  readonly reason?: QuarantineReason | null | undefined;
  /** A few of the distinct names seen, so a human can judge the verdict. */
  readonly sampleNames?: readonly string[] | undefined;
  readonly note?: string | null | undefined;
  readonly seenAt?: Date | undefined;
}

/**
 * Record what a decisive identifier is attached to, and whether it is still
 * trusted. Re-running the quarantine pass refreshes the counts and the verdict;
 * `first_seen_at` survives, so how long a number has been shared is readable.
 *
 * A `manual` verdict is never overwritten by the pass — a human who unblocked a
 * number, or blocked one the counts do not catch, outranks the arithmetic.
 */
export function upsertSharedIdentifier(db: Db, input: SharedIdentifierInput): void {
  const at = input.seenAt ?? new Date();
  const existing = getSharedIdentifier(db, input.kind, input.value);
  if (existing?.reason === 'manual') {
    db.update(sharedIdentifiers)
      .set({
        distinctLeads: input.distinctLeads,
        distinctBusinesses: input.distinctBusinesses,
        sampleNames: input.sampleNames ? JSON.stringify(input.sampleNames) : null,
        lastSeenAt: at,
      })
      .where(and(eq(sharedIdentifiers.kind, input.kind), eq(sharedIdentifiers.value, input.value)))
      .run();
    return;
  }

  db.insert(sharedIdentifiers)
    .values({
      kind: input.kind,
      value: input.value,
      distinctLeads: input.distinctLeads,
      distinctBusinesses: input.distinctBusinesses,
      quarantined: input.quarantined,
      reason: input.reason ?? null,
      sampleNames: input.sampleNames ? JSON.stringify(input.sampleNames) : null,
      note: input.note ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .onConflictDoUpdate({
      target: [sharedIdentifiers.kind, sharedIdentifiers.value],
      set: {
        distinctLeads: input.distinctLeads,
        distinctBusinesses: input.distinctBusinesses,
        quarantined: input.quarantined,
        reason: input.reason ?? null,
        sampleNames: input.sampleNames ? JSON.stringify(input.sampleNames) : null,
        note: input.note ?? null,
        lastSeenAt: at,
      },
    })
    .run();
}

export function getSharedIdentifier(
  db: Executor,
  kind: IdentifierKind,
  value: string,
): SharedIdentifier | undefined {
  return db
    .select()
    .from(sharedIdentifiers)
    .where(and(eq(sharedIdentifiers.kind, kind), eq(sharedIdentifiers.value, value)))
    .get();
}

/**
 * Is this value barred from deciding a merge?
 *
 * Called on the insert path for every phone, domain and email, so it is a
 * primary-key lookup and nothing more.
 */
export function isQuarantined(db: Executor, kind: IdentifierKind, value: string): boolean {
  const row = db
    .select({ quarantined: sharedIdentifiers.quarantined })
    .from(sharedIdentifiers)
    .where(and(eq(sharedIdentifiers.kind, kind), eq(sharedIdentifiers.value, value)))
    .get();
  return row?.quarantined === true;
}

export function quarantinedIdentifiers(db: Executor, kind?: IdentifierKind): SharedIdentifier[] {
  const where =
    kind == null
      ? eq(sharedIdentifiers.quarantined, true)
      : and(eq(sharedIdentifiers.quarantined, true), eq(sharedIdentifiers.kind, kind));
  return db
    .select()
    .from(sharedIdentifiers)
    .where(where)
    .orderBy(desc(sharedIdentifiers.distinctBusinesses))
    .all();
}

/**
 * A human's verdict on one identifier, which the automatic pass will not undo.
 *
 * Both directions matter: releasing a number the counts caught but a reviewer
 * knows is one business with six brands, and blocking one the counts have not
 * caught yet.
 */
export function setManualQuarantine(
  db: Db,
  kind: IdentifierKind,
  value: string,
  quarantined: boolean,
  note?: string,
  at = new Date(),
): void {
  db.insert(sharedIdentifiers)
    .values({
      kind,
      value,
      distinctLeads: 0,
      distinctBusinesses: 0,
      quarantined,
      reason: 'manual',
      note: note ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .onConflictDoUpdate({
      target: [sharedIdentifiers.kind, sharedIdentifiers.value],
      set: { quarantined, reason: 'manual', note: note ?? null, lastSeenAt: at },
    })
    .run();
}

/* -------------------------------------------------------------------------- */
/* merge_candidates — the review band                                         */
/* -------------------------------------------------------------------------- */

export interface MergeCandidateInput {
  readonly leadAId: number;
  readonly leadBId: number;
  readonly score: number;
  /** The strongest signal found. `merge_log`'s vocabulary plus `social_profile`. */
  readonly topSignal: MatchSignalName;
  readonly signalValue: string;
  /** `JSON.stringify` of the full signal list from `scoreMatch`. */
  readonly signals: string;
  readonly seenAt?: Date | undefined;
}

export interface MergeCandidateResult {
  readonly id: number;
  readonly created: boolean;
  readonly status: MergeCandidateStatus;
}

/**
 * Park a pair for a human to decide, or refresh the evidence on one already
 * parked.
 *
 * The pair is stored unordered (`lead_a_id < lead_b_id`), so the same two leads
 * produce one row however the sweep reached them. A pair a reviewer has already
 * **rejected** keeps its status: re-proposing it every run is how a review
 * queue becomes noise a human stops reading, and it is also what would stop the
 * sweep from being idempotent.
 */
export function upsertMergeCandidate(db: Db, input: MergeCandidateInput): MergeCandidateResult {
  const at = input.seenAt ?? new Date();
  const [leadAId, leadBId] =
    input.leadAId < input.leadBId ? [input.leadAId, input.leadBId] : [input.leadBId, input.leadAId];
  if (leadAId === leadBId) throw new Error('a merge candidate needs two different leads');

  const existing = db
    .select()
    .from(mergeCandidates)
    .where(and(eq(mergeCandidates.leadAId, leadAId), eq(mergeCandidates.leadBId, leadBId)))
    .get();

  if (existing) {
    if (existing.status === 'pending') {
      db.update(mergeCandidates)
        .set({
          score: input.score,
          topSignal: input.topSignal,
          signalValue: input.signalValue,
          signals: input.signals,
          lastSeenAt: at,
        })
        .where(eq(mergeCandidates.id, existing.id))
        .run();
    } else {
      db.update(mergeCandidates)
        .set({ lastSeenAt: at })
        .where(eq(mergeCandidates.id, existing.id))
        .run();
    }
    return { id: existing.id, created: false, status: existing.status };
  }

  const row = db
    .insert(mergeCandidates)
    .values({
      leadAId,
      leadBId,
      score: input.score,
      topSignal: input.topSignal,
      signalValue: input.signalValue,
      signals: input.signals,
      status: 'pending',
      firstSeenAt: at,
      lastSeenAt: at,
    })
    .returning({ id: mergeCandidates.id })
    .get();
  return { id: row.id, created: true, status: 'pending' };
}

export function getMergeCandidate(
  db: Executor,
  leadAId: number,
  leadBId: number,
): MergeCandidate | undefined {
  const [a, b] = leadAId < leadBId ? [leadAId, leadBId] : [leadBId, leadAId];
  return db
    .select()
    .from(mergeCandidates)
    .where(and(eq(mergeCandidates.leadAId, a), eq(mergeCandidates.leadBId, b)))
    .get();
}

/** The review UI's queue: still undecided, strongest evidence first. */
export function pendingMergeCandidates(db: Executor, limit?: number): MergeCandidate[] {
  const query = db
    .select()
    .from(mergeCandidates)
    .where(eq(mergeCandidates.status, 'pending'))
    .orderBy(desc(mergeCandidates.score), asc(mergeCandidates.id));
  return limit == null ? query.all() : query.limit(limit).all();
}

export interface ResolveCandidateOptions {
  readonly resolvedBy?: string | undefined;
  readonly mergeLogId?: number | null | undefined;
  readonly at?: Date | undefined;
}

export function resolveMergeCandidate(
  db: Db,
  candidateId: number,
  status: Exclude<MergeCandidateStatus, 'pending'>,
  options: ResolveCandidateOptions = {},
): void {
  const at = options.at ?? new Date();
  db.update(mergeCandidates)
    .set({
      status,
      resolvedBy: options.resolvedBy ?? 'pipeline',
      resolvedAt: at,
      mergeLogId: options.mergeLogId ?? null,
      lastSeenAt: at,
    })
    .where(eq(mergeCandidates.id, candidateId))
    .run();
}

/**
 * Close out the pending pairs that pointed at a lead which has just been merged
 * away. The pair no longer describes two live rows; the next sweep re-proposes
 * it against the survivor, with the fuller record a reviewer should be judging.
 */
export function releaseCandidatesFor(db: Db, leadId: number, at = new Date()): number {
  const rows = db
    .select({ id: mergeCandidates.id })
    .from(mergeCandidates)
    .where(
      and(
        eq(mergeCandidates.status, 'pending'),
        or(eq(mergeCandidates.leadAId, leadId), eq(mergeCandidates.leadBId, leadId)),
      ),
    )
    .all();
  if (rows.length === 0) return 0;
  db.update(mergeCandidates)
    .set({ status: 'merged', resolvedBy: 'pipeline', resolvedAt: at, lastSeenAt: at })
    .where(
      inArray(
        mergeCandidates.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  return rows.length;
}

/**
 * Merges whose deciding value has since been quarantined.
 *
 * The guard runs before the merges, so this is normally empty. It stops being
 * empty when a later crawl adds the leads that turn a plausible shared number
 * into an obvious one — and then these are exactly the merges to walk back with
 * `revertMerge()`.
 */
export function mergesOnQuarantinedIdentifiers(db: Executor): MergeLogEntry[] {
  const quarantined = db
    .select({ kind: sharedIdentifiers.kind, value: sharedIdentifiers.value })
    .from(sharedIdentifiers)
    .where(eq(sharedIdentifiers.quarantined, true))
    .all();
  if (quarantined.length === 0) return [];

  const signalFor: Record<IdentifierKind, MergeSignal> = {
    phone: 'phone',
    website_domain: 'website_domain',
    email: 'email',
  };
  const suspect = new Set(quarantined.map((q) => `${signalFor[q.kind]} ${q.value}`));
  return db
    .select()
    .from(mergeLog)
    .where(isNull(mergeLog.revertedAt))
    .all()
    .filter((entry) => suspect.has(`${entry.signal} ${entry.signalValue}`));
}

/* -------------------------------------------------------------------------- */
/* Erasure (ZZPL)                                                             */
/* -------------------------------------------------------------------------- */

export interface EraseResult {
  readonly erasedLeadId: number;
  readonly rowsDeleted: Record<string, number>;
  readonly phonesBlocked: number;
}

/**
 * Delete a business on request, for real.
 *
 * A sole trader's business phone is personal data under the ZZPL, so erasure
 * has to reach the raw payloads and the merge snapshots too — both hold the
 * number in full. What survives is `erasure_log`, which holds an id, a reason
 * and a count and no personal data at all, plus the SHA-256 of each erased
 * number in `erasure_blocklist` so the next crawl of the same directory does
 * not quietly put the business back.
 */
export function eraseLead(
  db: Db,
  leadId: number,
  options: { reason: string; requestedBy?: string | null; note?: string | null } = {
    reason: 'data subject request',
  },
): EraseResult {
  return db.transaction((tx) => {
    const at = new Date();
    const lead = getLead(tx, leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);

    const numbers = [...new Set(leadPhoneClaims(tx, leadId).map((phone) => phone.e164))];
    let phonesBlocked = 0;
    for (const e164 of numbers) {
      const hash = sha256(e164);
      const known = tx
        .select({ hash: erasureBlocklist.phoneSha256 })
        .from(erasureBlocklist)
        .where(eq(erasureBlocklist.phoneSha256, hash))
        .get();
      if (!known) {
        tx.insert(erasureBlocklist).values({ phoneSha256: hash, erasedAt: at }).run();
        phonesBlocked += 1;
      }
    }

    const rowsDeleted: Record<string, number> = {
      lead_phones: tx.delete(leadPhones).where(eq(leadPhones.leadId, leadId)).run().changes,
      lead_contacts: tx.delete(leadContacts).where(eq(leadContacts.leadId, leadId)).run().changes,
      lead_field_values: tx.delete(leadFieldValues).where(eq(leadFieldValues.leadId, leadId)).run()
        .changes,
      lead_sources: tx.delete(leadSources).where(eq(leadSources.leadId, leadId)).run().changes,
      raw_records: tx.delete(rawRecords).where(eq(rawRecords.leadId, leadId)).run().changes,
      merge_log:
        tx.delete(mergeLog).where(eq(mergeLog.survivingLeadId, leadId)).run().changes +
        tx.delete(mergeLog).where(eq(mergeLog.mergedLeadId, leadId)).run().changes,
    };

    // Tombstones pointing at an erased survivor would dangle.
    tx.update(leads).set({ mergedIntoId: null }).where(eq(leads.mergedIntoId, leadId)).run();
    rowsDeleted['leads'] = tx.delete(leads).where(eq(leads.id, leadId)).run().changes;

    tx.insert(erasureLog)
      .values({
        erasedLeadId: leadId,
        reason: options.reason,
        requestedBy: options.requestedBy ?? null,
        rowsDeleted: JSON.stringify(rowsDeleted),
        erasedAt: at,
        note: options.note ?? null,
      })
      .run();

    return { erasedLeadId: leadId, rowsDeleted, phonesBlocked };
  });
}

/**
 * Has this number been erased on request? Adapters check before writing, which
 * is the difference between honouring an erasure and re-collecting the data on
 * the next run.
 */
export function isPhoneErased(db: Executor, e164: string): boolean {
  const hit = db
    .select({ hash: erasureBlocklist.phoneSha256 })
    .from(erasureBlocklist)
    .where(eq(erasureBlocklist.phoneSha256, sha256(e164)))
    .get();
  return hit != null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
