#!/usr/bin/env node
/**
 * FUZZ-22 — run the deduplication sweep over the pilot database and report it.
 *
 * The sweep has no CLI of its own because nothing before the pilot needed to
 * run it outside a test. It is one call; what this script adds is printing the
 * numbers the pilot report has to quote — the duplicate rate, the decision
 * distribution, what each merge was decided on, and how big the review queue
 * the review UI will render actually is.
 */
import { closeDatabase, openDatabase } from '../src/lib/db/client.js';
import { dedupeDatabase } from '../src/lib/dedup/index.js';

const url = process.argv[2] ?? process.env.DATABASE_PATH ?? './data/leads.sqlite';
const db = openDatabase({ url });

const stats = dedupeDatabase(db, { actor: 'fuzz22-pilot' });

console.log(JSON.stringify(stats, null, 2));
console.log('');
console.log(`leads ${stats.leadsBefore} -> ${stats.leadsAfter}`);
console.log(`duplicate rate ${(stats.duplicateRate * 100).toFixed(2)}%`);
console.log(`pairs scored ${stats.pairsScored}`);
console.log(`decisions ${JSON.stringify(stats.decisions)}`);
console.log(`merged ${stats.merged} by ${JSON.stringify(stats.mergedBySignal)}`);
console.log(`refused ${JSON.stringify(stats.refused)}`);
console.log(`review queue pending ${stats.reviewPending}`);
console.log(
  `quarantined identifiers ${stats.quarantine.quarantined} ${JSON.stringify(stats.quarantine.byKind)}`,
);
console.log(
  `rounds ${stats.rounds} exhausted=${stats.roundsExhausted} blocksTruncated=${stats.blocksTruncated}`,
);

closeDatabase(db);
