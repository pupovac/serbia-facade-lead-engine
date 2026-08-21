/**
 * The dashboard's numbers.
 *
 * Every figure here is a `group by` or a `count` in the database. Nothing is
 * derived by fetching rows and reducing them in a component — the point of the
 * dashboard is that it stays honest and fast when the table is 50,000 rows.
 *
 * The coverage figures compare what has been crawled against
 * `data/serbia-geo.json`, which is the authoritative list of Serbia's 145 local
 * self-government units. "145 of 145" is a measurement, not a target someone
 * typed in.
 */
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import type { Executor } from '../db/repo.js';
import {
  crawlRuns,
  enrichmentSuggestions,
  leadContacts,
  leadPhones,
  leadSources,
  leads,
  mergeCandidates,
  mergeLog,
  sharedIdentifiers,
  sources,
} from '../db/schema.js';
import { getMunicipalityById, municipalities } from '../geo.js';
import type { LeadClassification, LeadStatus } from '../db/schema.js';

const ACTIVE = isNull(leads.mergedIntoId);

/**
 * A lead has a phone when at least one claim parsed. Department labels — the
 * 632 pilot rows holding strings like `0xx xxx xxx, PRODAJA` — do not count.
 *
 * Used as a predicate on a single lead. The per-group *counts* below do not use
 * it: a correlated `exists` evaluated once per row costs a lookup per lead, and
 * at 25,000 leads that was most of the dashboard's runtime. The aggregates join
 * `withPhoneLeads()` instead, which is one grouped pass over `lead_phones`.
 */
const HAS_VALID_PHONE = exists(
  sql`(select 1 from ${leadPhones} where ${leadPhones.leadId} = ${leads.id} and ${leadPhones.valid} = 1)`,
);

/** The lead ids with at least one dialable number, as a joinable subquery. */
function withPhoneLeads(db: Executor) {
  return db
    .select({ leadId: leadPhones.leadId })
    .from(leadPhones)
    .where(eq(leadPhones.valid, true))
    .groupBy(leadPhones.leadId)
    .as('with_phone');
}

/** The lead ids only one source has ever seen, as a joinable subquery. */
function singleSourceLeads(db: Executor) {
  return db
    .select({ leadId: leadSources.leadId })
    .from(leadSources)
    .groupBy(leadSources.leadId)
    .having(eq(countDistinct(leadSources.sourceId), 1))
    .as('single_source');
}

export interface ClassificationCount {
  readonly classification: LeadClassification;
  readonly leads: number;
  readonly withPhone: number;
}

export interface SourceYield {
  readonly sourceId: string;
  readonly name: string;
  readonly leads: number;
  readonly withPhone: number;
  /** Leads only this source has ever seen — what would be lost if it went away. */
  readonly exclusive: number;
  readonly urls: number;
}

/** One municipality's coverage. Present for all 145, including the ones with nothing. */
export interface MunicipalityCoverage {
  readonly id: string;
  readonly name: string;
  readonly district: string;
  readonly region: string;
  readonly population: number;
  readonly leads: number;
  readonly withPhone: number;
  readonly contractors: number;
  readonly stores: number;
}

/** Cumulative lead count after each completed crawl run — the growth curve. */
export interface GrowthPoint {
  readonly runId: number;
  readonly sourceId: string;
  readonly finishedAt: Date | null;
  readonly leadsCreated: number;
  readonly leadsUpdated: number;
  readonly phonesAdded: number;
  readonly cumulativeLeads: number;
}

export interface DashboardStats {
  readonly totalLeads: number;
  readonly withPhone: number;
  readonly withoutPhone: number;
  readonly distinctPhones: number;
  readonly withEmail: number;
  readonly withWebsite: number;
  readonly tombstones: number;
  readonly byClassification: readonly ClassificationCount[];
  readonly byStatus: ReadonlyArray<{ status: LeadStatus; count: number }>;
  readonly sourceYield: readonly SourceYield[];
  readonly growth: readonly GrowthPoint[];
  readonly coverage: readonly MunicipalityCoverage[];
  readonly municipalitiesTotal: number;
  readonly municipalitiesCovered: number;
  readonly reviewQueue: {
    readonly pendingMerges: number;
    readonly pendingSuggestions: number;
    readonly mergesPerformed: number;
    readonly quarantinedIdentifiers: number;
  };
  /** Leads whose place string never matched a municipality slug. */
  readonly unmappedGeo: number;
}

function scalar(row: { value: number } | undefined): number {
  return row?.value ?? 0;
}

export function dashboardStats(db: Executor): DashboardStats {
  const totalLeads = scalar(db.select({ value: count() }).from(leads).where(ACTIVE).get());
  const withPhone = scalar(
    db.select({ value: count() }).from(leads).where(and(ACTIVE, HAS_VALID_PHONE)).get(),
  );
  const tombstones = scalar(
    db.select({ value: count() }).from(leads).where(isNotNull(leads.mergedIntoId)).get(),
  );
  const distinctPhones = scalar(
    db
      .select({ value: countDistinct(leadPhones.e164) })
      .from(leadPhones)
      .innerJoin(leads, eq(leads.id, leadPhones.leadId))
      .where(and(ACTIVE, eq(leadPhones.valid, true)))
      .get(),
  );

  const contactReach = (kind: 'email' | 'website'): number =>
    scalar(
      db
        .select({ value: countDistinct(leadContacts.leadId) })
        .from(leadContacts)
        .innerJoin(leads, eq(leads.id, leadContacts.leadId))
        .where(and(ACTIVE, eq(leadContacts.kind, kind)))
        .get(),
    );

  const phoneLeads = withPhoneLeads(db);
  const byClassification = db
    .select({
      classification: leads.classification,
      leads: count(),
      withPhone: sql<number>`sum(case when ${phoneLeads.leadId} is null then 0 else 1 end)`,
    })
    .from(leads)
    .leftJoin(phoneLeads, eq(phoneLeads.leadId, leads.id))
    .where(ACTIVE)
    .groupBy(leads.classification)
    .orderBy(desc(count()))
    .all()
    .map((row) => ({ ...row, withPhone: Number(row.withPhone ?? 0) }));

  const byStatus = db
    .select({ status: leads.status, count: count() })
    .from(leads)
    .where(ACTIVE)
    .groupBy(leads.status)
    .orderBy(desc(count()))
    .all();

  return {
    totalLeads,
    withPhone,
    withoutPhone: totalLeads - withPhone,
    distinctPhones,
    withEmail: contactReach('email'),
    withWebsite: contactReach('website'),
    tombstones,
    byClassification,
    byStatus,
    sourceYield: sourceYield(db),
    growth: growth(db),
    coverage: municipalityCoverage(db),
    municipalitiesTotal: municipalities.filter((m) => m.parent_id == null).length,
    municipalitiesCovered: scalar(
      db
        .select({ value: countDistinct(leads.municipalityId) })
        .from(leads)
        .where(ACTIVE)
        .get(),
    ),
    reviewQueue: {
      pendingMerges: scalar(
        db
          .select({ value: count() })
          .from(mergeCandidates)
          .where(eq(mergeCandidates.status, 'pending'))
          .get(),
      ),
      pendingSuggestions: scalar(
        db
          .select({ value: count() })
          .from(enrichmentSuggestions)
          .where(eq(enrichmentSuggestions.status, 'pending'))
          .get(),
      ),
      mergesPerformed: scalar(
        db.select({ value: count() }).from(mergeLog).where(isNull(mergeLog.revertedAt)).get(),
      ),
      quarantinedIdentifiers: scalar(
        db
          .select({ value: count() })
          .from(sharedIdentifiers)
          .where(eq(sharedIdentifiers.quarantined, true))
          .get(),
      ),
    },
    unmappedGeo: scalar(
      db
        .select({ value: count() })
        .from(leads)
        .where(and(ACTIVE, isNull(leads.municipalityId)))
        .get(),
    ),
  };
}

/**
 * Per-source yield, including how many leads each source is the *only* witness
 * for. A directory that adds 400 rows nobody else has is worth more than one
 * that adds 400 rows already covered four times over, and the raw lead count
 * cannot tell those apart.
 */
export function sourceYield(db: Executor): SourceYield[] {
  const rows = db
    .select({
      sourceId: leadSources.sourceId,
      name: sources.name,
      leads: countDistinct(leadSources.leadId),
      urls: count(),
    })
    .from(leadSources)
    .innerJoin(leads, eq(leads.id, leadSources.leadId))
    .innerJoin(sources, eq(sources.id, leadSources.sourceId))
    .where(ACTIVE)
    .groupBy(leadSources.sourceId, sources.name)
    .orderBy(desc(countDistinct(leadSources.leadId)))
    .all();

  const phoneLeads = withPhoneLeads(db);
  const withPhone = new Map(
    db
      .select({ sourceId: leadSources.sourceId, value: countDistinct(leadSources.leadId) })
      .from(leadSources)
      .innerJoin(leads, eq(leads.id, leadSources.leadId))
      .innerJoin(phoneLeads, eq(phoneLeads.leadId, leads.id))
      .where(ACTIVE)
      .groupBy(leadSources.sourceId)
      .all()
      .map((row) => [row.sourceId, row.value] as const),
  );

  const single = singleSourceLeads(db);
  const exclusive = new Map(
    db
      .select({ sourceId: leadSources.sourceId, value: countDistinct(leadSources.leadId) })
      .from(leadSources)
      .innerJoin(leads, eq(leads.id, leadSources.leadId))
      .innerJoin(single, eq(single.leadId, leads.id))
      .where(ACTIVE)
      .groupBy(leadSources.sourceId)
      .all()
      .map((row) => [row.sourceId, row.value] as const),
  );

  return rows.map((row) => ({
    ...row,
    withPhone: withPhone.get(row.sourceId) ?? 0,
    exclusive: exclusive.get(row.sourceId) ?? 0,
  }));
}

/**
 * Growth, measured per crawl run rather than per calendar day.
 *
 * The pilot corpus was built in a single day, so a per-day chart is one bar and
 * says nothing. Per run it says what each source actually contributed and in
 * what order — which is the question "is another crawl worth it" needs.
 */
export function growth(db: Executor): GrowthPoint[] {
  const runs = db
    .select({
      runId: crawlRuns.id,
      sourceId: crawlRuns.sourceId,
      finishedAt: crawlRuns.finishedAt,
      leadsCreated: crawlRuns.leadsCreated,
      leadsUpdated: crawlRuns.leadsUpdated,
      phonesAdded: crawlRuns.phonesAdded,
    })
    .from(crawlRuns)
    .where(eq(crawlRuns.status, 'completed'))
    .orderBy(asc(crawlRuns.startedAt), asc(crawlRuns.id))
    .all();

  let cumulative = 0;
  return runs.map((run) => {
    cumulative += run.leadsCreated;
    return { ...run, cumulativeLeads: cumulative };
  });
}

/**
 * Coverage for every one of Serbia's 145 municipalities, crawled or not.
 *
 * The rows with zero leads are the point: a table that only lists what was
 * found cannot show a gap. Belgrade's 17 city municipalities roll up into
 * `beograd` so the denominator stays the 145 local self-government units.
 */
export function municipalityCoverage(db: Executor): MunicipalityCoverage[] {
  const phoneLeads = withPhoneLeads(db);
  const counted = db
    .select({
      municipalityId: leads.municipalityId,
      leads: count(),
      withPhone: sql<number>`sum(case when ${phoneLeads.leadId} is null then 0 else 1 end)`,
      contractors: sql<number>`sum(case when ${leads.classification} in ('FACADE_CONTRACTOR','BOTH') then 1 else 0 end)`,
      stores: sql<number>`sum(case when ${leads.classification} in ('CONSTRUCTION_MATERIAL_STORE','BOTH') then 1 else 0 end)`,
    })
    .from(leads)
    .leftJoin(phoneLeads, eq(phoneLeads.leadId, leads.id))
    .where(ACTIVE)
    .groupBy(leads.municipalityId)
    .all();

  const byId = new Map(
    counted.flatMap((row) =>
      row.municipalityId == null
        ? []
        : [
            [
              row.municipalityId,
              {
                leads: row.leads,
                withPhone: Number(row.withPhone ?? 0),
                contractors: Number(row.contractors ?? 0),
                stores: Number(row.stores ?? 0),
              },
            ] as const,
          ],
    ),
  );

  return municipalities
    .filter((m) => m.parent_id == null)
    .map((m): MunicipalityCoverage => {
      const found = byId.get(m.id);
      return {
        id: m.id,
        name: m.name_sr,
        district: m.district,
        region: m.region,
        population: m.population,
        leads: found?.leads ?? 0,
        withPhone: found?.withPhone ?? 0,
        contractors: found?.contractors ?? 0,
        stores: found?.stores ?? 0,
      };
    })
    .sort((a, b) => b.leads - a.leads || b.population - a.population);
}

export { getMunicipalityById };
