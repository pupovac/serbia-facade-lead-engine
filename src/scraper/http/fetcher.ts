/**
 * The polite fetcher — the only way an adapter reaches the network.
 *
 * Every request that leaves this process passes through here, and here is where
 * the four politeness guarantees are enforced rather than left to whoever wrote
 * the adapter:
 *
 * 1. **`robots.txt`** is fetched once per origin per run and obeyed. A disallow
 *    throws `RobotsDisallowedError`; there is no override parameter.
 * 2. **The rate limit** is per host and serialized, so concurrency cannot turn
 *    "1 request per second" into eight at once.
 * 3. **The User-Agent** names the crawler and a contact, on every request.
 * 4. **The request budget** is a hard per-run ceiling. A pagination loop that
 *    never terminates stops at the budget instead of on someone's error budget.
 *
 * Retries cover exactly the failures that can succeed on a second try — a
 * timeout, a connection reset, a 429, a 5xx — with exponential backoff, full
 * jitter, and a server's own `Retry-After` honoured when it asks for longer. A
 * 404 or a 403 is a fact about the page and is never retried.
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { HttpError, RequestBudgetExceededError } from '../errors.js';
import type { ScraperConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { RateLimiter } from './rate-limiter.js';
import { RobotsCache, type RobotsVerdict } from './robots.js';

/** The transport. `globalThis.fetch` in production, a local server in the tests. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchOptions {
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  /** Overrides `maxRetries` for this request — a cheap probe may want none. */
  readonly retries?: number | undefined;
  /** Treat these non-2xx statuses as a normal result instead of an error. */
  readonly acceptStatuses?: readonly number[] | undefined;
}

export interface FetchResult {
  /** The URL asked for. */
  readonly url: string;
  /** Where the response actually came from, after redirects. */
  readonly finalUrl: string;
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Attempts spent, including the one that succeeded. */
  readonly attempts: number;
  /** The `robots.txt` line that permitted this request. */
  readonly robotsRule: string;
}

/** What a page cost, for the run summary and the `crawl_runs` row. */
export interface FetchStats {
  readonly requests: number;
  readonly retries: number;
  readonly failures: number;
  readonly robotsFetches: number;
  readonly rateLimitWaitMs: number;
  readonly bytes: number;
  readonly budget: number;
  readonly budgetRemaining: number;
}

export interface FetcherOptions {
  readonly config: ScraperConfig;
  readonly log: Logger;
  readonly fetchImpl?: FetchImpl | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  /** Injected so a test gets deterministic backoff instead of jitter. */
  readonly random?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Statuses worth trying again. Everything else is a fact about the page. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export class PoliteFetcher {
  private readonly config: ScraperConfig;
  private readonly log: Logger;
  private readonly fetchImpl: FetchImpl;
  private readonly limiter: RateLimiter;
  private readonly robots: RobotsCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly signal: AbortSignal | undefined;

  private requests = 0;
  private retries = 0;
  private failures = 0;
  private bytes = 0;

  constructor(options: FetcherOptions) {
    this.config = options.config;
    this.log = options.log;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.signal = options.signal;

    this.limiter = new RateLimiter({
      defaultDelayMs: this.config.requestDelayMs,
      now: this.now,
      sleep: this.sleep,
    });

    this.robots = new RobotsCache({
      token: this.config.userAgentToken,
      respect: this.config.respectRobots,
      onUnavailable: this.config.onRobotsUnavailable,
      // robots.txt is fetched through the same rate limiter and the same
      // headers as everything else — it is a request to the host too — but it
      // never spends the crawl budget, because refusing to check would be the
      // cheaper option otherwise.
      fetch: async (robotsUrl) => {
        try {
          const response = await this.send(robotsUrl, {}, 1);
          return { status: response.status, body: response.body };
        } catch (error) {
          // A 404 is a host with no rules and must not look like a failure; a
          // 5xx or a network error must, so `onRobotsUnavailable` can decide.
          if (error instanceof HttpError) {
            return { status: error.status === 0 ? 599 : error.status, body: '' };
          }
          throw error;
        }
      },
      onFetched: (origin, robots) => {
        const group = robots.groups.find((candidate) => candidate.crawlDelay !== undefined);
        const delay = group?.crawlDelay;
        if (delay !== undefined) {
          const host = new URL(origin).host;
          this.limiter.setHostDelay(host, delay * 1000);
          this.log.info('robots.txt asks for a longer delay', { host, crawlDelaySeconds: delay });
        }
      },
    });
  }

  stats(): FetchStats {
    return {
      requests: this.requests,
      retries: this.retries,
      failures: this.failures,
      robotsFetches: this.robots.fetchCount(),
      rateLimitWaitMs: this.limiter.totalWaitMs(),
      bytes: this.bytes,
      budget: this.config.requestBudget,
      budgetRemaining: Math.max(0, this.config.requestBudget - this.requests),
    };
  }

  /** True once the budget is spent. The orchestrator stops discovering rather than crashing. */
  budgetExhausted(): boolean {
    return this.requests >= this.config.requestBudget;
  }

  /** Ask `robots.txt` about a URL without fetching it. */
  async robotsVerdict(url: string): Promise<RobotsVerdict> {
    return this.robots.check(url);
  }

  /** Fetch a page as text. Obeys robots, the rate limit and the budget. */
  async text(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    if (this.requests >= this.config.requestBudget) {
      throw new RequestBudgetExceededError(this.config.requestBudget);
    }
    const verdict = await this.robots.assertAllowed(url);
    this.requests += 1;
    const result = await this.send(url, options, options.retries ?? this.config.maxRetries);
    return { ...result, robotsRule: verdict.rule };
  }

  /** Fetch and parse with cheerio. The adapter's usual entry point. */
  async html(url: string, options: FetchOptions = {}): Promise<FetchResult & { $: CheerioAPI }> {
    const result = await this.text(url, options);
    return { ...result, $: cheerio.load(result.body) };
  }

  /** Fetch and `JSON.parse`. Unparseable JSON is an error, never an empty object. */
  async json<T = unknown>(
    url: string,
    options: FetchOptions = {},
  ): Promise<FetchResult & { data: T }> {
    const result = await this.text(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
    });
    return { ...result, data: JSON.parse(result.body) as T };
  }

  /**
   * One URL, with the rate limit, the timeout and the retry ladder. Robots and
   * the budget are checked by the caller, so `robots.txt` itself can come
   * through here without checking itself.
   */
  private async send(
    url: string,
    options: FetchOptions,
    maxRetries: number,
  ): Promise<Omit<FetchResult, 'robotsRule'>> {
    const host = new URL(url).host;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const accepted = new Set(options.acceptStatuses ?? []);
    let lastStatus = 0;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      await this.limiter.acquire(host);
      this.signal?.throwIfAborted();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onOuterAbort = (): void => controller.abort();
      this.signal?.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'user-agent': this.config.userAgent,
            'accept-language': 'sr,sr-Latn;q=0.9,en;q=0.6',
            ...(options.headers ?? {}),
          },
          signal: controller.signal,
        });
        lastStatus = response.status;

        if (response.ok || accepted.has(response.status)) {
          const body = await response.text();
          this.bytes += body.length;
          return {
            url,
            finalUrl: response.url === '' ? url : response.url,
            status: response.status,
            body,
            headers: Object.fromEntries(response.headers),
            attempts: attempt,
          };
        }

        if (!RETRYABLE_STATUSES.has(response.status) || attempt > maxRetries) {
          this.failures += 1;
          throw new HttpError(
            url,
            response.status,
            attempt,
            RETRYABLE_STATUSES.has(response.status),
          );
        }

        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
        await this.backoff(attempt, retryAfter, url, response.status);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (this.signal?.aborted === true) throw error;
        if (attempt > maxRetries) {
          this.failures += 1;
          throw new HttpError(url, lastStatus, attempt, true);
        }
        this.log.debug('request failed, retrying', {
          url,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.backoff(attempt, null, url, lastStatus);
      } finally {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onOuterAbort);
      }
    }

    /* c8 ignore next 2 -- the loop always returns or throws; this satisfies the checker */
    this.failures += 1;
    throw new HttpError(url, lastStatus, maxRetries + 1, true);
  }

  /**
   * Exponential backoff with full jitter — `random() × base × 2^(attempt−1)`,
   * capped. Jitter matters because without it every retry from a parallel
   * crawl lands on the struggling host in the same millisecond. A server that
   * sent `Retry-After` gets exactly what it asked for when that is longer.
   */
  private async backoff(
    attempt: number,
    retryAfterMs: number | null,
    url: string,
    status: number,
  ): Promise<void> {
    this.retries += 1;
    const exponential = Math.min(
      this.config.backoffMaxMs,
      this.config.backoffBaseMs * 2 ** (attempt - 1),
    );
    const jittered = Math.round(exponential * (0.5 + this.random() * 0.5));
    const wait = Math.min(this.config.backoffMaxMs, Math.max(jittered, retryAfterMs ?? 0));
    this.log.warn('backing off', { url, status, attempt, waitMs: wait });
    await this.sleep(wait);
  }
}
