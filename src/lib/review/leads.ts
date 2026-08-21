/**
 * The lead list — server-side search, filter, sort and pagination.
 *
 * Every predicate here is applied in SQL. The dataset is 3,601 leads today and
 * is meant to reach tens of thousands, so a page is a `limit`/`offset` over an
 * indexed `where`, never a slice of a fetched array. The two aggregates a row
 * shows — how many distinct numbers, how many independent sources — are read
 * for the page's ids only, in two grouped queries, rather than per row.
 */
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '../db/repo.js';
import {
  type Lead,
  type LeadClassification,
  leadContacts,
  leadPhones,
  leadSources,
  leads,
  sources,
} from '../db/schema.js';
import { foldForComparison } from '../text/fold.js';
import { getMunicipalityById } from '../geo.js';
import type {
  Facet,
  LeadFacets,
  LeadListPage,
  LeadListRow,
  LeadListQuery,
  LeadSortKey,
  SortDirection,
} from './types.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Only ever `merged_into_id IS NULL`: a tombstone is reachable by id, never listed. */
const ACTIVE = isNull(leads.mergedIntoId);

/** `%` and `_` are wildcards in `LIKE`; a company called `100%` must not match everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function contains(column: AnySQLiteColumn, term: string): SQL {
  return sql`${column} like ${`%${escapeLike(term)}%`} escape '\\'`;
}

/**
 * The subscriber digits of a typed phone query.
 *
 * `lead_phones.e164` is canonical `+381641234567`, and a salesperson searches
 * by pasting whatever the lead list showed them — `064/123-4567`,
 * `00381 64 123 4567`, `+381 64 123 4567`. All three name the same subscriber,
 * and all three have to find it, so the trunk prefixes are peeled off before
 * the match. This is a search affordance, not normalization: a query is a
 * fragment and `src/lib/phone` parses whole numbers.
 */
export function phoneSearchDigits(term: string): string {
  let digits = term.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('381')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/**
 * The free-text predicate.
 *
 * A Serbian user types `Čačak` or `Cacak`, and half the corpus stores its name
 * in Cyrillic, so the term is matched three ways: against the published name
 * (SQLite's `LIKE` is case-insensitive for ASCII), against `name_normalized`
 * — which is already transliterated, folded and lower-cased — using the folded
 * term, and against the phone digits when the term looks like a number.
 */
function searchPredicate(raw: string): SQL | undefined {
  const term = raw.trim();
  if (term === '') return undefined;
  const folded = foldForComparison(term);
  const digits = phoneSearchDigits(term);

  const predicates: SQL[] = [
    contains(leads.name, term),
    contains(leads.nameNormalized, folded),
    contains(leads.cityRaw, term),
    contains(leads.address, term),
  ];
  if (digits.length >= 5) {
    predicates.push(
      exists(
        sql`(select 1 from ${leadPhones} where ${leadPhones.leadId} = ${leads.id} and ${leadPhones.e164} like ${`%${digits}%`})`,
      ),
    );
  }
  return or(...predicates);
}

/** One `where` shared by the page query and the count, so they can never disagree. */
function buildWhere(query: LeadListQuery): SQL | undefined {
  const predicates: SQL[] = [ACTIVE as SQL];

  if (query.search) {
    const search = searchPredicate(query.search);
    if (search) predicates.push(search);
  }
  if (query.municipalityId) predicates.push(eq(leads.municipalityId, query.municipalityId) as SQL);
  if (query.cityId) predicates.push(eq(leads.cityId, query.cityId) as SQL);
  if (query.classifications && query.classifications.length > 0) {
    predicates.push(inArray(leads.classification, [...query.classifications]) as SQL);
  }
  if (query.status) predicates.push(eq(leads.status, query.status) as SQL);
  if (query.minScore != null && query.minScore > 0) {
    predicates.push(gte(leads.leadScore, query.minScore) as SQL);
  }
  if (query.hasPhone != null) {
    // `valid = 1` is not optional: 632 pilot claims hold department labels like
    // `0xx xxx xxx, PRODAJA` that failed to parse, and "has a phone" must mean
    // a number someone can dial.
    const hasValidPhone = exists(
      sql`(select 1 from ${leadPhones} where ${leadPhones.leadId} = ${leads.id} and ${leadPhones.valid} = 1)`,
    );
    predicates.push((query.hasPhone ? hasValidPhone : sql`not ${hasValidPhone}`) as SQL);
  }
  if (query.sourceId) {
    predicates.push(
      exists(
        sql`(select 1 from ${leadSources} where ${leadSources.leadId} = ${leads.id} and ${leadSources.sourceId} = ${query.sourceId})`,
      ) as SQL,
    );
  }
  return and(...predicates);
}

const SORT_COLUMNS = {
  score: leads.leadScore,
  name: leads.nameNormalized,
  city: leads.cityRaw,
  lastSeen: leads.lastSeenAt,
  firstSeen: leads.firstSeenAt,
} as const satisfies Record<LeadSortKey, unknown>;

function orderBy(sort: LeadSortKey, direction: SortDirection): SQL[] {
  const column = SORT_COLUMNS[sort];
  const primary = direction === 'asc' ? asc(column) : desc(column);
  // `id` breaks every tie, so page 2 never repeats or skips a row that page 1
  // showed — the failure mode of an unstable sort under `limit`/`offset`.
  return [primary as SQL, asc(leads.id) as SQL];
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize == null || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)));
}

/**
 * Pick the number to dial first.
 *
 * A claim the source flagged primary wins; failing that a mobile, because a
 * fasader answers one and a switchboard does not; failing that the first
 * number seen. The rule lives here so the list and the export cannot drift.
 */
function pickPrimary(
  phones: ReadonlyArray<{
    e164: string;
    national: string | null;
    type: string;
    isPrimary: boolean;
  }>,
): { e164: string; national: string | null } | null {
  if (phones.length === 0) return null;
  const primary = phones.find((p) => p.isPrimary);
  const mobile = phones.find((p) => p.type === 'mobile');
  const chosen = primary ?? mobile ?? phones[0];
  return chosen ? { e164: chosen.e164, national: chosen.national } : null;
}

/**
 * One page of leads, filtered and ordered in the database.
 *
 * `total` is the size of the whole result set, not of the page — the pager
 * needs it and a truncated fetch cannot produce it.
 */
export function listLeads(db: Executor, query: LeadListQuery = {}): LeadListPage {
  const where = buildWhere(query);
  const pageSize = clampPageSize(query.pageSize);

  const totalRow = db.select({ value: count() }).from(leads).where(where).get();
  const total = totalRow?.value ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.trunc(query.page ?? 1)));

  const ordered = db
    .select({
      id: leads.id,
      name: leads.name,
      cityRaw: leads.cityRaw,
      cityId: leads.cityId,
      municipalityId: leads.municipalityId,
      classification: leads.classification,
      classificationConfidence: leads.classificationConfidence,
      leadScore: leads.leadScore,
      status: leads.status,
      reviewedAt: leads.reviewedAt,
      lastSeenAt: leads.lastSeenAt,
    })
    .from(leads)
    .where(where)
    .orderBy(...orderBy(query.sort ?? 'score', query.direction ?? 'desc'))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  if (ordered.length === 0) {
    return { rows: [], total, page, pageSize, pageCount };
  }

  const ids = ordered.map((row) => row.id);
  const aggregates = aggregatesFor(db, ids);

  return {
    rows: ordered.map((row): LeadListRow => {
      const agg = aggregates.get(row.id);
      const primary = pickPrimary(agg?.phones ?? []);
      return {
        ...row,
        phoneCount: agg?.phones.length ?? 0,
        primaryPhone: primary?.e164 ?? null,
        primaryPhoneNational: primary?.national ?? null,
        sourceCount: agg?.sourceCount ?? 0,
        hasWebsite: agg?.hasWebsite ?? false,
        hasEmail: agg?.hasEmail ?? false,
      };
    }),
    total,
    page,
    pageSize,
    pageCount,
  };
}

interface RowAggregate {
  phones: Array<{ e164: string; national: string | null; type: string; isPrimary: boolean }>;
  sourceCount: number;
  hasWebsite: boolean;
  hasEmail: boolean;
}

/**
 * Phone, source and contact aggregates for one page of ids.
 *
 * Three grouped queries over `≤ pageSize` ids, not one query per row: on a
 * 50-row page that is 3 statements instead of 150, and it does not get worse
 * as the table grows.
 */
function aggregatesFor(db: Executor, ids: readonly number[]): Map<number, RowAggregate> {
  const out = new Map<number, RowAggregate>();
  for (const id of ids) {
    out.set(id, { phones: [], sourceCount: 0, hasWebsite: false, hasEmail: false });
  }

  const phoneRows = db
    .select({
      leadId: leadPhones.leadId,
      e164: leadPhones.e164,
      national: leadPhones.nationalFormat,
      type: leadPhones.type,
      isPrimary: leadPhones.isPrimary,
    })
    .from(leadPhones)
    .where(and(inArray(leadPhones.leadId, [...ids]), eq(leadPhones.valid, true)))
    .orderBy(asc(leadPhones.firstSeenAt), asc(leadPhones.id))
    .all();

  for (const row of phoneRows) {
    const slot = out.get(row.leadId);
    if (!slot) continue;
    // `lead_phones` is one row per claiming source; the list counts numbers.
    if (slot.phones.some((p) => p.e164 === row.e164)) continue;
    slot.phones.push({
      e164: row.e164,
      national: row.national,
      type: row.type,
      isPrimary: row.isPrimary,
    });
  }

  const sourceRows = db
    .select({ leadId: leadSources.leadId, value: countDistinct(leadSources.sourceId) })
    .from(leadSources)
    .where(inArray(leadSources.leadId, [...ids]))
    .groupBy(leadSources.leadId)
    .all();
  for (const row of sourceRows) {
    const slot = out.get(row.leadId);
    if (slot) slot.sourceCount = row.value;
  }

  const contactRows = db
    .select({ leadId: leadContacts.leadId, kind: leadContacts.kind })
    .from(leadContacts)
    .where(
      and(inArray(leadContacts.leadId, [...ids]), inArray(leadContacts.kind, ['website', 'email'])),
    )
    .all();
  for (const row of contactRows) {
    const slot = out.get(row.leadId);
    if (!slot) continue;
    if (row.kind === 'website') slot.hasWebsite = true;
    if (row.kind === 'email') slot.hasEmail = true;
  }

  return out;
}

function municipalityLabel(id: string): string {
  return getMunicipalityById(id)?.name_sr ?? id;
}

/**
 * The filter vocabulary, read from the stored rows.
 *
 * FUZZ-32 is re-classifying this corpus while the UI is being built, so a
 * hard-coded label list would go stale the moment it lands. Every option here
 * is a `group by` over what is actually stored.
 */
export function leadFacets(db: Executor): LeadFacets {
  const toFacet = (value: string, label: string, countValue: number): Facet => ({
    value,
    label,
    count: countValue,
  });

  const classifications = db
    .select({ value: leads.classification, count: count() })
    .from(leads)
    .where(ACTIVE)
    .groupBy(leads.classification)
    .orderBy(desc(count()))
    .all()
    .map((row) => toFacet(row.value, row.value, row.count));

  const statuses = db
    .select({ value: leads.status, count: count() })
    .from(leads)
    .where(ACTIVE)
    .groupBy(leads.status)
    .orderBy(desc(count()))
    .all()
    .map((row) => toFacet(row.value, row.value, row.count));

  const municipalities = db
    .select({ value: leads.municipalityId, count: count() })
    .from(leads)
    .where(ACTIVE)
    .groupBy(leads.municipalityId)
    .all()
    .flatMap((row) =>
      row.value == null ? [] : [toFacet(row.value, municipalityLabel(row.value), row.count)],
    )
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'sr'));

  const sourceRows = db
    .select({
      value: leadSources.sourceId,
      count: countDistinct(leadSources.leadId),
      name: sources.name,
    })
    .from(leadSources)
    .innerJoin(leads, eq(leads.id, leadSources.leadId))
    .innerJoin(sources, eq(sources.id, leadSources.sourceId))
    .where(ACTIVE)
    .groupBy(leadSources.sourceId, sources.name)
    .orderBy(desc(countDistinct(leadSources.leadId)))
    .all()
    .map((row) => toFacet(row.value, row.name, row.count));

  return { classifications, statuses, municipalities, sources: sourceRows };
}

/** Resolve a lead id to the row it lives on today, following a merge tombstone. */
export function activeLeadFor(db: Executor, leadId: number): Lead | undefined {
  const row = db.select().from(leads).where(eq(leads.id, leadId)).get();
  if (!row) return undefined;
  if (row.mergedIntoId == null) return row;
  return db.select().from(leads).where(eq(leads.id, row.mergedIntoId)).get();
}

export type { LeadClassification };
