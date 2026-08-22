#!/usr/bin/env node
/**
 * FUZZ-33 — replay the pilot corpus through the current pipeline and measure it.
 *
 * The issue asks for before/after numbers "measured against the pilot database,
 * not asserted", and the only honest way to get them is to run the real code
 * over the real records. `raw_records` in FUZZ-22's attachment holds all 4,468
 * payloads exactly as the adapters emitted them, so the whole ingest half of
 * the pilot can be replayed offline, deterministically, in about a minute — no
 * network, no re-crawl, no chance of the sources having changed underneath.
 *
 * The replay is faithful in the ways that matter:
 *
 * - records are replayed in `raw_records.id` order, which is the order they
 *   were originally written, so the "which lead did this attach to" decisions
 *   happen in the same sequence;
 * - each payload goes through `validateRawLead` → `normalizeRawLead` →
 *   `persistLead`, the same three calls `src/scraper/run.ts` makes;
 * - the dedup sweep runs afterwards, as it did in the pilot.
 *
 * It is *not* faithful about the clock: `first_seen_at` becomes replay time.
 * Nothing measured here depends on it.
 *
 * Usage:
 *   npx tsx scripts/fuzz33-replay.ts [source.sqlite] [--out replay.sqlite] [--no-dedupe]
 *
 * Run it once on `main` and once on this branch and diff the two JSON blocks.
 */
import { existsSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/lib/db/client.js';
import { seedSources } from '../src/lib/db/seed-sources.js';
import { upsertSource } from '../src/lib/db/repo.js';
import { dedupeDatabase } from '../src/lib/dedup/index.js';
import { municipalities } from '../src/lib/geo.js';
import { normalizeRawLead, persistLead, persistRejected } from '../src/scraper/pipeline.js';
import { validateRawLead } from '../src/scraper/raw-lead.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(name);
  return at < 0 ? null : (argv[at + 1] ?? null);
};
const positional = argv.filter((value, index) => {
  if (value.startsWith('--')) return false;
  return !(index > 0 && argv[index - 1] === '--out');
});

const sourcePath = positional[0] ?? './data/leads.sqlite';
const outPath = flag('--out') ?? './tmp/fuzz33-replay.sqlite';
const withDedupe = !argv.includes('--no-dedupe');

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${outPath}${suffix}`)) rmSync(`${outPath}${suffix}`);
}

/* -------------------------------------------------------------------------- */
/* Replay                                                                     */
/* -------------------------------------------------------------------------- */

const origin = new Database(sourcePath, { readonly: true });
const payloads = origin
  .prepare(
    `SELECT id, source_id, source_url, payload, status
       FROM raw_records
      WHERE status = 'normalized'
      ORDER BY id`,
  )
  .all() as { id: number; source_id: string; source_url: string; payload: string }[];

// The pseudo-sources enrichment writes under are not in the registry seed.
const extraSources = origin.prepare(`SELECT id, name, url, category FROM sources`).all() as {
  id: string;
  name: string;
  url: string;
  category: string;
}[];
origin.close();

const db = openDatabase({ url: outPath });
seedSources(db);
for (const source of extraSources) {
  upsertSource(db, { ...source, priority: 'medium', enabled: true });
}

const now = new Date();
let replayed = 0;
let rejected = 0;
for (const row of payloads) {
  const parsed: unknown = JSON.parse(row.payload);
  const result = validateRawLead(parsed, row.source_id);
  if (!result.ok) {
    persistRejected(db, row.source_id, row.source_url, parsed, result.error, now);
    rejected += 1;
    continue;
  }
  const normalized = normalizeRawLead(result.lead, {}, now);
  persistLead(db, result.lead, normalized, { runId: null, now });
  replayed += 1;
  if (replayed % 500 === 0) process.stderr.write(`  ${replayed}/${payloads.length}\n`);
}

const dedupe = withDedupe ? dedupeDatabase(db, { actor: 'fuzz33-replay' }) : null;

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

const sqlite = db.$client;
const scalar = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;

const prefixOf = new Map(municipalities.map((m) => [m.id, m.landline_prefix]));

/**
 * The FUZZ-22 proxy, re-implemented so both halves of the before/after are
 * measured the same way: a valid geographic landline whose area code names a
 * network group the lead's municipality is not in.
 *
 * `scoped` is the number that the branch rule is allowed to move — a phone the
 * record itself said belongs to another location is not a contradiction, it is
 * a labelled branch line.
 */
const phoneRows = sqlite
  .prepare(
    `SELECT l.id, l.municipality_id, p.e164, p.scope
       FROM leads l JOIN lead_phones p ON p.lead_id = l.id
      WHERE l.merged_into_id IS NULL AND p.valid = 1
        AND l.municipality_id IS NOT NULL
        AND p.e164 GLOB '+381[1-3]*'`,
  )
  .all() as { id: number; municipality_id: string; e164: string; scope: string }[];

let checked = 0;
let disagreeing = 0;
let disagreeingBusinessScoped = 0;
const disagreeingLeads = new Set<number>();
const disagreeingBusinessScopedLeads = new Set<number>();
for (const row of phoneRows) {
  const expected = prefixOf.get(row.municipality_id);
  if (expected === undefined) continue;
  const national = `0${row.e164.slice(4)}`;
  const actual = national.startsWith('011') ? '011' : national.slice(0, 3);
  checked += 1;
  if (actual === expected) continue;
  disagreeing += 1;
  disagreeingLeads.add(row.id);
  if (row.scope === 'business') {
    disagreeingBusinessScoped += 1;
    disagreeingBusinessScopedLeads.add(row.id);
  }
}

const report = {
  replay: { records: payloads.length, replayed, rejected },
  leads: {
    total: scalar('SELECT count(*) n FROM leads WHERE merged_into_id IS NULL'),
    withAnyPhone: scalar(
      `SELECT count(DISTINCT l.id) n FROM leads l JOIN lead_phones p ON p.lead_id = l.id
        WHERE l.merged_into_id IS NULL AND p.valid = 1`,
    ),
    tombstones: scalar('SELECT count(*) n FROM leads WHERE merged_into_id IS NOT NULL'),
  },
  phones: {
    rows: scalar('SELECT count(*) n FROM lead_phones'),
    valid: scalar('SELECT count(*) n FROM lead_phones WHERE valid = 1'),
    invalid: scalar('SELECT count(*) n FROM lead_phones WHERE valid = 0'),
    distinctValidE164: scalar('SELECT count(DISTINCT e164) n FROM lead_phones WHERE valid = 1'),
    // Item 2: junk `e164` values — a department label parked in the canonical column.
    labelShapedE164: scalar(
      `SELECT count(*) n FROM lead_phones WHERE valid = 0 AND e164 LIKE '%,%'`,
    ),
    withLabel: scalar('SELECT count(*) n FROM lead_phones WHERE label IS NOT NULL'),
    branchScoped: scalar(`SELECT count(*) n FROM lead_phones WHERE scope = 'branch'`),
  },
  // Item 1: the corpus-wide proxy the issue asks to be reported before and after.
  areaCodeVsMunicipality: {
    landlinesChecked: checked,
    disagreeingPhoneRows: disagreeing,
    disagreeingLeads: disagreeingLeads.size,
    disagreeingAndStillAnIdentity: disagreeingBusinessScoped,
    disagreeingLeadsStillAnIdentity: disagreeingBusinessScopedLeads.size,
  },
  dedupe:
    dedupe === null
      ? null
      : {
          leadsBefore: dedupe.leadsBefore,
          leadsAfter: dedupe.leadsAfter,
          merged: dedupe.merged,
          mergedBySignal: dedupe.mergedBySignal,
          reviewPending: dedupe.reviewPending,
          // A merge re-scopes the survivor's phones, which changes what the
          // next round can match on — so whether the sweep still settles is
          // worth printing rather than assuming.
          rounds: dedupe.rounds,
          roundsExhausted: dedupe.roundsExhausted,
        },
  // The spot-check case, followed end to end.
  srma: sqlite
    .prepare(
      `SELECT l.id, l.name, l.city_id, l.merged_into_id,
              (SELECT count(*) FROM lead_phones p WHERE p.lead_id = l.id AND p.valid = 1) phones,
              (SELECT count(*) FROM lead_phones p
                WHERE p.lead_id = l.id AND p.valid = 1 AND p.scope = 'business') own
         FROM leads l
        WHERE l.name LIKE '%S.R.M.A%' OR l.name LIKE '%rma Group%' OR l.name LIKE '%SRMA%'
        ORDER BY l.id`,
    )
    .all(),
};

console.log(JSON.stringify(report, null, 2));
closeDatabase(db);
