/**
 * The connection settings that are not decoration.
 *
 * The FUZZ-22 pilot ran three adapters against one SQLite file to save
 * wall-clock and lost four records to `database is locked` — the whole item,
 * fetched and parsed and validated, thrown away over a five-second timeout.
 * These are the two things that stop that happening again.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  IN_MEMORY,
  WRITE_RETRIES,
  closeDatabase,
  openDatabase,
  withWriteRetry,
} from './client.js';

function busyError(message = 'database is locked'): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = 'SQLITE_BUSY';
  return error;
}

describe('busy timeout', () => {
  it('is 30 seconds by default, not the 5 that lost records in the pilot', () => {
    const db = openDatabase({ url: IN_MEMORY });
    try {
      expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(30_000);
      expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      closeDatabase(db);
    }
  });

  it('takes an explicit override, so a long backfill can wait longer still', () => {
    const db = openDatabase({ url: IN_MEMORY, busyTimeoutMs: 60_000 });
    try {
      expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(60_000);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('withWriteRetry', () => {
  const noSleep = { sleep: () => {}, random: () => 0.5 };

  it('returns the value when the write succeeds first time', () => {
    let calls = 0;
    expect(
      withWriteRetry(() => {
        calls += 1;
        return 'written';
      }, noSleep),
    ).toBe('written');
    expect(calls).toBe(1);
  });

  it('retries a busy error and returns the eventual result', () => {
    let calls = 0;
    const result = withWriteRetry(() => {
      calls += 1;
      if (calls < 3) throw busyError();
      return calls;
    }, noSleep);
    expect(result).toBe(3);
  });

  it('recognizes the message even when the driver reports no code', () => {
    let calls = 0;
    withWriteRetry(() => {
      calls += 1;
      if (calls < 2) throw new Error('SQLITE_BUSY: database is locked');
      return null;
    }, noSleep);
    expect(calls).toBe(2);
  });

  it('gives up after the retry budget rather than looping forever', () => {
    let calls = 0;
    expect(() =>
      withWriteRetry(() => {
        calls += 1;
        throw busyError();
      }, noSleep),
    ).toThrow(/database is locked/);
    expect(calls).toBe(WRITE_RETRIES + 1);
  });

  it('raises anything that is not a lock immediately and unchanged', () => {
    let calls = 0;
    expect(() =>
      withWriteRetry(() => {
        calls += 1;
        throw new Error('UNIQUE constraint failed: lead_phones.e164');
      }, noSleep),
    ).toThrow(/UNIQUE constraint/);
    // Retrying a constraint violation would turn a loud failure into a slow one.
    expect(calls).toBe(1);
  });

  it('backs off further each attempt', () => {
    const waits: number[] = [];
    try {
      withWriteRetry(
        () => {
          throw busyError();
        },
        { sleep: (ms) => waits.push(ms), random: () => 0.5 },
      );
    } catch {
      /* expected */
    }
    expect(waits).toHaveLength(WRITE_RETRIES);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits.at(-1)).toBeGreaterThan(waits[0] as number);
  });
});
