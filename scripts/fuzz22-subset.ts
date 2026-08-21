#!/usr/bin/env node
/**
 * FUZZ-22 — build a shape-preserving subset of the pilot database.
 *
 * Only needed if the full file will not attach. The point is that the review UI
 * has something to render on **every** page, so the subset is chosen by shape
 * rather than by row order: leads from every municipality that produced any,
 * every classification, leads with and without a phone, a non-empty merge
 * review queue, non-empty enrichment suggestions, and some quarantined
 * identifiers. Taking the first N rows would leave the two most interesting
 * pages empty and make a thin dataset look like a broken UI.
 *
 * It copies the schema from the source file and deletes what is not kept, so
 * the result is the same database, only smaller — no hand-written DDL to drift.
 */
import { copyFileSync, rmSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const source = process.argv[2] ?? './data/leads.sqlite';
const target = process.argv[3] ?? './data/leads-subset.sqlite';
const perMunicipality = Number(process.argv[4] ?? 12);

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${target}${suffix}`)) rmSync(`${target}${suffix}`);
}

/** Checkpoint the source first, or the copy misses everything still in the WAL. */
const src = new Database(source);
src.pragma('wal_checkpoint(TRUNCATE)');
src.close();

copyFileSync(source, target);
const db = new Database(target);
db.pragma('foreign_keys = OFF');

const keep = new Set<number>();
const add = (rows: { id: number }[]): void => {
  for (const row of rows) keep.add(row.id);
};

/** Every municipality that produced anything, small ones included. */
add(
  db
    .prepare(
      `SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY COALESCE(municipality_id,'(none)')
           ORDER BY lead_score DESC, id
         ) AS rank
         FROM leads WHERE merged_into_id IS NULL
       ) WHERE rank <= ?`,
    )
    .all(perMunicipality) as { id: number }[],
);

/** Every classification, including UNKNOWN, and both sides of the phone split. */
for (const sql of [
  `SELECT id FROM leads WHERE merged_into_id IS NULL AND classification = ? ORDER BY lead_score DESC LIMIT 40`,
]) {
  for (const label of ['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE', 'BOTH', 'UNKNOWN']) {
    add(db.prepare(sql).all(label) as { id: number }[]);
  }
}
add(
  db
    .prepare(
      `SELECT id FROM leads l WHERE l.merged_into_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id = l.id AND p.valid = 1)
       LIMIT 40`,
    )
    .all() as { id: number }[],
);

/** Every source contributes, or a per-source view renders empty. */
for (const row of db.prepare(`SELECT DISTINCT source_id FROM lead_sources`).all() as {
  source_id: string;
}[]) {
  add(
    db
      .prepare(
        `SELECT l.id FROM leads l JOIN lead_sources ls ON ls.lead_id = l.id
          WHERE ls.source_id = ? AND l.merged_into_id IS NULL
          ORDER BY l.lead_score DESC LIMIT 60`,
      )
      .all(row.source_id) as { id: number }[],
  );
}

/** Both sides of every pending review pair — the queue is useless half-kept. */
for (const row of db
  .prepare(`SELECT lead_a_id, lead_b_id FROM merge_candidates WHERE status = 'pending'`)
  .all() as { lead_a_id: number; lead_b_id: number }[]) {
  keep.add(row.lead_a_id);
  keep.add(row.lead_b_id);
}

/** Every lead carrying an enrichment suggestion. */
add(
  db.prepare(`SELECT DISTINCT lead_id AS id FROM enrichment_suggestions`).all() as { id: number }[],
);

/** Tombstones whose survivor is kept, so merge history still resolves. */
add(
  db
    .prepare(`SELECT id FROM leads WHERE merged_into_id IN (${[...keep].join(',') || '-1'})`)
    .all() as { id: number }[],
);

const ids = [...keep].join(',') || '-1';
const before = db.prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number };

db.exec(`
  DELETE FROM lead_phones            WHERE lead_id NOT IN (${ids});
  DELETE FROM lead_contacts          WHERE lead_id NOT IN (${ids});
  DELETE FROM lead_field_values      WHERE lead_id NOT IN (${ids});
  DELETE FROM lead_sources           WHERE lead_id NOT IN (${ids});
  DELETE FROM enrichment_suggestions WHERE lead_id NOT IN (${ids});
  DELETE FROM merge_candidates       WHERE lead_a_id NOT IN (${ids}) OR lead_b_id NOT IN (${ids});
  DELETE FROM merge_log              WHERE surviving_lead_id NOT IN (${ids}) OR merged_lead_id NOT IN (${ids});
  DELETE FROM raw_records            WHERE lead_id IS NOT NULL AND lead_id NOT IN (${ids});
  DELETE FROM raw_records            WHERE lead_id IS NULL;
  DELETE FROM leads                  WHERE id NOT IN (${ids});
`);

db.pragma('foreign_keys = ON');
const problems = db.pragma('foreign_key_check') as unknown[];
db.exec('VACUUM');

const counts: Record<string, number> = {};
for (const row of db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all() as { name: string }[]) {
  counts[row.name] = (
    db.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).get() as { n: number }
  ).n;
}

console.log(
  JSON.stringify(
    { source, target, leads_before: before.n, foreign_key_problems: problems.length, counts },
    null,
    2,
  ),
);
db.close();
