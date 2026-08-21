/**
 * The database connection.
 *
 * The only file in `src/lib` that touches the filesystem and the only one that
 * knows the driver is `better-sqlite3`. Everything else — the repository, the
 * scraper, the API routes — takes a `Db` and never constructs one, which is
 * what keeps the eventual Postgres swap to this file plus `schema.ts`.
 *
 * `better-sqlite3` is a native module and must never reach a client component:
 * it is declared in `serverExternalPackages` in `next.config.ts`.
 */
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** `drizzle/`, resolved from this file so it works from the CLI, vitest and Next alike. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/** The in-memory URL. Tests use it; nothing else should. */
export const IN_MEMORY = ':memory:';

export interface OpenDatabaseOptions {
  /** SQLite file path, or `':memory:'`. Defaults to `DATABASE_PATH`, then `./data/leads.sqlite`. */
  readonly url?: string;
  /** Apply pending migrations on open. Default `true` — the schema is never hand-applied. */
  readonly migrate?: boolean;
  /** Open read-only. The review UI's read paths can use this; the scraper cannot. */
  readonly readonly?: boolean;
}

/**
 * Open a connection and bring it up to the current migration.
 *
 * The PRAGMAs below are the one deliberate piece of SQLite-only SQL in the
 * project, and they are connection setup rather than query text: WAL so the
 * Next.js reader is not blocked by the scraper's writes, `foreign_keys` because
 * SQLite leaves referential integrity off by default and every cascade in the
 * schema depends on it, and a busy timeout so a concurrent writer waits instead
 * of throwing `SQLITE_BUSY`. Postgres needs none of them; that is the whole
 * reason they live here and not in a repository function.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Db {
  const url = options.url ?? process.env.DATABASE_PATH ?? './data/leads.sqlite';
  const sqlite = new Database(url, options.readonly === true ? { readonly: true } : {});

  if (options.readonly !== true) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
  }
  const db = drizzle(sqlite, { schema }) as Db;
  if (options.migrate !== false && options.readonly !== true) {
    // A migration that changes a CHECK constraint has to rebuild the table —
    // SQLite cannot alter one in place — and SQLite's own recipe for that is
    // "turn foreign keys off, rebuild, turn them back on, then check". The
    // `PRAGMA foreign_keys=OFF` drizzle writes into the migration file cannot
    // do it: the migrator runs inside a transaction and the pragma is a no-op
    // there. So it happens here, around the whole run, and
    // `foreign_key_check` afterwards makes sure the rebuild kept every
    // reference — a silently orphaned `lead_phones` row is a lost phone
    // number, which is the one thing this project cannot afford.
    sqlite.pragma('foreign_keys = OFF');
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    const violations = sqlite.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `migration left ${violations.length} dangling foreign key reference(s): ${JSON.stringify(violations.slice(0, 5))}`,
      );
    }
  }
  sqlite.pragma('foreign_keys = ON');
  return db;
}

/**
 * A migrated, empty, in-memory database. The unit tests run against this, which
 * is also the check that the generated migration applies cleanly to an empty
 * database — if it stops doing so, every test in `src/lib/db` fails at setup.
 */
export function openTestDatabase(): Db {
  return openDatabase({ url: IN_MEMORY, migrate: true });
}

/** Close the underlying connection. Safe to call twice. */
export function closeDatabase(db: Db): void {
  if (db.$client.open) db.$client.close();
}
