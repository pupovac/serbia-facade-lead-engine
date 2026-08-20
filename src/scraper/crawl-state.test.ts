/**
 * Resume points and staleness.
 *
 * This is what makes the second crawl of an 11,000-record directory cost a few
 * hundred requests instead of eleven thousand, so both halves are tested against
 * a real migrated database, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  getCrawlState,
  openTestDatabase,
  startRun,
  upsertSource,
  type Db,
} from '@/lib/db';
import {
  DbCrawlStateStore,
  ITEM_PREFIX,
  MemoryCrawlStateStore,
  SCOPE_PREFIX,
  resumeScope,
  type CrawlStateStore,
  type ScopeState,
} from './crawl-state.js';

const SOURCE = 'primer';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
  upsertSource(db, {
    id: SOURCE,
    name: 'Primer direktorijum',
    url: 'https://primer.rs',
    category: 'directory',
  });
});

afterEach(() => {
  closeDatabase(db);
});

function stores(): Array<[string, () => CrawlStateStore]> {
  return [
    ['DbCrawlStateStore', () => new DbCrawlStateStore(db, SOURCE)],
    ['MemoryCrawlStateStore', () => new MemoryCrawlStateStore()],
  ];
}

describe.each(stores())('%s', (_name, create) => {
  it('reports nothing for a scope that has never run', () => {
    expect(create().getScope('category:fasaderi')).toBeUndefined();
  });

  it('round-trips a cursor so the next run resumes', () => {
    const store = create();
    store.saveScope('category:fasaderi', {
      cursor: '/firme/fasaderi?strana=4',
      status: 'in_progress',
    });

    const scope = store.getScope('category:fasaderi');
    expect(scope?.cursor).toBe('/firme/fasaderi?strana=4');
    expect(scope?.status).toBe('in_progress');
  });

  it('counts every visit, so a scope that keeps failing is visible', () => {
    const store = create();
    store.saveScope('category:fasaderi', { status: 'failed', lastError: 'timeout' });
    store.saveScope('category:fasaderi', { status: 'failed', lastError: 'timeout' });

    const scope = store.getScope('category:fasaderi');
    expect(scope?.attempts).toBe(2);
    expect(scope?.lastError).toBe('timeout');
  });

  it('stamps completion when a scope finishes', () => {
    const store = create();
    const at = new Date('2026-08-20T10:00:00Z');
    store.saveScope('category:fasaderi', { status: 'done', cursor: null, at });

    expect(store.getScope('category:fasaderi')?.completedAt).toEqual(at);
  });

  it('treats an item it has never seen as stale', () => {
    const store = create();

    expect(store.lastScrapedAt('https://primer.rs/firme/x')).toBeNull();
    expect(store.isStale('https://primer.rs/firme/x', WEEK)).toBe(true);
  });

  it('skips an item scraped inside the staleness window', () => {
    const store = create();
    const now = new Date('2026-08-20T10:00:00Z');
    store.markItem('https://primer.rs/firme/x', 'done', null, new Date(now.getTime() - 2 * DAY));

    expect(store.isStale('https://primer.rs/firme/x', WEEK, now)).toBe(false);
    expect(store.isStale('https://primer.rs/firme/x', DAY, now)).toBe(true);
  });

  it('stamps a failed item too, so a broken page is not retried every hour', () => {
    const store = create();
    const now = new Date('2026-08-20T10:00:00Z');
    store.markItem('https://primer.rs/firme/x', 'failed', 'HTTP 500', now);

    expect(store.isStale('https://primer.rs/firme/x', WEEK, now)).toBe(false);
  });
});

describe('DbCrawlStateStore', () => {
  it('namespaces scopes and items so they cannot collide', () => {
    const store = new DbCrawlStateStore(db, SOURCE);
    store.saveScope('fasaderi', { cursor: 'page-2' });
    store.markItem('fasaderi', 'done');

    expect(getCrawlState(db, SOURCE, `${SCOPE_PREFIX}fasaderi`)?.cursor).toBe('page-2');
    expect(getCrawlState(db, SOURCE, `${ITEM_PREFIX}fasaderi`)?.status).toBe('done');
  });

  it('records the run that touched a scope', () => {
    const runId = startRun(db, SOURCE);
    const store = new DbCrawlStateStore(db, SOURCE, runId);
    store.saveScope('fasaderi', { cursor: 'page-2' });

    expect(getCrawlState(db, SOURCE, `${SCOPE_PREFIX}fasaderi`)?.lastRunId).toBe(runId);
  });

  it('survives a process restart — the point of storing it at all', () => {
    new DbCrawlStateStore(db, SOURCE).saveScope('fasaderi', { cursor: 'page-9' });

    // A brand new store object, as the next run would build.
    expect(new DbCrawlStateStore(db, SOURCE).getScope('fasaderi')?.cursor).toBe('page-9');
  });
});

describe('MemoryCrawlStateStore', () => {
  it('can be seeded from a real store, so a dry run resumes where the last real run stopped', () => {
    const persistent = new DbCrawlStateStore(db, SOURCE);
    persistent.saveScope('fasaderi', { cursor: 'page-3', status: 'in_progress' });

    const memory = MemoryCrawlStateStore.seededFrom(persistent, ['fasaderi', 'never-run']);

    expect(memory.getScope('fasaderi')?.cursor).toBe('page-3');
    expect(memory.getScope('never-run')).toBeUndefined();
  });

  it('writes nothing to the database', () => {
    const memory = new MemoryCrawlStateStore();
    memory.saveScope('fasaderi', { cursor: 'page-3' });
    memory.markItem('https://primer.rs/firme/x', 'done');

    expect(getCrawlState(db, SOURCE, `${SCOPE_PREFIX}fasaderi`)).toBeUndefined();
    expect(getCrawlState(db, SOURCE, `${ITEM_PREFIX}https://primer.rs/firme/x`)).toBeUndefined();
  });
});

describe('resumeScope', () => {
  const NOW = new Date('2026-08-20T10:00:00Z');
  const FRESH = { rediscoverAfterMs: DAY, since: null };

  function scope(overrides: Partial<ScopeState> = {}): ScopeState {
    return {
      cursor: null,
      status: 'done',
      attempts: 1,
      lastError: null,
      lastSeenAt: NOW,
      completedAt: NOW,
      ...overrides,
    };
  }

  it('starts at the beginning when the scope has never run', () => {
    expect(resumeScope(undefined, FRESH, NOW)).toEqual({ skip: false, cursor: null });
  });

  it('resumes an interrupted crawl from its cursor', () => {
    const interrupted = scope({ status: 'in_progress', cursor: '/firme/fasaderi?strana=4' });

    expect(resumeScope(interrupted, FRESH, NOW)).toEqual({
      skip: false,
      cursor: '/firme/fasaderi?strana=4',
    });
  });

  it('resumes a failed scope rather than abandoning it', () => {
    const failed = scope({ status: 'failed', cursor: '/firme/fasaderi?strana=2' });

    expect(resumeScope(failed, FRESH, NOW).skip).toBe(false);
  });

  it('leaves a freshly completed scope alone', () => {
    const justFinished = scope({ completedAt: new Date(NOW.getTime() - 60_000) });

    expect(resumeScope(justFinished, FRESH, NOW)).toEqual({ skip: true, cursor: null });
  });

  it('re-walks a completed scope from the beginning once it goes stale', () => {
    // Not from the saved cursor: the point of re-walking a listing is the
    // entries that were not on it last time, and those are on page one.
    const old = scope({ completedAt: new Date(NOW.getTime() - 3 * DAY), cursor: 'page-9' });

    expect(resumeScope(old, FRESH, NOW)).toEqual({ skip: false, cursor: null });
  });

  it('lets --since override the rolling window in both directions', () => {
    const yesterday = scope({ completedAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000) });

    // Fresh by the window, stale by an explicit --since.
    expect(resumeScope(yesterday, { rediscoverAfterMs: DAY, since: NOW }, NOW).skip).toBe(false);
    // Stale by the window, fresh by an explicit --since.
    const old = scope({ completedAt: new Date(NOW.getTime() - 3 * DAY) });
    const since = new Date(NOW.getTime() - 30 * DAY);
    expect(resumeScope(old, { rediscoverAfterMs: DAY, since }, NOW).skip).toBe(true);
  });

  it('falls back to lastSeenAt when a done scope never recorded completedAt', () => {
    const noStamp = scope({ completedAt: null, lastSeenAt: new Date(NOW.getTime() - 3 * DAY) });

    expect(resumeScope(noStamp, FRESH, NOW).skip).toBe(false);
  });
});
