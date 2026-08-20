/**
 * The extract, and the cache that means it runs at most once.
 *
 * Overture is a bulk dataset, not a website: 16 GeoParquet parts, 10.4 GB, on
 * public object storage. There is no listing to paginate and no detail page to
 * fetch — there is one predicate pushdown that reads the row groups whose `bbox`
 * statistics overlap Serbia and skips the rest, which is why a national extract
 * costs about 20 seconds and ~15 MB rather than a 10 GB download.
 *
 * That is also why this is the one part of the adapter that does not go through
 * `ctx.http`: the polite fetcher returns decoded text, and a parquet row-group
 * range request is neither text nor something an HTML crawler's shape can
 * express. What the framework guarantees is kept by hand instead, and written
 * down here so it can be checked:
 *
 * - **robots.txt** — the bucket's is a 404, which the framework's own rule
 *   treats as allow-all, and `index.ts` asks `ctx.http.robotsVerdict()` for that
 *   verdict before this module is loaded. The one request that enumerates the
 *   parts goes through `ctx.http` like any other.
 * - **Rate limit** — one query per release, cached to disk, so a re-run and
 *   every subsequent run cost the service nothing at all. DuckDB is held to 4
 *   threads so the scan is a handful of concurrent range requests rather than a
 *   fan-out.
 * - **Retries** — `http_retries` with exponential backoff, DuckDB's own.
 * - **Honest identification** — the project User-Agent, on the parquet requests
 *   too.
 *
 * The DuckDB import is dynamic on purpose: the fixture tests parse a saved
 * extract and must never load a 100 MB native binding to do it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '../../logger.js';
import { partUrl, placesPrefix } from './dataset.js';
import { describeSql, extractSql, REQUIRED_COLUMNS } from './query.js';

/**
 * Where the extract and its manifest live.
 *
 * `data/` is the project's local store, and `OVERTURE_CACHE_DIR` moves it —
 * which is what lets an operator put a 900 KB national extract somewhere shared
 * between machines, and what lets the adapter's own test run the whole
 * discovery path against a seeded cache without DuckDB.
 */
export function cacheRoot(): string {
  return process.env.OVERTURE_CACHE_DIR ?? join(process.cwd(), 'data', 'cache', 'overture-places');
}

export interface CacheManifest {
  readonly release: string;
  /** Hash of the SQL actually run — an edited query invalidates the cache. */
  readonly queryHash: string;
  readonly parts: number;
  readonly rows: number;
  readonly fetchedAt: string;
  readonly durationMs: number;
  readonly bytes: number;
}

export interface ExtractResult {
  readonly rows: readonly unknown[];
  readonly manifest: CacheManifest;
  /** True when the extract came off disk and no request was made. */
  readonly cached: boolean;
}

export function queryHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

export function cachePaths(
  release: string,
  root: string = cacheRoot(),
): { data: string; manifest: string } {
  const dir = join(root, release);
  return { data: join(dir, 'places.ndjson'), manifest: join(dir, 'manifest.json') };
}

async function readManifest(path: string): Promise<CacheManifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CacheManifest;
  } catch {
    return null;
  }
}

function parseNdjson(text: string): readonly unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** What `warehouse` needs from the caller, so the tests can supply all of it. */
export interface ExtractOptions {
  readonly release: string;
  readonly keys: readonly string[];
  readonly log: Logger;
  readonly userAgent: string;
  /** Overridden by the tests so they never write into the project's cache. */
  readonly cacheRoot?: string | undefined;
  /** Injected by the tests; production leaves it out and DuckDB is loaded lazily. */
  readonly runQuery?: QueryRunner | undefined;
}

/** Runs the extract and returns the rows. The only thing DuckDB is used for. */
export type QueryRunner = (input: {
  readonly partUrls: readonly string[];
  readonly userAgent: string;
  readonly log: Logger;
}) => Promise<readonly Record<string, unknown>[]>;

/**
 * Load the extract, running it only if the cache cannot answer.
 *
 * The cache is keyed by release **and** by the hash of the SQL: changing a
 * category or the name pattern must not be answerable from a file that was
 * written under the old one.
 */
export async function loadExtract(options: ExtractOptions): Promise<ExtractResult> {
  const partUrls = options.keys.map(partUrl);
  const sql = extractSql(partUrls);
  const hash = queryHash(sql);
  const paths = cachePaths(options.release, options.cacheRoot ?? cacheRoot());

  const manifest = await readManifest(paths.manifest);
  if (manifest !== null && manifest.queryHash === hash && manifest.release === options.release) {
    const text = await readFile(paths.data, 'utf8');
    const rows = parseNdjson(text);
    options.log.info('extract served from cache — no request made', {
      release: options.release,
      rows: rows.length,
      fetchedAt: manifest.fetchedAt,
      path: paths.data,
    });
    return { rows, manifest, cached: true };
  }

  if (manifest !== null) {
    options.log.info('cached extract is stale; re-running', {
      release: options.release,
      cachedQuery: manifest.queryHash,
      currentQuery: hash,
    });
  }

  const runner = options.runQuery ?? duckdbRunner;
  const startedAt = Date.now();
  const rows = await runner({ partUrls, userAgent: options.userAgent, log: options.log });
  const durationMs = Date.now() - startedAt;

  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const written: CacheManifest = {
    release: options.release,
    queryHash: hash,
    parts: partUrls.length,
    rows: rows.length,
    fetchedAt: new Date(startedAt).toISOString(),
    durationMs,
    bytes: Buffer.byteLength(text, 'utf8'),
  };

  await mkdir(dirname(paths.data), { recursive: true });
  // Written beside the target and renamed: a run killed mid-write leaves the
  // previous extract intact rather than a truncated file that parses.
  await writeFile(`${paths.data}.tmp`, text, 'utf8');
  await rename(`${paths.data}.tmp`, paths.data);
  await writeFile(paths.manifest, `${JSON.stringify(written, null, 2)}\n`, 'utf8');

  options.log.info('extract complete', {
    release: options.release,
    rows: rows.length,
    durationMs,
    parts: partUrls.length,
    path: paths.data,
  });

  return { rows, manifest: written, cached: false };
}

/** Columns the release must still have. Raised by the caller as a structural failure. */
export function missingColumns(present: readonly string[]): readonly string[] {
  const set = new Set(present);
  return REQUIRED_COLUMNS.filter((column) => !set.has(column));
}

/**
 * The DuckDB half. Imported dynamically so that nothing but a real extract ever
 * loads the native binding.
 */
const duckdbRunner: QueryRunner = async ({ partUrls, userAgent, log }) => {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  // The same honest identification the polite fetcher sends, on the parquet
  // range requests too. `custom_user_agent` is appended to DuckDB's own token —
  // and it can only be set at startup, which is why it is here and not below.
  const instance = await DuckDBInstance.create(':memory:', { custom_user_agent: userAgent });
  const connection = await instance.connect();

  try {
    await connection.run(`INSTALL httpfs;
LOAD httpfs;
SET http_retries = 5;
SET http_retry_wait_ms = 500;
SET http_timeout = 120;
SET http_keep_alive = true;
SET enable_http_metadata_cache = true;
SET threads = 4;
SET preserve_insertion_order = false;`);

    // Prove the schema before paying for the scan. Overture renamed
    // `categories.primary` to `taxonomy.primary` once already; the next rename
    // must fail here, loudly, rather than return an honest-looking zero rows.
    const described = await connection.runAndReadAll(describeSql(partUrls));
    const columns = described
      .getRowObjects()
      .map((row) => String(row.column_name ?? ''))
      .filter((name) => name.length > 0);
    const missing = missingColumns(columns);
    if (missing.length > 0) {
      throw new SchemaChangedError(missing, columns);
    }

    log.info('scanning the Overture release', { parts: partUrls.length });
    const result = await connection.runAndReadAll(extractSql(partUrls));
    return result.getRowObjects().map((row) => normalizeValues(row));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
};

/** Raised when the pinned release no longer has the columns the extract reads. */
export class SchemaChangedError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly present: readonly string[],
  ) {
    super(`Overture ${placesPrefix()} is missing ${missing.join(', ')}`);
    this.name = 'SchemaChangedError';
  }
}

/**
 * DuckDB hands back its own value objects — `BigInt` for counts, a list wrapper
 * for `VARCHAR[]`. The cache is plain JSON, and so is what the parser reads, so
 * the conversion happens once, here, at the boundary.
 */
function normalizeValues(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = toJsonValue(value);
  }
  return out;
}

function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value !== null && typeof value === 'object' && 'items' in value) {
    const items = (value as { items: unknown }).items;
    if (Array.isArray(items)) return items.map(toJsonValue);
  }
  return value ?? null;
}
