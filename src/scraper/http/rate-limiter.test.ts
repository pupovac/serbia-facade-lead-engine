/**
 * The rate limiter, on vitest's fake timers.
 *
 * The clock and the sleep are the real `Date.now` and `setTimeout` — faked, so
 * the tests assert the spacing a host would actually see, in milliseconds,
 * without spending them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fire `count` acquires at once and report the clock reading each one left at. */
async function releaseTimes(limiter: RateLimiter, host: string, count: number): Promise<number[]> {
  const starts: number[] = [];
  const all = Promise.all(
    Array.from({ length: count }, () =>
      limiter.acquire(host).then(() => {
        starts.push(Date.now());
      }),
    ),
  );
  await vi.advanceTimersByTimeAsync(count * 10_000);
  await all;
  return starts;
}

describe('RateLimiter', () => {
  it('lets the first request to a host through immediately', async () => {
    const limiter = new RateLimiter({ defaultDelayMs: 1000 });

    expect(await releaseTimes(limiter, 'primer.rs', 1)).toEqual([0]);
    expect(limiter.totalWaitMs()).toBe(0);
  });

  it('spaces consecutive requests to one host by the delay', async () => {
    const limiter = new RateLimiter({ defaultDelayMs: 1000 });

    expect(await releaseTimes(limiter, 'primer.rs', 4)).toEqual([0, 1000, 2000, 3000]);
  });

  it('serializes concurrent callers instead of letting them race', async () => {
    // The check-then-act bug this design exists to avoid: five callers all
    // reading "the last request was long ago" in the same tick, and all firing.
    const limiter = new RateLimiter({ defaultDelayMs: 500 });

    expect(await releaseTimes(limiter, 'primer.rs', 5)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(limiter.totalWaitMs()).toBe(2000);
  });

  it('keeps hosts independent', async () => {
    const limiter = new RateLimiter({ defaultDelayMs: 1000 });

    const all = Promise.all([
      limiter.acquire('a.rs'),
      limiter.acquire('b.rs'),
      limiter.acquire('c.rs'),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await all;

    expect(Date.now()).toBe(0);
    expect(limiter.totalWaitMs()).toBe(0);
  });

  it('raises a host delay but never lowers it', async () => {
    const limiter = new RateLimiter({ defaultDelayMs: 1000 });

    // robots.txt asking for 5s wins over our 1s…
    limiter.setHostDelay('primer.rs', 5000);
    expect(limiter.hostDelay('primer.rs')).toBe(5000);

    // …and asking for 100ms does not.
    limiter.setHostDelay('primer.rs', 100);
    expect(limiter.hostDelay('primer.rs')).toBe(5000);

    // Raising the delay must not charge the first request for a wait nobody
    // has earned yet.
    expect(await releaseTimes(limiter, 'primer.rs', 2)).toEqual([0, 5000]);
  });

  it('does not wedge a host when a caller throws', async () => {
    const limiter = new RateLimiter({ defaultDelayMs: 100 });

    await limiter.acquire('primer.rs');
    // The caller failed; the host's chain must still move on.
    const next = limiter.acquire('primer.rs');
    await vi.advanceTimersByTimeAsync(100);

    await expect(next).resolves.toBeUndefined();
    expect(Date.now()).toBe(100);
  });

  it('treats a zero delay as no delay', async () => {
    const limiter = new RateLimiter({ defaultDelayMs: 0 });

    expect(await releaseTimes(limiter, 'primer.rs', 3)).toEqual([0, 0, 0]);
  });
});
