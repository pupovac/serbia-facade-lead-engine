/**
 * Which leads are worth spending requests on, and in what order.
 *
 * The ordering key is **what enrichment would add to the lead score**, taken
 * from `src/lib/score`'s weight table rather than invented here, so the crawler
 * spends its budget where the product says the value is. That puts a lead with
 * a website and no phone at the top of every queue by a wide margin: filling
 * the phone is worth 38 points, a mobile 4 more, and it lifts the
 * `NO_PHONE_CEILING` that is holding the whole row at 25.
 *
 * The selection is deliberately not a SQL `WHERE` over `leads`. What is missing
 * from a lead lives in `lead_phones` and `lead_contacts`, and reconstructing it
 * is exactly what `src/lib/dedup`'s `toLeadRecord` already does — including
 * dropping the invalid phones, which a `count(*)` would have counted as
 * present. So the pass reads every live lead through that accessor and filters
 * in TypeScript. At the corpus size this project works with (thousands, in an
 * in-process SQLite file) that costs milliseconds, and it cannot disagree with
 * the matcher about what the lead holds.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getMunicipalityById } from '@/lib/geo';
import { crawlState, leadContacts, leads, type Db, type Executor } from '@/lib/db';
import { toLeadRecord } from '@/lib/dedup';
import { leadScopeKey } from './sources.js';
import { FIELD_GAIN } from './thresholds.js';
import type { EnrichableField, EnrichmentTarget } from './types.js';

export interface SelectTargetsOptions {
  /** Stop after this many targets. `null` means every lead that would gain something. */
  readonly limit?: number | null | undefined;
  /** Restrict to these lead ids — the `--lead` flag, and what the tests use. */
  readonly leadIds?: readonly number[] | undefined;
  /** Only leads that already carry a website: the high-confidence path alone. */
  readonly withWebsiteOnly?: boolean | undefined;
  /** Only leads that carry no website: the search path alone. */
  readonly withoutWebsiteOnly?: boolean | undefined;
  /** Skip a lead enrichment already visited inside this window. */
  readonly stalenessMs?: number | undefined;
  /** The source ids whose `crawl_state` rows record the last enrichment visit. */
  readonly sourceIds?: readonly string[] | undefined;
  readonly now?: Date | undefined;
}

/** Fields worth crawling for. Ordered as the log prints them: the phone first. */
const ENRICHABLE: readonly EnrichableField[] = [
  'phone',
  'email',
  'website',
  'social',
  'address',
  'city',
];

/**
 * The leads that would gain something, best first.
 *
 * A lead that is already complete is not a target: it has nothing to gain, and
 * a request spent on it is a request not spent on a lead with no phone.
 */
export function selectTargets(db: Db, options: SelectTargetsOptions = {}): EnrichmentTarget[] {
  const now = options.now ?? new Date();
  const stalenessMs = options.stalenessMs ?? 0;
  const enrichmentSources = new Set(options.sourceIds ?? []);
  const wanted = options.leadIds === undefined ? null : new Set(options.leadIds);

  // `merged_into_id is null` — a merged-away row is a tombstone. Enriching it
  // would write claims onto an id the UI never shows and the export never
  // reads.
  const rows = db
    .select({ id: leads.id, name: leads.name, cityId: leads.cityId, cityRaw: leads.cityRaw })
    .from(leads)
    .where(isNull(leads.mergedIntoId))
    .all();

  const targets: EnrichmentTarget[] = [];
  for (const row of rows) {
    if (wanted !== null && !wanted.has(row.id)) continue;

    const record = toLeadRecord(db, row.id);
    /* c8 ignore next -- the id came from the same table one statement ago */
    if (record === undefined) continue;

    const missing = missingFields(record);
    if (missing.length === 0) continue;

    const hasWebsite = record.websiteDomains.length > 0;
    if (options.withWebsiteOnly === true && !hasWebsite) continue;
    if (options.withoutWebsiteOnly === true && hasWebsite) continue;

    if (
      stalenessMs > 0 &&
      enrichmentSources.size > 0 &&
      visitedRecently(db, row.id, enrichmentSources, now, stalenessMs)
    ) {
      continue;
    }

    targets.push({
      leadId: row.id,
      name: row.name,
      cityName: cityNameOf(row.cityId, row.cityRaw),
      record,
      websites: websitesOf(db, row.id),
      missing,
      potentialGain: missing.reduce((total, field) => total + FIELD_GAIN[field], 0),
    });
  }

  targets.sort((a, b) => b.potentialGain - a.potentialGain || a.leadId - b.leadId);
  const limit = options.limit ?? null;
  return limit === null ? targets : targets.slice(0, limit);
}

/**
 * What this lead has not got.
 *
 * `social` counts as present when any one of Facebook, Instagram or Google Maps
 * is on the lead — a fasader with a Facebook page does not also need an
 * Instagram before the row is usable.
 */
export function missingFields(
  record: import('@/lib/dedup').LeadRecord,
): readonly EnrichableField[] {
  const present: Record<EnrichableField, boolean> = {
    phone: record.phones.length > 0,
    email: record.emails.length > 0,
    website: record.websiteDomains.length > 0,
    social: record.socialUrls.length > 0,
    address: record.addressNormalized !== null && record.addressNormalized !== '',
    city: record.cityId !== null || record.municipalityId !== null,
  };
  return ENRICHABLE.filter((field) => !present[field]);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The canonical `https://…` URLs the lead carries, from `lead_contacts`.
 *
 * `LeadRecord.websiteDomains` holds registrable domains, which is what the
 * matcher compares; a crawler needs the scheme and the host the source actually
 * published, because `firma.rs` and `www.firma.rs` are not interchangeable to
 * every virtual host.
 */
function websitesOf(db: Executor, leadId: number): string[] {
  const rows = db
    .select({ value: leadContacts.value })
    .from(leadContacts)
    .where(and(eq(leadContacts.leadId, leadId), eq(leadContacts.kind, 'website')))
    .all();
  return [...new Set(rows.map((row) => row.value))];
}

/**
 * Has enrichment already looked at this lead recently?
 *
 * Read from `crawl_state`, not from `lead_sources`, and the difference is the
 * whole point: a lead whose site had nothing to add leaves no claim behind, so
 * a `lead_sources` check would send the crawler back to it every single run.
 */
function visitedRecently(
  db: Executor,
  leadId: number,
  sourceIds: ReadonlySet<string>,
  now: Date,
  stalenessMs: number,
): boolean {
  const key = leadScopeKey(leadId);
  const rows = db
    .select({ sourceId: crawlState.sourceId, lastSeenAt: crawlState.lastSeenAt })
    .from(crawlState)
    .where(eq(crawlState.scopeKey, key))
    .all();
  return rows.some(
    (row) => sourceIds.has(row.sourceId) && now.getTime() - row.lastSeenAt.getTime() < stalenessMs,
  );
}

/** The municipality's published name, falling back to whatever the source wrote. */
function cityNameOf(cityId: string | null, cityRaw: string | null): string | null {
  if (cityId !== null) {
    const municipality = getMunicipalityById(cityId);
    if (municipality !== undefined) return municipality.name_sr;
  }
  return cityRaw;
}
