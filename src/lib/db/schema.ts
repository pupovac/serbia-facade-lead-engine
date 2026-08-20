/**
 * The lead data model — the schema every other component reads and writes.
 *
 * The shape follows from one fact: the same business arrives from several
 * sources, with conflicting spellings and partial data, over and over as runs
 * repeat. So nothing here stores "the value". Everything stores **a claim**:
 * who said it, at which URL, when it was first seen and when it was last seen.
 * The single clean row per business that the UI and the XLSX export need is
 * derived from those claims, not typed in over them.
 *
 * That gives the four properties the project is built on:
 *
 * - **Merge, never delete.** A merged-away lead keeps its row (`merged_into_id`
 *   points at the survivor), its children are re-pointed rather than dropped,
 *   and `merge_log` holds a snapshot so the merge can be explained and undone.
 * - **Phones are the primary identifier.** `lead_phones` holds the canonical
 *   `+381641234567` and the raw string exactly as published, one row per
 *   claiming source, indexed on `e164` because dedup hits that index on every
 *   insert.
 * - **Provenance is per field.** Single-valued facts (name, address, city, …)
 *   live in `lead_field_values`, one row per (field, value, source). More than
 *   one distinct value for a field _is_ the recorded conflict; the one promoted
 *   onto `leads` carries `is_current`.
 * - **Nothing is destroyed by a parser bug.** `raw_records` keeps the untouched
 *   adapter payload, so re-normalization never needs a re-crawl.
 *
 * ## Portability
 *
 * SQLite is the system of record today and Postgres has to stay a driver swap
 * away, so: no SQLite-only expressions, no `INSERT OR REPLACE` (the repository
 * uses portable `ON CONFLICT … DO UPDATE`), enums as `text` + `CHECK`, and
 * timestamps as `integer` epoch milliseconds mapped to `Date` by Drizzle — the
 * one column type that means the same thing in both dialects without a cast.
 *
 * Prose walkthrough of every table and the merge rules: `docs/data-model.md`.
 */
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/** What we think the business is. `UNKNOWN` stays out of the export. */
export const LEAD_CLASSIFICATIONS = [
  'FACADE_CONTRACTOR',
  'CONSTRUCTION_MATERIAL_STORE',
  'BOTH',
  'UNKNOWN',
] as const;
export type LeadClassification = (typeof LEAD_CLASSIFICATIONS)[number];

/** Where a lead is in the human review loop. `new` is what the pipeline writes. */
export const LEAD_STATUSES = ['new', 'reviewed', 'approved', 'rejected', 'merged'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** `libphonenumber-js` verdict, kept because a salesperson dials a mobile first. */
export const PHONE_TYPES = ['mobile', 'landline', 'toll_free', 'voip', 'unknown'] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

/** Everything reachable that is not a phone number. */
export const CONTACT_KINDS = [
  'email',
  'website',
  'facebook',
  'instagram',
  'google_maps',
  'linkedin',
  'youtube',
  'other',
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/**
 * The single-valued lead facts that carry per-field provenance. Multi-valued
 * facts (phones, emails, websites) have their own tables and are not repeated
 * here.
 */
export const PROVENANCE_FIELDS = [
  'name',
  'legal_form',
  'address',
  'postal_code',
  'city',
  'municipality',
  'classification',
  'description',
  'opening_hours',
  'registration_number',
  'tax_id',
  'coordinates',
] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

/**
 * Dedup signal strength, strongest first. `manual` is a reviewer in the UI.
 * A merge on `name_city` alone needs a second corroborating signal — the rule
 * lives in the merge engine, this column only records what was used.
 */
export const MERGE_SIGNALS = [
  'phone',
  'website_domain',
  'email',
  'registration_number',
  'name_city',
  'address',
  'manual',
] as const;
export type MergeSignal = (typeof MERGE_SIGNALS)[number];

/**
 * The identifier kinds strong enough to decide a merge on their own — and
 * therefore the only ones worth quarantining when they turn out to be shared.
 * A name is not here: a name never decides a merge alone.
 */
export const IDENTIFIER_KINDS = ['phone', 'website_domain', 'email'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** Why a decisive identifier stopped being trusted as one. */
export const QUARANTINE_REASONS = [
  /** Attached to more distinct businesses than a real shared line ever is. */
  'shared_across_businesses',
  /** A listing portal's own domain or contact address, republished on every entry. */
  'directory_owned',
  /** A social network, CDN or platform host — never a business's own identity. */
  'infrastructure',
  /** A human said so. */
  'manual',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/**
 * `MERGE_SIGNALS` plus the one corroborating signal that never decides a merge
 * on its own and therefore has no slot in `merge_log`. A review-band pair can
 * still be topped by it, so `merge_candidates` needs the wider vocabulary.
 */
export const MATCH_SIGNALS = [
  'phone',
  'website_domain',
  'email',
  'registration_number',
  'name_city',
  'address',
  'manual',
  'social_profile',
] as const;
export type MatchSignalName = (typeof MATCH_SIGNALS)[number];

/** Where a `review`-band pair is in the human loop. */
export const MERGE_CANDIDATE_STATUSES = ['pending', 'merged', 'rejected'] as const;
export type MergeCandidateStatus = (typeof MERGE_CANDIDATE_STATUSES)[number];

export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CRAWL_STATE_STATUSES = ['pending', 'in_progress', 'done', 'failed'] as const;
export type CrawlStateStatus = (typeof CRAWL_STATE_STATUSES)[number];

/** Did the payload survive the zod boundary, and has it been turned into a lead yet? */
export const RAW_RECORD_STATUSES = ['pending', 'normalized', 'rejected'] as const;
export type RawRecordStatus = (typeof RAW_RECORD_STATUSES)[number];

/** Registry ranking from Stage 1. `rejected` sources are kept as rows, disabled. */
export const SOURCE_PRIORITIES = ['high', 'medium', 'low', 'rejected'] as const;
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];

/* -------------------------------------------------------------------------- */
/* Column helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Epoch milliseconds in SQLite, `timestamp` in Postgres, `Date` in TypeScript.
 * Comparisons and ordering are numeric in both dialects — no `strftime`, no
 * lexicographic date strings.
 */
function timestamp(name: string) {
  return integer(name, { mode: 'timestamp_ms' });
}

function boolean(name: string) {
  return integer(name, { mode: 'boolean' });
}

/**
 * A `CHECK` that keeps a text column inside its enum. Drizzle's `{ enum: … }`
 * is a TypeScript-only narrowing; this is the database-side half, and the
 * syntax is the same in Postgres.
 */
function oneOf(name: string, column: string, values: readonly string[]) {
  const list = sql.raw(values.map((value) => `'${value}'`).join(', '));
  return check(name, sql`${sql.raw(`"${column}"`)} in (${list})`);
}

/* -------------------------------------------------------------------------- */
/* sources — the Stage 1 registry, as rows                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row per data source the project knows about, keyed by the same slug the
 * research registries use (`portal-srbija`, `austrotherm-distributeri`), so a
 * `source_id` anywhere in this schema is greppable in `research/`.
 *
 * Rejected sources stay here with `enabled = false`: knowing a source was
 * evaluated and dropped is worth as much as knowing it was kept.
 */
export const sources = sqliteTable(
  'sources',
  {
    /** Registry slug. Stable across re-seeds — never regenerate these. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** Free text as published by the registry, e.g. `national business directory`. */
    category: text('category').notNull(),
    priority: text('priority', { enum: SOURCE_PRIORITIES }).notNull().default('low'),
    hasContractors: boolean('has_contractors').notNull().default(false),
    hasStores: boolean('has_stores').notNull().default(false),
    /** Playwright is only justified when this is true. */
    requiresJs: boolean('requires_js').notNull().default(false),
    /** `null` when the research could not determine it — treat as "check before crawling". */
    robotsAllows: boolean('robots_allows'),
    /** The verbatim robots.txt rule the verdict came from. */
    robotsRule: text('robots_rule'),
    /** Records the registry expects to be reachable. A projection, not a measurement. */
    estimatedRecords: integer('estimated_records'),
    /** Which `research/sources-*.json` files described this source, comma-separated. */
    registryFiles: text('registry_files'),
    /** Whether the orchestrator may run an adapter for it. */
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    index('sources_priority_idx').on(t.priority, t.enabled),
    oneOf('sources_priority_check', 'priority', SOURCE_PRIORITIES),
  ],
);

/* -------------------------------------------------------------------------- */
/* crawl_runs / crawl_state — incremental crawl bookkeeping                   */
/* -------------------------------------------------------------------------- */

/** One row per adapter execution: what ran, when, and what it produced. */
export const crawlRuns = sqliteTable(
  'crawl_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('running'),
    /** `manual` | `scheduled` | `backfill` — free text, the orchestrator owns the vocabulary. */
    trigger: text('trigger').notNull().default('manual'),
    /** JSON: the cities, queries and limits this run was restricted to. */
    scope: text('scope'),
    requestsMade: integer('requests_made').notNull().default(0),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    recordsEmitted: integer('records_emitted').notNull().default(0),
    /** Failed the zod boundary. Reported, never silently dropped. */
    recordsRejected: integer('records_rejected').notNull().default(0),
    leadsCreated: integer('leads_created').notNull().default(0),
    leadsUpdated: integer('leads_updated').notNull().default(0),
    phonesAdded: integer('phones_added').notNull().default(0),
    mergesPerformed: integer('merges_performed').notNull().default(0),
    error: text('error'),
    notes: text('notes'),
  },
  (t) => [
    index('crawl_runs_source_idx').on(t.sourceId, t.startedAt),
    index('crawl_runs_status_idx').on(t.status),
    oneOf('crawl_runs_status_check', 'status', RUN_STATUSES),
  ],
);

/**
 * Where to resume. One row per (source, scope) — a scope being whatever unit
 * the adapter paginates over: a city page, a category, a search query.
 * `cursor` is opaque to everything but the adapter that wrote it.
 */
export const crawlState = sqliteTable(
  'crawl_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    /** Adapter-defined, stable across runs, e.g. `city:novi-sad|term:fasader`. */
    scopeKey: text('scope_key').notNull(),
    /** Resume token: a page number, a next-page URL, an API offset. */
    cursor: text('cursor'),
    status: text('status', { enum: CRAWL_STATE_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastRunId: integer('last_run_id').references(() => crawlRuns.id),
    lastError: text('last_error'),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    uniqueIndex('crawl_state_scope_idx').on(t.sourceId, t.scopeKey),
    index('crawl_state_status_idx').on(t.status, t.sourceId),
    oneOf('crawl_state_status_check', 'status', CRAWL_STATE_STATUSES),
  ],
);

/* -------------------------------------------------------------------------- */
/* leads — the merged business entity                                         */
/* -------------------------------------------------------------------------- */

/**
 * One row per business, holding the values currently promoted from
 * `lead_field_values`. Reading a lead never requires reconstructing it from
 * claims — that is what makes "one clean row per business" cheap.
 *
 * `city_id` and `municipality_id` are slugs from `data/serbia-geo.json`, not
 * foreign keys: the geo dataset is a versioned reference file, not a table, and
 * it is loaded through `src/lib/geo.ts`. `city_id` is the most specific unit
 * matched (`beograd-vracar`); `municipality_id` is the local self-government
 * unit it rolls up to (`beograd`). For everywhere outside Belgrade they are
 * the same slug.
 */
export const leads = sqliteTable(
  'leads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Serbian, exactly as published. Never translated, never "cleaned". */
    name: text('name').notNull(),
    /** `normalizeCompanyName(name).ascii` — the dedup lookup key, never shown to a user. */
    nameNormalized: text('name_normalized').notNull(),
    /** `d.o.o.`, `pr`, `szr`, … when the source states it. */
    legalForm: text('legal_form'),
    /** Matični broj. */
    registrationNumber: text('registration_number'),
    /** PIB. */
    taxId: text('tax_id'),
    classification: text('classification', { enum: LEAD_CLASSIFICATIONS })
      .notNull()
      .default('UNKNOWN'),
    /** 0–1. How sure the classifier is, not how likely a sale is. */
    classificationConfidence: real('classification_confidence'),
    /**
     * JSON: the spans `classifyLead` matched, the spans it deliberately did not
     * count, and the arithmetic between them. A label a reviewer cannot audit
     * gets overridden or ignored, so the evidence is stored with the label
     * rather than recomputed from text that may since have changed.
     */
    classificationEvidence: text('classification_evidence'),
    cityId: text('city_id'),
    municipalityId: text('municipality_id'),
    /** The place string the source published, before it was matched to a slug. */
    cityRaw: text('city_raw'),
    address: text('address'),
    addressNormalized: text('address_normalized'),
    postalCode: text('postal_code'),
    latitude: real('latitude'),
    longitude: real('longitude'),
    description: text('description'),
    openingHours: text('opening_hours'),
    /** 0–100 data completeness and relevance. Never a purchase-likelihood guess. */
    leadScore: integer('lead_score').notNull().default(0),
    /** JSON: which component contributed how many points. */
    scoreBreakdown: text('score_breakdown'),
    status: text('status', { enum: LEAD_STATUSES }).notNull().default('new'),
    reviewNote: text('review_note'),
    reviewedAt: timestamp('reviewed_at'),
    /**
     * Set when this lead was merged into another. The row stays — every id ever
     * handed out keeps resolving — but its children have moved to the survivor.
     */
    mergedIntoId: integer('merged_into_id').references((): AnySQLiteColumn => leads.id),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    /** Last time a source was actually fetched for this lead, successful or not. */
    lastScrapedAt: timestamp('last_scraped_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    // Dedup path 4: company name + city. Hit on every insert that has no
    // phone, domain or email match.
    index('leads_name_city_idx').on(t.nameNormalized, t.cityId),
    index('leads_name_idx').on(t.nameNormalized),
    index('leads_registration_idx').on(t.registrationNumber),
    // The review UI's default listing: relevant leads, best first.
    index('leads_classification_status_idx').on(t.classification, t.status, t.leadScore),
    index('leads_merged_into_idx').on(t.mergedIntoId),
    // The merge engine's fuzzy pass blocks on the city: a near-duplicate name
    // is only ever compared against the other leads in the same place.
    index('leads_city_idx').on(t.cityId),
    index('leads_last_scraped_idx').on(t.lastScrapedAt),
    oneOf('leads_classification_check', 'classification', LEAD_CLASSIFICATIONS),
    oneOf('leads_status_check', 'status', LEAD_STATUSES),
  ],
);

/* -------------------------------------------------------------------------- */
/* lead_phones — the primary deliverable                                      */
/* -------------------------------------------------------------------------- */

/**
 * A row is **one source's claim about one phone number**, not a phone number.
 * Two directories that both list `064/123-4567` produce two rows: they disagree
 * about the raw formatting, and the count of distinct sources claiming a number
 * is a real corroboration signal that feeds the lead score.
 *
 * The UI and the export collapse by `e164`; `repo.distinctPhones()` does it in
 * one place so nobody re-implements the rule.
 *
 * A number `libphonenumber-js` rejects is kept with `valid = false` rather than
 * dropped — a lead is never discarded for a bad phone, and the raw string is
 * the only evidence of what the source actually published.
 */
export const leadPhones = sqliteTable(
  'lead_phones',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    /** Canonical `+381641234567`. Present even when `valid` is false, if parseable at all. */
    e164: text('e164').notNull(),
    /** Exactly as published: `064/123-4567`, `+381 64 123 4567`, `00381641234567`. */
    raw: text('raw').notNull(),
    /** `064 123 4567` — the form a Serbian salesperson dials. */
    nationalFormat: text('national_format'),
    type: text('type', { enum: PHONE_TYPES }).notNull().default('unknown'),
    isPrimary: boolean('is_primary').notNull().default(false),
    valid: boolean('valid').notNull().default(true),
    confidence: real('confidence'),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    sourceUrl: text('source_url').notNull(),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  (t) => [
    // Dedup path 1, the strongest signal: every incoming phone probes this.
    index('lead_phones_e164_idx').on(t.e164),
    index('lead_phones_lead_idx').on(t.leadId),
    uniqueIndex('lead_phones_claim_idx').on(t.leadId, t.e164, t.sourceId),
    oneOf('lead_phones_type_check', 'type', PHONE_TYPES),
  ],
);

/* -------------------------------------------------------------------------- */
/* lead_contacts — emails, websites, social profiles                          */
/* -------------------------------------------------------------------------- */

/**
 * Same claim-shaped rule as `lead_phones`: one row per (lead, kind, value,
 * source). `domain` is the registrable domain of a website or the host part of
 * an email, extracted once at write time because dedup paths 2 and 3 look it
 * up on every insert and a `LIKE '%…'` scan is not an index.
 */
export const leadContacts = sqliteTable(
  'lead_contacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: CONTACT_KINDS }).notNull(),
    /** Canonical form: lower-cased email, normalized URL, canonical profile URL. */
    value: text('value').notNull(),
    /** Exactly as published, including the tracking query string if there was one. */
    valueRaw: text('value_raw').notNull(),
    /** Registrable domain for `website` and `email`; null for social kinds. */
    domain: text('domain'),
    /** Page slug or handle for a social profile. */
    handle: text('handle'),
    isPrimary: boolean('is_primary').notNull().default(false),
    valid: boolean('valid').notNull().default(true),
    confidence: real('confidence'),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    sourceUrl: text('source_url').notNull(),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  (t) => [
    // Dedup paths 2 and 3: website domain, then email.
    index('lead_contacts_domain_idx').on(t.domain),
    index('lead_contacts_kind_value_idx').on(t.kind, t.value),
    index('lead_contacts_lead_idx').on(t.leadId, t.kind),
    uniqueIndex('lead_contacts_claim_idx').on(t.leadId, t.kind, t.value, t.sourceId),
    oneOf('lead_contacts_kind_check', 'kind', CONTACT_KINDS),
  ],
);

/* -------------------------------------------------------------------------- */
/* lead_field_values — per-field provenance and recorded conflicts            */
/* -------------------------------------------------------------------------- */

/**
 * The claim log for the single-valued facts on `leads`.
 *
 * Two sources spelling a company `Fasader Plus d.o.o.` and `FASADER PLUS DOO`
 * produce two rows for `field = 'name'`. Exactly one carries `is_current = true`
 * and matches `leads.name`; the other is the conflict, preserved with its own
 * provenance. Nothing is silently resolved in favour of whoever wrote last, and
 * `repo.fieldConflicts()` is what the review UI reads to show a reviewer both.
 */
export const leadFieldValues = sqliteTable(
  'lead_field_values',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    field: text('field', { enum: PROVENANCE_FIELDS }).notNull(),
    value: text('value').notNull(),
    /** Folded comparison key, so `Čačak` and `Cacak` are not recorded as a conflict. */
    valueNormalized: text('value_normalized'),
    /** True for the one claim promoted onto the `leads` row. */
    isCurrent: boolean('is_current').notNull().default(false),
    confidence: real('confidence'),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    sourceUrl: text('source_url').notNull(),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  (t) => [
    index('lead_field_values_lead_idx').on(t.leadId, t.field),
    index('lead_field_values_current_idx').on(t.leadId, t.isCurrent),
    uniqueIndex('lead_field_values_claim_idx').on(t.leadId, t.field, t.value, t.sourceId),
    oneOf('lead_field_values_field_check', 'field', PROVENANCE_FIELDS),
  ],
);

/* -------------------------------------------------------------------------- */
/* raw_records — the untouched adapter payload                                */
/* -------------------------------------------------------------------------- */

/**
 * What the adapter emitted, before normalization, exactly as it emitted it.
 *
 * This is the insurance policy against a parser bug: re-normalizing the whole
 * database is a local operation over this table, not a re-crawl of every
 * source. It is also where a record that failed the zod boundary lands, with
 * the validation error, so "rejected" is inspectable instead of lost.
 *
 * `(source_id, content_hash)` is unique, so a re-run of an unchanged page
 * bumps `last_seen_at` and `seen_count` instead of inserting a duplicate.
 */
export const rawRecords = sqliteTable(
  'raw_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    runId: integer('run_id').references(() => crawlRuns.id),
    /** The exact URL this payload was seen at, not the source's homepage. */
    sourceUrl: text('source_url').notNull(),
    /** Content hash of `payload`, so an unchanged re-scrape is recognised cheaply. */
    contentHash: text('content_hash').notNull(),
    /** JSON, verbatim from the adapter. Never rewritten in place. */
    payload: text('payload').notNull(),
    status: text('status', { enum: RAW_RECORD_STATUSES }).notNull().default('pending'),
    /** The zod error when `status = 'rejected'`. */
    validationError: text('validation_error'),
    /** Set once this payload has been normalized onto a lead. */
    leadId: integer('lead_id').references(() => leads.id),
    seenCount: integer('seen_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  (t) => [
    uniqueIndex('raw_records_content_idx').on(t.sourceId, t.contentHash),
    index('raw_records_source_url_idx').on(t.sourceId, t.sourceUrl),
    index('raw_records_run_idx').on(t.runId),
    index('raw_records_status_idx').on(t.status),
    index('raw_records_lead_idx').on(t.leadId),
    oneOf('raw_records_status_check', 'status', RAW_RECORD_STATUSES),
  ],
);

/* -------------------------------------------------------------------------- */
/* lead_sources — lead ↔ source, at the exact URL                             */
/* -------------------------------------------------------------------------- */

/**
 * **Never collapsed.** One row per (lead, source, URL): the same business
 * listed on three pages of one directory is three rows, and a business seen by
 * four independent directories is four sources. "How many independent sources
 * saw this business" feeds both the lead score and the confidence of a merge,
 * and neither can be recovered once this is flattened.
 *
 * A re-run updates `last_seen_at`, `last_scraped_at` and `times_seen` — it does
 * not insert.
 */
export const leadSources = sqliteTable(
  'lead_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    sourceUrl: text('source_url').notNull(),
    rawRecordId: integer('raw_record_id').references(() => rawRecords.id),
    firstRunId: integer('first_run_id').references(() => crawlRuns.id),
    lastRunId: integer('last_run_id').references(() => crawlRuns.id),
    timesSeen: integer('times_seen').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    lastScrapedAt: timestamp('last_scraped_at').notNull(),
  },
  (t) => [
    uniqueIndex('lead_sources_unique_idx').on(t.leadId, t.sourceId, t.sourceUrl),
    index('lead_sources_lead_idx').on(t.leadId),
    index('lead_sources_source_idx').on(t.sourceId),
  ],
);

/* -------------------------------------------------------------------------- */
/* merge_log — every merge, explainable and reversible                        */
/* -------------------------------------------------------------------------- */

/**
 * Why two leads became one, and enough state to undo it.
 *
 * `snapshot` is the merged-away lead's row plus the ids of every child that
 * moved, taken inside the merge transaction. `repo.revertMerge()` walks it
 * back. Without the snapshot a merge would be explainable but not reversible,
 * and the merge engine would have no safe way to be wrong.
 */
export const mergeLog = sqliteTable(
  'merge_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    survivingLeadId: integer('surviving_lead_id')
      .notNull()
      .references(() => leads.id),
    mergedLeadId: integer('merged_lead_id')
      .notNull()
      .references(() => leads.id),
    signal: text('signal', { enum: MERGE_SIGNALS }).notNull(),
    /** The value that matched: the e164, the domain, the email, the name+city key. */
    signalValue: text('signal_value').notNull(),
    /** The dedup engine's score for this match, 0–1. */
    score: real('score'),
    /**
     * JSON: every signal `scoreMatch` weighed, not just the deciding one.
     * A merge that can only name its winning signal cannot be argued with; the
     * evidence is stored with the verdict for the same reason the classifier
     * stores `classification_evidence` with its label.
     */
    signals: text('signals'),
    /** `pipeline` or `reviewer:<id>` — who decided. */
    actor: text('actor').notNull().default('pipeline'),
    runId: integer('run_id').references(() => crawlRuns.id),
    /** JSON: the merged-away lead row and the child ids that moved. */
    snapshot: text('snapshot').notNull(),
    mergedAt: timestamp('merged_at').notNull(),
    revertedAt: timestamp('reverted_at'),
    revertNote: text('revert_note'),
  },
  (t) => [
    index('merge_log_surviving_idx').on(t.survivingLeadId),
    index('merge_log_merged_idx').on(t.mergedLeadId),
    index('merge_log_merged_at_idx').on(t.mergedAt),
    oneOf('merge_log_signal_check', 'signal', MERGE_SIGNALS),
  ],
);

/* -------------------------------------------------------------------------- */
/* erasure — ZZPL deletion on request                                         */
/* -------------------------------------------------------------------------- */

/**
 * Many fasaderi are sole traders, so their business phone is personal data and
 * an erasure request has to actually erase. `repo.eraseLead()` hard-deletes the
 * lead and everything hanging off it — this table is the audit trail that
 * survives, and it deliberately holds **no personal data**: an id, a reason and
 * a count.
 */
export const erasureLog = sqliteTable(
  'erasure_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The erased lead's id. No foreign key — the row it pointed at is gone. */
    erasedLeadId: integer('erased_lead_id').notNull(),
    reason: text('reason').notNull(),
    /** Who asked, as an internal reference (ticket id), never a name or a number. */
    requestedBy: text('requested_by'),
    /** JSON: rows deleted per table. */
    rowsDeleted: text('rows_deleted'),
    erasedAt: timestamp('erased_at').notNull(),
    note: text('note'),
  },
  (t) => [uniqueIndex('erasure_log_lead_idx').on(t.erasedLeadId)],
);

/**
 * Phone hashes that must never be re-collected.
 *
 * Erasure without this is theatre: the next crawl of the same directory would
 * insert the same business again. Only the SHA-256 of the canonical `e164` is
 * stored, so the blocklist can be checked at the adapter boundary without
 * holding the number it protects.
 */
export const erasureBlocklist = sqliteTable(
  'erasure_blocklist',
  {
    /** SHA-256 of the canonical `+381…` form, lower-case hex. */
    phoneSha256: text('phone_sha256').primaryKey(),
    erasedAt: timestamp('erased_at').notNull(),
  },
  (t) => [index('erasure_blocklist_erased_at_idx').on(t.erasedAt)],
);

/* -------------------------------------------------------------------------- */
/* shared_identifiers — the quarantine that stops a chain merge               */
/* -------------------------------------------------------------------------- */

/**
 * One call-centre number, one marketplace domain, one directory's contact
 * address — each of them is published next to dozens of unrelated businesses,
 * and each of them is a decisive dedup signal. Left alone, one such value
 * collapses a hundred leads into a single row and the whole export becomes
 * untrustworthy.
 *
 * So a value that turns out to be attached to an implausible number of
 * *distinct businesses* is written here with `quarantined = true`, and every
 * matcher — `upsertLead`'s exact lookups and the merge engine's candidate
 * search alike — skips it. The row is kept whether or not it is quarantined:
 * knowing that a number spans three businesses and was allowed is worth as much
 * as knowing that one spanning forty was stopped.
 *
 * `src/lib/dedup` computes and refreshes these rows; nothing else writes them.
 */
export const sharedIdentifiers = sqliteTable(
  'shared_identifiers',
  {
    kind: text('kind', { enum: IDENTIFIER_KINDS }).notNull(),
    /** Canonical form: the `+381…` e164, the registrable domain, the lower-cased address. */
    value: text('value').notNull(),
    /** How many un-merged leads carry this value right now. */
    distinctLeads: integer('distinct_leads').notNull().default(0),
    /**
     * How many of those are *different businesses* — near-identical spellings of
     * one name count once. This, not `distinct_leads`, is what trips the guard:
     * one fasader listed by six directories is normal, six businesses on one
     * number is not.
     */
    distinctBusinesses: integer('distinct_businesses').notNull().default(0),
    quarantined: boolean('quarantined').notNull().default(false),
    reason: text('reason', { enum: QUARANTINE_REASONS }),
    /** JSON: a few of the distinct names seen, so a human can judge the verdict. */
    sampleNames: text('sample_names'),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.value] }),
    // Every exact-signal lookup probes this before trusting its hit.
    index('shared_identifiers_quarantined_idx').on(t.quarantined, t.kind),
    oneOf('shared_identifiers_kind_check', 'kind', IDENTIFIER_KINDS),
    oneOf('shared_identifiers_reason_check', 'reason', QUARANTINE_REASONS),
  ],
);

/* -------------------------------------------------------------------------- */
/* merge_candidates — the review band, and the reviewer's answer              */
/* -------------------------------------------------------------------------- */

/**
 * A pair the merge engine believes is probably one business but will not merge
 * on its own — a strong name match in the same city with nothing corroborating
 * it, or a decisive signal that landed on a quarantined value.
 *
 * The row exists for two reasons. It is what the Stage 5 review UI lists, and
 * it is what makes a rejection stick: without it the next sweep would re-propose
 * every pair a human has already looked at and said no to.
 *
 * `lead_a_id < lead_b_id` always, so a pair has exactly one row no matter which
 * way round the sweep happened to find it.
 */
export const mergeCandidates = sqliteTable(
  'merge_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The lower of the two lead ids — the pair is unordered. */
    leadAId: integer('lead_a_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    leadBId: integer('lead_b_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    /** 0–1, from `scoreMatch`. Orders the review queue. */
    score: real('score').notNull(),
    /** The strongest signal found — `merge_log`'s vocabulary plus `social_profile`. */
    topSignal: text('top_signal', { enum: MATCH_SIGNALS }).notNull(),
    signalValue: text('signal_value').notNull(),
    /** JSON: every signal `scoreMatch` weighed, including the ones that argued against. */
    signals: text('signals').notNull(),
    status: text('status', { enum: MERGE_CANDIDATE_STATUSES }).notNull().default('pending'),
    /** `pipeline` or `reviewer:<id>`. */
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at'),
    /** Set when the reviewer said yes — the merge this pair became. */
    mergeLogId: integer('merge_log_id').references(() => mergeLog.id),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  (t) => [
    uniqueIndex('merge_candidates_pair_idx').on(t.leadAId, t.leadBId),
    // The review UI's queue: everything still pending, best evidence first.
    index('merge_candidates_status_idx').on(t.status, t.score),
    index('merge_candidates_lead_b_idx').on(t.leadBId),
    oneOf('merge_candidates_status_check', 'status', MERGE_CANDIDATE_STATUSES),
    oneOf('merge_candidates_signal_check', 'top_signal', MATCH_SIGNALS),
  ],
);

/* -------------------------------------------------------------------------- */
/* Inferred row types                                                         */
/* -------------------------------------------------------------------------- */

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type CrawlRun = typeof crawlRuns.$inferSelect;
export type NewCrawlRun = typeof crawlRuns.$inferInsert;
export type CrawlStateRow = typeof crawlState.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadPhone = typeof leadPhones.$inferSelect;
export type LeadContact = typeof leadContacts.$inferSelect;
export type LeadFieldValue = typeof leadFieldValues.$inferSelect;
export type LeadSource = typeof leadSources.$inferSelect;
export type RawRecord = typeof rawRecords.$inferSelect;
export type MergeLogEntry = typeof mergeLog.$inferSelect;
export type ErasureLogEntry = typeof erasureLog.$inferSelect;
export type SharedIdentifier = typeof sharedIdentifiers.$inferSelect;
export type MergeCandidate = typeof mergeCandidates.$inferSelect;
