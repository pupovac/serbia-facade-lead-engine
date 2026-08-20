/**
 * Crawler configuration — the politeness settings, resolved once per run.
 *
 * Every value here is a compliance control rather than a tuning knob. Most of
 * the sites in `research/sources-*.json` are small Serbian directories and
 * one-person contractor sites; the defaults below are what "polite" means for
 * them, and an adapter may make them gentler (a longer delay, a smaller
 * budget) but the framework is what enforces whichever wins.
 *
 * `src/lib` never reads `process.env`. The scraper does, exactly here.
 */
import { ScraperConfigError } from './errors.js';

/** Sent when `SCRAPER_USER_AGENT` is unset. Honest by construction: it names a real contact. */
export const DEFAULT_USER_AGENT =
  'serbia-facade-lead-engine/0.1 (+https://github.com/pupovac/serbia-facade-lead-engine)';

export interface ScraperConfig {
  /** Identifies the crawler and carries a contact URL or address. */
  readonly userAgent: string;
  /** The product token `robots.txt` groups are matched against — the UA up to the first `/`. */
  readonly userAgentToken: string;
  /** Honour `robots.txt`. Only a host with written permission may turn this off. */
  readonly respectRobots: boolean;
  /**
   * What to do when `robots.txt` cannot be read at all — a 5xx, a timeout, a
   * DNS failure. `deny` is the default and the correct one: "we could not ask"
   * is not "we may crawl". A 404 is different and always means allow-all, which
   * is what the standard says and what every host expects.
   */
  readonly onRobotsUnavailable: 'allow' | 'deny';
  /** Minimum milliseconds between two request *starts* to the same host. */
  readonly requestDelayMs: number;
  /** Per-request timeout. */
  readonly timeoutMs: number;
  /** Retries after the first attempt, for transient failures only. */
  readonly maxRetries: number;
  /** First backoff step; doubles per retry, with jitter. */
  readonly backoffBaseMs: number;
  /** Ceiling on a single backoff wait, including a server's own `Retry-After`. */
  readonly backoffMaxMs: number;
  /**
   * Hard ceiling on requests in one run. Not a target — a fuse. A pagination
   * bug that loops forever stops here instead of on the host's error budget.
   */
  readonly requestBudget: number;
  /** How old an item's last scrape may be before a run re-visits it. */
  readonly stalenessMs: number;
  /**
   * How old a *completed listing scope* may be before discovery re-walks it.
   * Much shorter than `stalenessMs` on purpose: re-reading a listing costs a
   * handful of requests and is the only way a new business is ever found,
   * while re-scraping every detail page costs one request per record.
   */
  readonly rediscoverAfterMs: number;
  /** Parallel in-flight requests across all hosts. Per-host order stays serialized. */
  readonly concurrency: number;
}

export const DEFAULTS: ScraperConfig = {
  userAgent: DEFAULT_USER_AGENT,
  userAgentToken: 'serbia-facade-lead-engine',
  respectRobots: true,
  onRobotsUnavailable: 'deny',
  requestDelayMs: 1500,
  timeoutMs: 20_000,
  maxRetries: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  requestBudget: 5_000,
  stalenessMs: 14 * 24 * 60 * 60 * 1000,
  rediscoverAfterMs: 24 * 60 * 60 * 1000,
  concurrency: 2,
};

/** Per-adapter overrides. An adapter may only make the crawl gentler — see `resolveConfig`. */
export type ConfigOverrides = {
  readonly [K in keyof Omit<ScraperConfig, 'userAgentToken'>]?: ScraperConfig[K] | undefined;
};

/** The product token robots groups match on: `serbia-facade-lead-engine/0.1 (+…)` → the first word. */
export function userAgentToken(userAgent: string): string {
  const token = userAgent.trim().split(/[/\s]/)[0] ?? '';
  return token.length === 0 ? DEFAULTS.userAgentToken : token;
}

/**
 * An honest User-Agent names the crawler *and* a way to reach whoever runs it.
 * A site owner who wants us to stop must not have to guess who we are.
 */
export function assertHonestUserAgent(userAgent: string): void {
  const hasContact = /(https?:\/\/|mailto:|@)/i.test(userAgent);
  if (userAgent.trim().length === 0 || !hasContact) {
    throw new ScraperConfigError(
      'SCRAPER_USER_AGENT must identify the crawler and carry a contact URL or email, ' +
        `e.g. "${DEFAULT_USER_AGENT}"`,
    );
  }
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** Just the variables this module reads — not `NodeJS.ProcessEnv`, so a test can pass three. */
export type ScraperEnv = Readonly<Record<string, string | undefined>>;

/** The environment as a partial config. Unset variables leave the default alone. */
export function configFromEnv(env: ScraperEnv = process.env): ConfigOverrides {
  const userAgent = env.SCRAPER_USER_AGENT?.trim();
  const contact = env.SCRAPER_CONTACT_EMAIL?.trim();
  const resolvedAgent =
    userAgent !== undefined && userAgent !== ''
      ? userAgent
      : contact !== undefined && contact !== ''
        ? `serbia-facade-lead-engine/0.1 (+mailto:${contact})`
        : DEFAULTS.userAgent;

  const staleDays = envNumber(env.SCRAPER_STALE_AFTER_DAYS, 0);
  const rediscoverHours = envNumber(env.SCRAPER_REDISCOVER_AFTER_HOURS, 0);

  return {
    userAgent: resolvedAgent,
    respectRobots: envBoolean(env.SCRAPER_RESPECT_ROBOTS, DEFAULTS.respectRobots),
    requestDelayMs: envNumber(env.SCRAPER_REQUEST_DELAY_MS, DEFAULTS.requestDelayMs),
    timeoutMs: envNumber(env.SCRAPER_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxRetries: envNumber(env.SCRAPER_MAX_RETRIES, DEFAULTS.maxRetries),
    requestBudget: envNumber(env.SCRAPER_REQUEST_BUDGET, DEFAULTS.requestBudget),
    concurrency: envNumber(env.SCRAPER_CONCURRENCY, DEFAULTS.concurrency),
    ...(staleDays > 0 ? { stalenessMs: staleDays * 24 * 60 * 60 * 1000 } : {}),
    ...(rediscoverHours > 0 ? { rediscoverAfterMs: rediscoverHours * 60 * 60 * 1000 } : {}),
  };
}

/**
 * Layer the config: defaults, then the environment, then the adapter, then the
 * CLI.
 *
 * The one asymmetry is deliberate. For the three settings that decide how hard
 * a host is hit — the delay, the retry count and the request budget — an
 * adapter may only tighten what the environment allows. A source whose README
 * says "one request every four seconds" gets four seconds even if someone
 * exports a shorter delay; nobody gets a faster crawl by editing an adapter.
 */
export function resolveConfig(
  layers: {
    env?: ConfigOverrides | undefined;
    adapter?: ConfigOverrides | undefined;
    cli?: ConfigOverrides | undefined;
  } = {},
): ScraperConfig {
  // Spreading an override whose value is an explicit `undefined` would erase
  // the default underneath it, so the layers are stripped before they merge.
  type Settings = Partial<Omit<ScraperConfig, 'userAgentToken'>>;
  const defined = (source: ConfigOverrides | undefined): Settings => {
    if (source === undefined) return {};
    return Object.fromEntries(
      Object.entries(source).filter(([, value]) => value !== undefined),
    ) as Settings;
  };

  const base: ScraperConfig = {
    ...DEFAULTS,
    ...defined(layers.env),
    ...defined(layers.adapter),
    ...defined(layers.cli),
  };

  const withoutAdapter: ScraperConfig = {
    ...DEFAULTS,
    ...defined(layers.env),
    ...defined(layers.cli),
  };
  const adapter = defined(layers.adapter);

  const config: ScraperConfig = {
    ...base,
    requestDelayMs: Math.max(base.requestDelayMs, withoutAdapter.requestDelayMs),
    requestBudget: Math.min(base.requestBudget, withoutAdapter.requestBudget),
    maxRetries:
      adapter.maxRetries === undefined
        ? base.maxRetries
        : Math.min(adapter.maxRetries, withoutAdapter.maxRetries),
    // `respectRobots: false` is a written-permission decision, never an adapter's.
    respectRobots: withoutAdapter.respectRobots,
    userAgentToken: userAgentToken(base.userAgent),
  };

  assertHonestUserAgent(config.userAgent);
  return config;
}
