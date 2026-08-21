#!/usr/bin/env node
/**
 * FUZZ-22 — does a lead's landline agree with the municipality it is filed under?
 *
 * The spot check found a lead carrying four other branches' phone numbers, and
 * "how often does that happen" is not answerable by looking at more leads by
 * hand. Serbian landline area codes are geographic, and `data/serbia-geo.json`
 * records one per municipality, so a landline whose area code contradicts the
 * lead's municipality is a cheap corpus-wide proxy for the defect.
 *
 * It is a proxy, not a count of errors: a Belgrade head office may legitimately
 * publish a regional branch's number. Read the result as an upper bound.
 */
import Database from 'better-sqlite3';
import { municipalities } from '../src/lib/geo.js';

const url = process.argv[2] ?? './data/leads.sqlite';
const prefixOf = new Map(municipalities.map((m) => [m.id, m.landline_prefix]));

const db = new Database(url, { readonly: true });
const rows = db
  .prepare(
    `SELECT l.id, l.name, l.municipality_id, p.e164
       FROM leads l JOIN lead_phones p ON p.lead_id = l.id
      WHERE l.merged_into_id IS NULL AND p.valid = 1
        AND l.municipality_id IS NOT NULL
        AND p.e164 GLOB '+381[1-3]*'`,
  )
  .all() as { id: number; name: string; municipality_id: string; e164: string }[];

let checked = 0;
const offenders = new Map<number, (typeof rows)[number]>();
for (const row of rows) {
  const expected = prefixOf.get(row.municipality_id);
  if (expected === undefined) continue;
  const national = `0${row.e164.slice(4)}`;
  // Belgrade is the only three-digit code that is also a prefix of others.
  const actual = national.startsWith('011') ? '011' : national.slice(0, 3);
  checked += 1;
  if (actual !== expected) offenders.set(row.id, row);
}

console.log(
  `landline phones checked ${checked}, area code disagrees with municipality: ` +
    `${offenders.size} (${((offenders.size / checked) * 100).toFixed(1)}%)`,
);
for (const row of [...offenders.values()].slice(0, 15)) {
  console.log(
    `  ${row.id} ${row.name} — filed under ${row.municipality_id} ` +
      `(${prefixOf.get(row.municipality_id)}), phone ${row.e164}`,
  );
}
db.close();
