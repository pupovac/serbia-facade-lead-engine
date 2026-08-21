/**
 * The review UI's database handle.
 *
 * One connection for the whole server process, cached across dev-server hot
 * reloads — `better-sqlite3` is synchronous and a new handle per request would
 * re-run the migrator on every navigation.
 *
 * Migrations run on open, which is what makes the three-command local run work:
 * drop the attached file in `data/`, start the dev server, and a database that
 * predates a schema change is brought forward instead of failing halfway
 * through a page render. When it genuinely cannot be used, the error says what
 * to do rather than surfacing a SQLite code.
 *
 * ## Why the migrator is called here rather than by `openDatabase()`
 *
 * `openDatabase({ migrate: true })` resolves `drizzle/` from
 * `new URL('../../../drizzle', import.meta.url)`. That is correct under `tsx`
 * and vitest and wrong under any bundler: webpack rewrites `import.meta.url` to
 * the emitted chunk's location, so the path lands inside `.next/`. So the app
 * opens without migrating and points the migrator at the project root itself.
 * A `process.cwd()` fallback in `src/lib/db/client.ts` would let this file drop
 * back to `openDatabase({ migrate: true })` — see the FUZZ-25 comment.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type Db } from '@/lib/db/client';

const DEFAULT_PATH = './data/leads.sqlite';

const MISSING = (path: string): string =>
  [
    `No lead database at ${path}.`,
    '',
    'The pilot database is attached to FUZZ-22. Download it, then:',
    '',
    '  gunzip -c leads.sqlite.gz > data/leads.sqlite',
    '  npm run dev',
    '',
    'Or point DATABASE_PATH at an existing file.',
  ].join('\n');

const UNUSABLE = (path: string, cause: string): string =>
  [
    `The database at ${path} could not be opened or migrated.`,
    '',
    cause,
    '',
    'If it predates a schema change, run `npm run db:migrate` and start again.',
    'If it is from a different project, point DATABASE_PATH somewhere else.',
  ].join('\n');

declare global {
  var __leadDb: Db | undefined;
}

/**
 * The connection every server component reads through.
 *
 * Throws with an actionable message rather than returning an empty database:
 * `better-sqlite3` creates a file that does not exist, and a UI that silently
 * renders "0 leads" because it opened the wrong path is worse than one that
 * refuses to start.
 */
export function db(): Db {
  if (globalThis.__leadDb) return globalThis.__leadDb;

  const configured = process.env.DATABASE_PATH ?? DEFAULT_PATH;
  const path = resolve(configured);
  if (!existsSync(path)) throw new Error(MISSING(path));

  try {
    const opened = openDatabase({ url: configured, migrate: false });
    const migrationsFolder = join(process.cwd(), 'drizzle');
    if (existsSync(migrationsFolder)) {
      migrate(opened, { migrationsFolder });
    }
    globalThis.__leadDb = opened;
    return opened;
  } catch (error) {
    throw new Error(UNUSABLE(path, error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Whether the XLSX export module has landed.
 *
 * FUZZ-24 is deprioritized, so the export button is wired to this rather than
 * to a promise: if `src/lib/export` is not there, the button says so instead of
 * throwing when a salesperson clicks it. This is a build-time constant on
 * purpose — an import of a module that does not exist would not compile.
 */
export const EXPORT_AVAILABLE = false;
export const EXPORT_ISSUE = 'FUZZ-24';
