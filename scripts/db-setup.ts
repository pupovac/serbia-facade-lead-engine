#!/usr/bin/env node
/**
 * Create or upgrade the local database, then seed the Stage 1 source registry.
 *
 * `npm run db:setup` — idempotent, safe to run on every checkout and after
 * every migration. It applies pending migrations (opening the database does
 * that) and refreshes `sources` from `research/sources-*.json`.
 */
import { closeDatabase, openDatabase } from '../src/lib/db/client.js';
import { seedSources } from '../src/lib/db/seed-sources.js';
import { sources } from '../src/lib/db/schema.js';

const url = process.argv[2] ?? process.env.DATABASE_PATH ?? './data/leads.sqlite';
const db = openDatabase({ url });

const seeded = seedSources(db);
const rows = db.select().from(sources).all();
const enabled = rows.filter((row) => row.enabled).length;
const high = rows.filter((row) => row.priority === 'high').length;

console.log(`database: ${url}`);
console.log(`migrations: applied`);
console.log(`sources seeded: ${seeded} (${enabled} enabled, ${high} high priority)`);

closeDatabase(db);
