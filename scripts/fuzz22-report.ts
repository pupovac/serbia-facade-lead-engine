#!/usr/bin/env node
/**
 * FUZZ-22 — the pilot report's numbers, derived from the pilot database.
 *
 * Committed so every figure in `research/pilot-report.md` can be re-derived
 * rather than taken on trust, the same way `fuzz18-overlap.ts` is. It reads
 * only; nothing here writes to the database.
 */
import Database from 'better-sqlite3';
import { municipalities, type Municipality } from '../src/lib/geo.js';

const url = process.argv[2] ?? './data/leads.sqlite';
const db = new Database(url, { readonly: true });
/** Every query here is a report line, so the row shape is stated at the call site. */
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] =>
  db.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T =>
  db.prepare(sql).get(...p) as T;

interface MuniRow {
  municipality_id: string;
  leads: number;
  with_phone: number;
  contractors: number;
  stores: number;
}
interface CountRow {
  n: number;
}

const out: Record<string, unknown> = {};
const ACTIVE = 'merged_into_id IS NULL';

/* -------------------------------------------------------------- headline -- */
out.headline = one(`
  SELECT
    (SELECT COUNT(*) FROM leads)                                   AS leads_all_rows,
    (SELECT COUNT(*) FROM leads WHERE ${ACTIVE})                   AS leads_active,
    (SELECT COUNT(*) FROM leads WHERE merged_into_id IS NOT NULL)  AS leads_tombstoned,
    (SELECT COUNT(*) FROM leads l WHERE ${ACTIVE}
       AND EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id = l.id AND p.valid = 1)) AS leads_with_phone,
    (SELECT COUNT(*) FROM leads l WHERE ${ACTIVE}
       AND EXISTS (SELECT 1 FROM lead_contacts c WHERE c.lead_id = l.id AND c.kind='email')) AS leads_with_email,
    (SELECT COUNT(*) FROM leads l WHERE ${ACTIVE}
       AND EXISTS (SELECT 1 FROM lead_contacts c WHERE c.lead_id = l.id AND c.kind='website')) AS leads_with_website,
    (SELECT COUNT(*) FROM lead_phones)                             AS phone_rows,
    (SELECT COUNT(DISTINCT e164) FROM lead_phones WHERE valid = 1) AS distinct_e164,
    (SELECT COUNT(*) FROM leads WHERE ${ACTIVE} AND municipality_id IS NOT NULL) AS leads_with_municipality
`);

/* -------------------------------------------------- by classification ----- */
out.by_classification = q(`
  SELECT classification,
         COUNT(*) AS leads,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id=l.id AND p.valid=1)
                  THEN 1 ELSE 0 END) AS with_phone,
         ROUND(AVG(lead_score), 1) AS avg_score
  FROM leads l WHERE ${ACTIVE}
  GROUP BY classification ORDER BY leads DESC
`);

/* --------------------------------------------------------- per source ---- */
out.by_source = q(`
  SELECT ls.source_id,
         COUNT(DISTINCT ls.lead_id) AS leads,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id=ls.lead_id AND p.valid=1)
                  THEN 1 ELSE 0 END) AS with_phone
  FROM lead_sources ls JOIN leads l ON l.id = ls.lead_id
  WHERE l.merged_into_id IS NULL
  GROUP BY ls.source_id ORDER BY leads DESC
`);

out.by_source_classification = q(`
  SELECT ls.source_id, l.classification, COUNT(DISTINCT l.id) AS leads
  FROM lead_sources ls JOIN leads l ON l.id = ls.lead_id
  WHERE l.merged_into_id IS NULL
  GROUP BY 1,2 ORDER BY 1, leads DESC
`);

/* ------------------------------------------- source overlap (co-occurrence) */
out.sources_per_lead = q(`
  SELECT n, COUNT(*) AS leads FROM (
    SELECT l.id, COUNT(DISTINCT ls.source_id) AS n
    FROM leads l JOIN lead_sources ls ON ls.lead_id = l.id
    WHERE l.merged_into_id IS NULL GROUP BY l.id
  ) GROUP BY n ORDER BY n
`);

out.source_pair_overlap = q(`
  SELECT a.source_id AS source_a, b.source_id AS source_b, COUNT(DISTINCT a.lead_id) AS shared_leads
  FROM lead_sources a JOIN lead_sources b ON a.lead_id = b.lead_id AND a.source_id < b.source_id
  JOIN leads l ON l.id = a.lead_id AND l.merged_into_id IS NULL
  GROUP BY 1,2 ORDER BY shared_leads DESC
`);

/* ----------------------------------------------------- per municipality --- */
const perMuni = q<MuniRow>(`
  SELECT COALESCE(l.municipality_id,'(unassigned)') AS municipality_id,
         COUNT(*) AS leads,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id=l.id AND p.valid=1)
                  THEN 1 ELSE 0 END) AS with_phone,
         SUM(CASE WHEN l.classification IN ('FACADE_CONTRACTOR','BOTH') THEN 1 ELSE 0 END) AS contractors,
         SUM(CASE WHEN l.classification IN ('CONSTRUCTION_MATERIAL_STORE','BOTH') THEN 1 ELSE 0 END) AS stores
  FROM leads l WHERE ${ACTIVE} GROUP BY 1
`);
const byMuni = new Map<string, MuniRow>(perMuni.map((r) => [r.municipality_id, r]));

const units: readonly Municipality[] = municipalities.filter((m) => m.parent_id === null);
const totalPop = units.reduce((sum: number, m: Municipality) => sum + m.population, 0);
const totalAssigned = perMuni
  .filter((r) => r.municipality_id !== '(unassigned)')
  .reduce((sum: number, r: MuniRow) => sum + r.leads, 0);

out.municipality_coverage = {
  units_total: units.length,
  units_with_at_least_one_lead: units.filter(
    (m: Municipality) => (byMuni.get(m.id)?.leads ?? 0) > 0,
  ).length,
  units_empty: units
    .filter((m: Municipality) => (byMuni.get(m.id)?.leads ?? 0) === 0)
    .map((m: Municipality) => m.id),
  unassigned_leads: byMuni.get('(unassigned)')?.leads ?? 0,
};

/* Leads per 10k inhabitants, and the national rate, so "implausibly low" is a
 * measured shortfall rather than an impression. */
const nationalPer10k = (totalAssigned / totalPop) * 10_000;
const muniRows = units.map((m: Municipality) => {
  const r = byMuni.get(m.id);
  const leads = r?.leads ?? 0;
  const expected = (m.population / 10_000) * nationalPer10k;
  return {
    id: m.id,
    name: m.name_sr,
    tier: m.priority_tier,
    region: m.region,
    population: m.population,
    leads,
    with_phone: r?.with_phone ?? 0,
    contractors: r?.contractors ?? 0,
    stores: r?.stores ?? 0,
    per_10k: Number(((leads / m.population) * 10_000).toFixed(2)),
    expected_at_national_rate: Number(expected.toFixed(1)),
    shortfall: Number((expected - leads).toFixed(1)),
  };
});
out.national_rate_per_10k = Number(nationalPer10k.toFixed(2));
out.municipalities = [...muniRows].sort((a, b) => b.population - a.population);
out.biggest_shortfalls = [...muniRows].sort((a, b) => b.shortfall - a.shortfall).slice(0, 20);

/* Per source per municipality, restricted to the pilot set the issue names. */
const PILOT = (
  process.env.FUZZ22_PILOT ?? 'beograd,novi-sad,nis,kragujevac,cacak,kladovo,senta,nova-varos'
).split(',');
out.pilot_municipalities = PILOT;
out.pilot_source_matrix = q(
  `
  SELECT l.municipality_id, ls.source_id, COUNT(DISTINCT l.id) AS leads,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id=l.id AND p.valid=1)
                  THEN 1 ELSE 0 END) AS with_phone
  FROM leads l JOIN lead_sources ls ON ls.lead_id = l.id
  WHERE l.merged_into_id IS NULL AND l.municipality_id IN (${PILOT.map(() => '?').join(',')})
  GROUP BY 1,2 ORDER BY 1,leads DESC
`,
  ...PILOT,
);

/* Every source x every municipality — which sources quietly stop producing
 * outside the big cities. Tier comes from the geo dataset, not from SQL. */
const tierOf = new Map<string, number>(
  units.map((m: Municipality) => [m.id, m.priority_tier as number]),
);
const reachRows = q<{ source_id: string; municipality_id: string; leads: number }>(`
  SELECT ls.source_id, l.municipality_id, COUNT(DISTINCT l.id) AS leads
  FROM lead_sources ls
  JOIN leads l ON l.id = ls.lead_id AND l.merged_into_id IS NULL
  WHERE l.municipality_id IS NOT NULL
  GROUP BY 1,2
`);
const reach = new Map<
  string,
  {
    source_id: string;
    municipalities_reached: number;
    t1: number;
    t2: number;
    t3: number;
    leads_t1: number;
    leads_t2: number;
    leads_t3: number;
  }
>();
for (const row of reachRows) {
  const entry = reach.get(row.source_id) ?? {
    source_id: row.source_id,
    municipalities_reached: 0,
    t1: 0,
    t2: 0,
    t3: 0,
    leads_t1: 0,
    leads_t2: 0,
    leads_t3: 0,
  };
  entry.municipalities_reached += 1;
  const tier = tierOf.get(row.municipality_id);
  if (tier === 1) {
    entry.t1 += 1;
    entry.leads_t1 += row.leads;
  } else if (tier === 2) {
    entry.t2 += 1;
    entry.leads_t2 += row.leads;
  } else if (tier === 3) {
    entry.t3 += 1;
    entry.leads_t3 += row.leads;
  }
  reach.set(row.source_id, entry);
}
out.source_municipality_reach = [...reach.values()].sort(
  (a, b) => b.municipalities_reached - a.municipalities_reached,
);

/* ------------------------------------------------------------- dedupe ---- */
out.merges = {
  merge_log_rows: one<CountRow>(`SELECT COUNT(*) AS n FROM merge_log`).n,
  by_signal: q(
    `SELECT signal AS top_signal, COUNT(*) AS n FROM merge_log GROUP BY 1 ORDER BY n DESC`,
  ),
  merge_candidates_by_status: q(`SELECT status, COUNT(*) AS n FROM merge_candidates GROUP BY 1`),
  review_queue_by_signal: q(
    `SELECT top_signal, COUNT(*) AS n FROM merge_candidates WHERE status='pending' GROUP BY 1 ORDER BY n DESC`,
  ),
};

out.quarantine = {
  identifiers: one<CountRow>(`SELECT COUNT(*) AS n FROM shared_identifiers`).n,
  quarantined: one<CountRow>(`SELECT COUNT(*) AS n FROM shared_identifiers WHERE quarantined=1`).n,
  by_kind: q(`SELECT kind, COUNT(*) AS n FROM shared_identifiers WHERE quarantined=1 GROUP BY 1`),
};

/* --------------------------------------------------------- enrichment ---- */
out.enrichment_suggestions = {
  total: one<CountRow>(`SELECT COUNT(*) AS n FROM enrichment_suggestions`).n,
  by_kind_status: q(
    `SELECT kind, status, COUNT(*) AS n FROM enrichment_suggestions GROUP BY 1,2 ORDER BY n DESC`,
  ),
};

/* ------------------------------------------------------- errors / runs --- */
out.crawl_runs = q(`
  SELECT id, source_id, status, trigger, requests_made, pages_fetched,
         records_emitted, records_rejected, leads_created, leads_updated,
         phones_added, error,
         CAST((COALESCE(finished_at, strftime('%s','now')) - started_at) AS INTEGER) AS seconds
  FROM crawl_runs ORDER BY id
`);

out.raw_records_by_status = q(
  `SELECT source_id, status, COUNT(*) AS n FROM raw_records GROUP BY 1,2 ORDER BY 1`,
);
out.raw_record_validation_errors = q(`
  SELECT source_id, validation_error, COUNT(*) AS n FROM raw_records
  WHERE validation_error IS NOT NULL GROUP BY 1,2 ORDER BY n DESC LIMIT 20
`);

console.log(JSON.stringify(out, null, 2));
db.close();
