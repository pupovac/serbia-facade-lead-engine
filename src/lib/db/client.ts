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
  /** Milliseconds a writer waits for the lock. Default `SQLITE_BUSY_TIMEOUT_MS`, then 30 000. */
  readonly busyTimeoutMs?: number;
}

/** How long a writer waits for the write lock before `SQLITE_BUSY` is raised. */
export const DEFAULT_BUSY_TIMEOUT_MS = 30_000;

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
 *
 * The busy timeout was 5 seconds, and the FUZZ-22 pilot lost four records to
 * it: three adapters writing at about one record per second each exceeded it
 * occasionally, and `database is locked` reached the item loop as a failure.
 * Run alone, the same adapter lost zero of 499. Thirty seconds plus the retry
 * ladder in `withWriteRetry` is what lets a nationwide run use its wall-clock
 * without paying for it in completeness.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Db {
  const url = options.url ?? process.env.DATABASE_PATH ?? './data/leads.sqlite';
  const sqlite = new Database(url, options.readonly === true ? { readonly: true } : {});

  if (options.readonly !== true) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma(`busy_timeout = ${busyTimeoutMs(options)}`);
  }
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema }) as Db;
  if (options.migrate !== false && options.readonly !== true) {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }
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

function busyTimeoutMs(options: OpenDatabaseOptions): number {
  const configured = options.busyTimeoutMs ?? Number(process.env.SQLITE_BUSY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BUSY_TIMEOUT_MS;
}

/* -------------------------------------------------------------------------- */
/* Surviving a concurrent writer                                              */
/* -------------------------------------------------------------------------- */

/** How many times a write is retried after the busy timeout has already expired. */
export const WRITE_RETRIES = 4;

/** First backoff step. Doubles each attempt, with jitter, on top of the busy timeout. */
const WRITE_RETRY_BASE_MS = 50;

/** SQLite's own vocabulary for "somebody else holds the write lock". */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT')) {
    return true;
  }
  return /database is locked|database table is locked/i.test(error.message);
}

/**
 * `better-sqlite3` is synchronous, so a backoff has to block the thread. This
 * is the one place in the project that is allowed to.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a write, and try again if another writer had the lock.
 *
 * The busy timeout already makes a writer *wait*; this is what happens after
 * waiting was not enough. The pilot lost four records to that case — the whole
 * item, not just the write — because `database is locked` propagated out of
 * `persistLead` and the item loop counted it as a failed page. A record we
 * already fetched, parsed and validated is far too expensive to throw away over
 * a lock, so the write path retries it.
 *
 * Only a busy error is retried. Anything else — a constraint violation, a type
 * error, a bug — is raised immediately and unchanged, because retrying it would
 * turn a loud failure into a slow one.
 */
export function withWriteRetry<T>(
  write: () => T,
  options: { retries?: number; random?: () => number; sleep?: (ms: number) => void } = {},
): T {
  const retries = options.retries ?? WRITE_RETRIES;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepSync;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return write();
    } catch (error) {
      if (attempt >= retries || !isBusy(error)) throw error;
      // Jitter, because two crawlers that back off in lockstep collide again.
      sleep(Math.round(WRITE_RETRY_BASE_MS * 2 ** attempt * (0.5 + random())));
    }
  }
}
