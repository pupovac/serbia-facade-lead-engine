/**
 * The cache, which is what the acceptance criterion "a re-run costs the service
 * nothing" actually means. The query runner is injected, so these tests never
 * load DuckDB and never touch the network.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../logger.js';
import { cachePaths, loadExtract, type QueryRunner } from './warehouse.js';

const KEYS = ['release/2026-08-19.0/theme=places/type=place/part-00000.parquet'];
const RELEASE = '2026-08-19.0';

let cacheRoot: string;
let calls: number;

const runner = (rows: readonly Record<string, unknown>[]): QueryRunner => {
  return async () => {
    calls += 1;
    return rows;
  };
};

const options = (rows: readonly Record<string, unknown>[]) => ({
  release: RELEASE,
  keys: KEYS,
  log: silentLogger,
  userAgent: 'serbia-facade-lead-engine/0.1 (+mailto:test@example.com)',
  cacheRoot,
  runQuery: runner(rows),
});

beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'overture-cache-'));
  calls = 0;
});

afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true });
});

describe('loadExtract', () => {
  const rows = [
    { id: 'a', name: 'Fasade Jedan' },
    { id: 'b', name: 'Stovarište Dva' },
  ];

  it('runs the query once and writes the extract and its manifest', async () => {
    const first = await loadExtract(options(rows));

    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(first.rows).toEqual(rows);
    expect(first.manifest.rows).toBe(2);
    expect(first.manifest.parts).toBe(1);

    const paths = cachePaths(RELEASE, cacheRoot);
    expect((await readFile(paths.data, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(await readFile(paths.manifest, 'utf8'))).toMatchObject({ release: RELEASE });
  });

  it('answers the second run off disk without touching the service', async () => {
    await loadExtract(options(rows));
    const second = await loadExtract(options(rows));

    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.rows).toEqual(rows);
  });

  it('re-runs when the query changed, because the old file answers a different question', async () => {
    await loadExtract(options(rows));
    const changed = await loadExtract({ ...options(rows), keys: [...KEYS, 'part-00001.parquet'] });

    expect(calls).toBe(2);
    expect(changed.cached).toBe(false);
  });

  it('re-runs for a different release rather than reading last month', async () => {
    await loadExtract(options(rows));
    const next = await loadExtract({ ...options(rows), release: '2026-09-24.0' });

    expect(calls).toBe(2);
    expect(next.manifest.release).toBe('2026-09-24.0');
  });

  it('ignores a manifest it cannot read instead of failing the run', async () => {
    const paths = cachePaths(RELEASE, cacheRoot);
    await loadExtract(options(rows));
    await writeFile(paths.manifest, 'not json', 'utf8');

    expect((await loadExtract(options(rows))).cached).toBe(false);
    expect(calls).toBe(2);
  });
});
