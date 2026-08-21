#!/usr/bin/env node
/**
 * FUZZ-22 — draw the spot-check sample.
 *
 * 30 leads drawn at random from the active leads, stratified by source so a
 * source that contributed a quarter of the corpus gets roughly a quarter of the
 * sample. The seed is fixed and printed so the same 30 can be redrawn and
 * argued with; the verification itself is done by hand against the source URLs
 * this prints, not by any code here.
 */
import Database from 'better-sqlite3';

const url = process.argv[2] ?? './data/leads.sqlite';
const size = Number(process.argv[3] ?? 30);
const seed = Number(process.argv[4] ?? 22);

const db = new Database(url, { readonly: true });

/** mulberry32 — a fixed-seed PRNG, so the draw is reproducible. */
function rng(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  id: number;
  name: string;
  classification: string;
  municipality_id: string | null;
  city_raw: string | null;
  address: string | null;
  source_id: string;
  source_url: string;
}

const rows = db
  .prepare(
    `SELECT l.id, l.name, l.classification, l.municipality_id, l.city_raw, l.address,
            ls.source_id, ls.source_url
       FROM leads l
       JOIN lead_sources ls ON ls.lead_id = l.id
      WHERE l.merged_into_id IS NULL
      ORDER BY l.id, ls.source_id`,
  )
  .all() as Row[];

/** One entry per lead; a multi-source lead is checked against its first source. */
const byLead = new Map<number, Row>();
for (const row of rows) if (!byLead.has(row.id)) byLead.set(row.id, row);
const leads = [...byLead.values()];

const bySource = new Map<string, Row[]>();
for (const lead of leads) {
  const list = bySource.get(lead.source_id) ?? [];
  list.push(lead);
  bySource.set(lead.source_id, list);
}

const random = rng(seed);
const picked: Row[] = [];
for (const [sourceId, list] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const share = Math.max(1, Math.round((list.length / leads.length) * size));
  const shuffled = [...list].sort(() => random() - 0.5);
  for (const lead of shuffled.slice(0, share)) picked.push(lead);
  if (picked.length >= size) break;
  void sourceId;
}
while (picked.length > size) picked.pop();

console.log(JSON.stringify({ seed, size, drawn: picked.length, sample: picked }, null, 2));
db.close();
