#!/usr/bin/env node
/**
 * Re-classify a stored corpus with the current signal table, and report what
 * moved.
 *
 * The point of the script is measurement on a *fixed* corpus: a signal change
 * is worth what it moves on real leads, and the only way to know that without
 * re-crawling is to run the classifier again over what is already in the
 * database.
 *
 * ```
 * npx tsx scripts/reclassify.ts                       # dry run, prints the table
 * npx tsx scripts/reclassify.ts --json out.json       # + the full per-lead result
 * npx tsx scripts/reclassify.ts --apply               # write the new labels and re-score
 * npx tsx scripts/reclassify.ts --db ./data/leads.sqlite
 * ```
 *
 * Dry run by default: it opens the database read-only unless `--apply` is
 * given, so there is no way to change 3,600 labels by mistyping a flag.
 * `--apply` writes through `regradeLead`, which re-computes the lead score from
 * the new label rather than letting the two drift apart.
 */
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../src/lib/db/client.js';
import { reclassifyCorpus, type ReclassifiedLead } from '../src/lib/classify/reclassify.js';
import { regradeLead } from '../src/lib/dedup/regrade.js';
import type { LeadClassification } from '../src/lib/classify/types.js';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const url = value('--db') ?? process.env.DATABASE_PATH ?? './data/leads.sqlite';
const apply = flag('--apply');
const jsonPath = value('--json');

const db = openDatabase({ url, migrate: apply, readonly: !apply });
const report = reclassifyCorpus(db);

const LABELS: readonly LeadClassification[] = [
  'FACADE_CONTRACTOR',
  'CONSTRUCTION_MATERIAL_STORE',
  'BOTH',
  'UNKNOWN',
];

const pct = (n: number): string => `${((100 * n) / Math.max(1, report.total)).toFixed(1)}%`;

console.log(`corpus: ${url}`);
console.log(`active leads: ${report.total}\n`);
console.log('label                        before    after     delta');
for (const label of LABELS) {
  const b = report.before[label];
  const a = report.after[label];
  const delta = a - b;
  console.log(
    `${label.padEnd(28)} ${String(b).padStart(5)}  ${String(a).padStart(7)} (${pct(a)})  ${delta >= 0 ? '+' : ''}${delta}`,
  );
}

console.log(`\nchanged: ${report.changed.length}`);
for (const [transition, count] of Object.entries(report.transitions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${transition.padEnd(56)} ${count}`);
}

if (jsonPath !== undefined) {
  const slim = (lead: ReclassifiedLead): Record<string, unknown> => ({
    leadId: lead.leadId,
    name: lead.name,
    before: lead.before,
    after: lead.after,
    confidence: lead.result.confidence,
    contractorNet: lead.result.contractor.net,
    storeNet: lead.result.store.net,
    reason: lead.result.reason,
    evidence: lead.result.evidence.map((e) => `${e.signalId}@${e.field}:${e.matched}=${e.weight}`),
  });
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        corpus: url,
        total: report.total,
        before: report.before,
        after: report.after,
        transitions: report.transitions,
        leads: report.all.map(slim),
      },
      null,
      1,
    )}\n`,
  );
  console.log(`\nwrote ${jsonPath}`);
}

if (apply) {
  // Only the leads whose label moved. Re-grading the whole corpus would also
  // re-score every unchanged lead, and `toScoreInput` discounts a city read
  // back from the database (`PERSISTED_CITY_CONFIDENCE`) — so a pure
  // classification run would quietly deflate 3,600 scores it has nothing to
  // say about. A lead whose classification did not change did not change.
  const at = new Date();
  let written = 0;
  for (const lead of report.changed) {
    if (regradeLead(db, lead.leadId, at) !== undefined) written += 1;
  }
  console.log(`\napplied: re-graded ${written} leads whose label moved`);
} else {
  console.log('\ndry run — pass --apply to write these labels back');
}
