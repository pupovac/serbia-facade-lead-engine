/**
 * Per-host rate limiting.
 *
 * The unit is the host, not the run: two adapters crawling the same directory
 * must not add up to twice the load, and one adapter crawling three hosts has
 * no reason to crawl any of them slower than the others. So a limiter is shared
 * across a run and keyed by host.
 *
 * Requests to one host are **serialized through a queue** rather than merely
 * spaced by a delay. Spacing alone is a check-then-act race: ten callers can
 * all read "last request was 2s ago" in the same tick and all fire. Each host's
 * chain is one promise, so `n` waiting callers leave at `t`, `t+delay`,
 * `t+2·delay`, in the order they arrived.
 *
 * The clock and the sleep are injected. That is what lets the tests assert the
 * real spacing in milliseconds without spending them.
 */

export interface RateLimiterOptions {
  /** Minimum milliseconds between two request starts to the same host. */
  readonly defaultDelayMs: number;
  /** `Date.now`, injected so tests can drive a virtual clock. */
  readonly now?: () => number;
  /** `setTimeout`-based sleep, injected for the same reason. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

interface HostEntry {
  /** Tail of this host's chain; the next caller awaits it. */
  chain: Promise<void>;
  /** `now()` at which the previous request was released. */
  lastStart: number;
  /** Host-specific delay, e.g. a `Crawl-delay` from robots.txt. */
  delayMs: number;
}

export class RateLimiter {
  private readonly hosts = new Map<string, HostEntry>();
  private readonly defaultDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Total milliseconds callers spent waiting. Reported in the run summary. */
  private waitedMs = 0;

  constructor(options: RateLimiterOptions) {
    this.defaultDelayMs = Math.max(0, options.defaultDelayMs);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Raise a host's delay — a `Crawl-delay` directive, or a source README that
   * asks for more room. Only ever raises: robots.txt asking for 5 seconds when
   * we configured 1.5 wins, and asking for 0.1 when we configured 1.5 does not.
   */
  setHostDelay(host: string, delayMs: number): void {
    const entry = this.entry(host);
    entry.delayMs = Math.max(entry.delayMs, delayMs);
  }

  hostDelay(host: string): number {
    return this.entry(host).delayMs;
  }

  totalWaitMs(): number {
    return this.waitedMs;
  }

  /** Wait until this host may be hit again. Resolves in call order. */
  async acquire(host: string): Promise<void> {
    const entry = this.entry(host);
    const release = entry.chain.then(async () => {
      const wait = entry.lastStart + entry.delayMs - this.now();
      if (wait > 0) {
        this.waitedMs += wait;
        await this.sleep(wait);
      }
      entry.lastStart = this.now();
    });
    // The chain must survive a caller that throws, or one failure would wedge
    // the host forever.
    entry.chain = release.catch(() => {});
    return release;
  }

  private entry(host: string): HostEntry {
    const existing = this.hosts.get(host);
    if (existing !== undefined) return existing;
    const created: HostEntry = {
      chain: Promise.resolve(),
      // Not `now() - delay`: the entry can be created by `setHostDelay` before
      // the first request, and a robots.txt asking for 5 seconds would then
      // charge the very first request 4 of them. Nobody has earned a wait yet.
      lastStart: Number.NEGATIVE_INFINITY,
      delayMs: this.defaultDelayMs,
    };
    this.hosts.set(host, created);
    return created;
  }
}
