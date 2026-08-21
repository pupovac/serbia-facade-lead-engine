/**
 * Re-classify and re-score every lead in a database, and report what changed.
 *
 * Migration `0004_relevance_and_scope` deliberately leaves `relevance_score`,
 * `contactability_score` and `lead_score` at 0: the old `lead_score` was 66%
 * contact completeness on a scale that no longer exists, and carrying it into
 * a column that now means `relevance × contactability / 100` would be a number
 * nobody could read and everybody would trust. This script is how the columns
 * get filled.
 *
 *   npx tsx scripts/fuzz37-regrade.ts data/leads.sqlite
 *   npx tsx scripts/fuzz37-regrade.ts data/leads.sqlite --dry-run
 *   npx tsx scripts/fuzz37-regrade.ts data/leads.sqlite --baseline data/pre-0004.sqlite
 *
 * `--dry-run` computes and prints everything and writes nothing.
 *
 * `--baseline <path>` reads the *old* `classification` and `lead_score` out of
 * an un-migrated copy, opened read-only so it is never touched. It is the only
 * way to report a real before/after: opening the target database applies
 * migration 0004, which zeroes the three score columns by design, so by the
 * time this script can run the old ranking is already gone. This is what
 * produced the numbers in the FUZZ-37 issue comment.
 */
import Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/lib/db/client.js';
import { regradeLead } from '../src/lib/dedup/regrade.js';
import { classifyLead, decidingNet } from '../src/lib/classify/index.js';
import { scoreLead, toScoreInput } from '../src/lib/score/index.js';
import {
  distinctPhones,
  leadCategories,
  leadContactClaims,
  leadSourceRows,
} from '../src/lib/db/repo.js';
import { leads, type Lead, type LeadClassification } from '../src/lib/db/schema.js';
import { isNull } from 'drizzle-orm';

const path = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const baselineFlag = process.argv.indexOf('--baseline');
const baselinePath = baselineFlag === -1 ? undefined : process.argv[baselineFlag + 1];
if (path === undefined || path.startsWith('--')) {
  console.error(
    'usage: tsx scripts/fuzz37-regrade.ts <db-path> [--dry-run] [--baseline <pre-migration-db>]',
  );
  process.exit(1);
}

/** `id → (classification, lead_score)` as they stood before migration 0004. */
const baseline = new Map<number, { classification: string; leadScore: number }>();
if (baselinePath !== undefined) {
  // Raw better-sqlite3, not Drizzle: the point of this file is that its schema
  // is the *old* one, so the generated column list would not match it.
  const source = new Database(baselinePath, { readonly: true });
  for (const row of source
    .prepare('select id, classification, lead_score from leads where merged_into_id is null')
    .all() as { id: number; classification: string; lead_score: number }[]) {
    baseline.set(row.id, { classification: row.classification, leadScore: row.lead_score });
  }
  source.close();
  console.log(`Baseline: ${baseline.size} leads read from ${baselinePath}\n`);
}

const db = openDatabase({ url: path });
const now = new Date();

/** Every lead that is not a merge tombstone. A tombstone is reachable, never listed. */
const active: Lead[] = db.select().from(leads).where(isNull(leads.mergedIntoId)).all();

interface Row {
  readonly lead: Lead;
  /** The stored label. From `--baseline` when given — migration 0004 rewrites `UNKNOWN`. */
  readonly before: string;
  readonly after: LeadClassification;
  readonly industry: string | null;
  readonly relevance: number;
  readonly contactability: number;
  readonly leadScore: number;
  /** The old single score, from `--baseline`. 0 when no baseline was given. */
  readonly oldScore: number;
}

const priorFor = (lead: Lead): { classification: string; leadScore: number } =>
  baseline.get(lead.id) ?? { classification: lead.classification, leadScore: lead.leadScore };

const rows: Row[] = [];
for (const lead of active) {
  if (dryRun) {
    const contacts = leadContactClaims(db, lead.id);
    const website = contacts.find((c) => c.kind === 'website');
    const categories = leadCategories(db, lead.id);
    const classification = classifyLead({
      name: lead.name,
      ...(lead.description == null ? {} : { description: lead.description }),
      ...(categories.length === 0 ? {} : { categories }),
      ...(website == null ? {} : { website: website.value }),
    });
    const score = scoreLead({
      ...toScoreInput({
        lead,
        phones: distinctPhones(db, lead.id),
        contacts,
        sources: leadSourceRows(db, lead.id),
        now,
      }),
      classification: {
        label: classification.label,
        confidence: classification.confidence,
        evidenceNet: decidingNet(classification),
      },
    });
    const prior = priorFor(lead);
    rows.push({
      lead,
      before: prior.classification,
      after: classification.label,
      industry: classification.industry ?? null,
      relevance: score.relevance,
      contactability: score.contactability,
      leadScore: score.score,
      oldScore: prior.leadScore,
    });
    continue;
  }

  const prior = priorFor(lead);
  const result = regradeLead(db, lead.id, now);
  if (result === undefined) continue;
  rows.push({
    lead,
    before: prior.classification,
    after: result.classification,
    industry: result.classificationIndustry,
    relevance: result.relevanceScore,
    contactability: result.contactabilityScore,
    leadScore: result.leadScore,
    oldScore: prior.leadScore,
  });
}

/* -------------------------------------------------------------------------- */

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const num = (s: string | number, n: number): string => String(s).padStart(n);

function tally<T extends string>(values: readonly T[]): [T, number][] {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

console.log(`${dryRun ? 'DRY RUN — nothing written' : 'Re-graded'}: ${rows.length} active leads\n`);

console.log('Label distribution');
console.log(`  ${pad('label', 30)}${num('before', 8)}${num('after', 8)}`);
const labels = new Set<string>([...rows.map((r) => r.before), ...rows.map((r) => r.after)]);
const before = new Map(tally(rows.map((r) => r.before)));
const after = new Map(tally<string>(rows.map((r) => r.after)));
for (const label of [...labels].sort()) {
  console.log(
    `  ${pad(label, 30)}${num(before.get(label) ?? 0, 8)}${num(after.get(label) ?? 0, 8)}`,
  );
}

const changed = rows.filter((r) => r.before !== r.after);
console.log(`\nLeads whose label changed: ${changed.length}`);
for (const [transition, count] of tally(changed.map((r) => `${r.before} → ${r.after}`))) {
  console.log(`  ${pad(transition, 50)}${num(count, 6)}`);
}

const outOfScope = rows.filter((r) => r.after === 'OUT_OF_SCOPE');
if (outOfScope.length > 0) {
  console.log(`\nOUT_OF_SCOPE by deciding industry (${outOfScope.length} leads)`);
  for (const [industry, count] of tally(outOfScope.map((r) => r.industry ?? 'unrecorded'))) {
    console.log(`  ${pad(industry, 30)}${num(count, 6)}`);
  }
}

/* -------------------------------------------------------------------------- */

function mix(sorted: readonly Row[], n: number, key: string, which: 'before' | 'after'): void {
  const top = sorted.slice(0, n);
  console.log(`\nTop ${top.length} by ${key} — labels ${which} the change`);
  for (const [label, count] of tally(top.map((r) => (which === 'before' ? r.before : r.after)))) {
    console.log(
      `  ${pad(label, 30)}${num(count, 6)}  ${num(((count / top.length) * 100).toFixed(1), 6)}%`,
    );
  }
}

// The band the owner actually browses. Before FUZZ-37 the list defaulted to
// `sort=score desc` with no type filter and 32% of these rows were UNKNOWN.
const byOldScore = [...rows].sort((a, b) => b.oldScore - a.oldScore || a.lead.id - b.lead.id);
mix(byOldScore, 200, 'the OLD lead_score', 'before');
mix(byOldScore, 200, 'the OLD lead_score', 'after');
mix(
  [...rows].sort(
    (a, b) =>
      b.relevance - a.relevance || b.contactability - a.contactability || a.lead.id - b.lead.id,
  ),
  200,
  'relevance_score',
  'after',
);
mix(
  [...rows].sort((a, b) => b.leadScore - a.leadScore || a.lead.id - b.lead.id),
  200,
  'the NEW derived lead_score',
  'after',
);

/* -------------------------------------------------------------------------- */

const inScope = rows.filter((r) => r.after !== 'UNCLASSIFIED' && r.after !== 'OUT_OF_SCOPE');
const undecided = rows.filter((r) => r.after === 'UNCLASSIFIED' || r.after === 'OUT_OF_SCOPE');
const mean = (values: readonly number[]): string =>
  values.length === 0 ? '—' : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);

console.log('\nMean scores');
console.log(
  `  ${pad('', 30)}${num('relevance', 12)}${num('contactability', 16)}${num('lead_score', 12)}`,
);
console.log(
  `  ${pad(`in scope (${inScope.length})`, 30)}${num(mean(inScope.map((r) => r.relevance)), 12)}${num(mean(inScope.map((r) => r.contactability)), 16)}${num(mean(inScope.map((r) => r.leadScore)), 12)}`,
);
console.log(
  `  ${pad(`not a lead (${undecided.length})`, 30)}${num(mean(undecided.map((r) => r.relevance)), 12)}${num(mean(undecided.map((r) => r.contactability)), 16)}${num(mean(undecided.map((r) => r.leadScore)), 12)}`,
);

/* -------------------------------------------------------------------------- */

const WATCH = [3422, 2808, 262, 2840, 3457, 3616, 257, 1931, 2532, 630, 1611];
const byId = new Map(rows.map((r) => [r.lead.id, r]));
console.log('\nThe leads the issue names');
console.log(
  `  ${pad('id', 6)}${pad('name', 26)}${pad('before', 30)}${pad('after', 30)}${num('rel', 5)}${num('cont', 6)}`,
);
for (const id of WATCH) {
  const row = byId.get(id);
  if (row === undefined) {
    console.log(`  ${pad(id, 6)}(not in this database)`);
    continue;
  }
  console.log(
    `  ${pad(id, 6)}${pad(row.lead.name.slice(0, 24), 26)}${pad(row.before, 30)}${pad(row.after + (row.industry === null ? '' : ` (${row.industry})`), 30)}${num(row.relevance, 5)}${num(row.contactability, 6)}`,
  );
}

closeDatabase(db);
