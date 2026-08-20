/**
 * `robots.txt`: parsing, matching, and one fetch per host per run.
 *
 * This is a compliance control, so the two decisions that are easy to get
 * quietly wrong are made explicitly here:
 *
 * - **Unreadable is not permission.** A 404 (or any other 4xx) means the host
 *   publishes no rules and everything is allowed — that is what the standard
 *   says and what every host expects. A 5xx, a timeout or a DNS failure means
 *   we could not ask, and `onRobotsUnavailable: 'deny'` is the default.
 * - **Longest match wins, ties go to `Allow`.** The rule every major crawler
 *   implements. A `Disallow: /` with an `Allow: /firme/` underneath it is a
 *   host saying "only the directory", and reading it the other way round would
 *   cost us the source entirely.
 *
 * `Crawl-delay` is honoured when it asks for more room than we configured; it
 * can never make us faster.
 */
import { RobotsDisallowedError } from '../errors.js';

/** One `Allow:` / `Disallow:` line, kept verbatim so a refusal can quote it. */
export interface RobotsRule {
  readonly allow: boolean;
  /** The path pattern, `*` and `$` included. */
  readonly pattern: string;
  /** The line as published, for the run log. */
  readonly source: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** Seconds, when the group states one. */
  readonly crawlDelay?: number | undefined;
}

export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  /** True when the host published no usable rules at all. */
  readonly empty: boolean;
}

export interface RobotsVerdict {
  readonly allowed: boolean;
  /** The matching line, or the reason there was none. Goes straight into a log or an error. */
  readonly rule: string;
  /** Seconds, from the group that applied. */
  readonly crawlDelay?: number | undefined;
}

/** Everything allowed, because the host published nothing. */
const ALLOW_ALL: RobotsVerdict = { allowed: true, rule: 'no robots.txt rule matched' };

/**
 * Parse a `robots.txt`.
 *
 * Tolerant by design: unknown directives are skipped, comments are stripped,
 * `user-agent` lines that stack are one group, and a malformed line is ignored
 * rather than aborting the file. A host whose robots.txt we cannot parse at all
 * yields `empty: true`, which the caller treats as "no rules".
 */
export function parseRobotsTxt(body: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelay: number | undefined;
  /** True while the previous non-empty line was also a `user-agent`. */
  let stacking = false;

  const flush = (): void => {
    if (agents.length > 0 && (rules.length > 0 || crawlDelay !== undefined)) {
      groups.push({ agents, rules, crawlDelay });
    }
    agents = [];
    rules = [];
    crawlDelay = undefined;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!stacking) flush();
        agents.push(value.toLowerCase());
        stacking = true;
        continue;
      }
      case 'allow':
      case 'disallow': {
        if (agents.length === 0) continue;
        // `Disallow:` with an empty value is the documented "allow everything".
        if (field === 'disallow' && value === '') {
          rules.push({ allow: true, pattern: '/', source: line });
        } else if (value !== '') {
          rules.push({ allow: field === 'allow', pattern: value, source: line });
        }
        stacking = false;
        continue;
      }
      case 'crawl-delay': {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) crawlDelay = seconds;
        stacking = false;
        continue;
      }
      case 'sitemap': {
        if (value !== '') sitemaps.push(value);
        continue;
      }
      default:
        stacking = false;
    }
  }
  flush();

  return { groups, sitemaps, empty: groups.length === 0 };
}

/** Turn a robots path pattern into a regex. `*` is any run, `$` anchors the end. */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * The group that applies to us: an exact product-token match, else `*`.
 *
 * Matching is on the token (`serbia-facade-lead-engine`), not the whole
 * User-Agent string, because that is the half of the header a host writes rules
 * against.
 */
export function groupFor(robots: RobotsTxt, token: string): RobotsGroup | undefined {
  const wanted = token.trim().toLowerCase();
  const exact = robots.groups.find((group) => group.agents.includes(wanted));
  if (exact !== undefined) return exact;
  return robots.groups.find((group) => group.agents.includes('*'));
}

/**
 * May we fetch this path?
 *
 * `pathname + search`, because a host that disallows `/search?` means the query
 * string. Longest pattern wins; an `Allow` and a `Disallow` of equal length is
 * an allow.
 */
export function isAllowed(robots: RobotsTxt, token: string, url: string): RobotsVerdict {
  const group = groupFor(robots, token);
  if (group === undefined) return ALLOW_ALL;

  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;

  let best: RobotsRule | undefined;
  for (const rule of group.rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    if (
      best === undefined ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }

  if (best === undefined) {
    return { allowed: true, rule: ALLOW_ALL.rule, crawlDelay: group.crawlDelay };
  }
  return { allowed: best.allow, rule: best.source, crawlDelay: group.crawlDelay };
}

/** What the cache asks the transport for. Kept tiny so the fetcher can supply it. */
export interface RobotsFetchResult {
  readonly status: number;
  readonly body: string;
}

export interface RobotsCacheOptions {
  readonly token: string;
  /** `false` skips every check — only for a host that gave written permission. */
  readonly respect: boolean;
  readonly onUnavailable: 'allow' | 'deny';
  /** Fetches `<origin>/robots.txt`. Throwing means "could not read". */
  readonly fetch: (robotsUrl: string) => Promise<RobotsFetchResult>;
  readonly onFetched?: ((origin: string, robots: RobotsTxt) => void) | undefined;
}

/**
 * One `robots.txt` per origin per run, fetched at most once even when twenty
 * requests race for it — the in-flight promise is what is cached, not just the
 * result.
 */
export class RobotsCache {
  private readonly entries = new Map<string, Promise<RobotsTxt | null>>();
  private readonly parsed = new Map<string, RobotsTxt | null>();
  private readonly options: RobotsCacheOptions;
  /** robots.txt fetches, counted separately from crawl requests. */
  private fetches = 0;

  constructor(options: RobotsCacheOptions) {
    this.options = options;
  }

  fetchCount(): number {
    return this.fetches;
  }

  async check(url: string): Promise<RobotsVerdict> {
    if (!this.options.respect) {
      return { allowed: true, rule: 'robots.txt checking disabled by configuration' };
    }

    const origin = new URL(url).origin;
    const robots = await this.load(origin);
    if (robots === null) {
      return this.options.onUnavailable === 'allow'
        ? { allowed: true, rule: 'robots.txt unreadable; configured to allow' }
        : { allowed: false, rule: 'robots.txt unreadable; configured to deny' };
    }
    if (robots.empty) return ALLOW_ALL;
    return isAllowed(robots, this.options.token, url);
  }

  /** `check`, but a disallow throws. The fetcher's path. */
  async assertAllowed(url: string): Promise<RobotsVerdict> {
    const verdict = await this.check(url);
    if (!verdict.allowed) throw new RobotsDisallowedError(url, verdict.rule);
    return verdict;
  }

  private async load(origin: string): Promise<RobotsTxt | null> {
    const cached = this.parsed.get(origin);
    if (cached !== undefined) return cached;

    const inFlight = this.entries.get(origin);
    if (inFlight !== undefined) return inFlight;

    const promise = this.load0(origin);
    this.entries.set(origin, promise);
    const result = await promise;
    this.parsed.set(origin, result);
    return result;
  }

  private async load0(origin: string): Promise<RobotsTxt | null> {
    this.fetches += 1;
    try {
      const response = await this.options.fetch(`${origin}/robots.txt`);
      // 4xx — including the usual 404 — is a host with no rules.
      if (response.status >= 400 && response.status < 500) {
        return { groups: [], sitemaps: [], empty: true };
      }
      if (response.status >= 500) return null;
      const robots = parseRobotsTxt(response.body);
      this.options.onFetched?.(origin, robots);
      return robots;
    } catch {
      return null;
    }
  }
}
