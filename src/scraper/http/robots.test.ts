/**
 * `robots.txt` — parsing, matching and the cache.
 *
 * The cases that matter are the ones where getting it wrong is a compliance
 * failure rather than a bug: an unreadable file, a longest-match `Allow` under
 * a blanket `Disallow`, and a group written for our product token specifically.
 */
import { describe, expect, it, vi } from 'vitest';
import { RobotsDisallowedError } from '../errors.js';
import { RobotsCache, groupFor, isAllowed, parseRobotsTxt } from './robots.js';

const TOKEN = 'serbia-facade-lead-engine';

const REAL_WORLD = `
# A shape the Serbian directories actually publish.
User-agent: *
Disallow: /pretraga
Disallow: /admin/
Allow: /firme/
Crawl-delay: 2

User-agent: serbia-facade-lead-engine
Disallow: /firme/premium

Sitemap: https://primer.rs/sitemap.xml
`;

describe('parseRobotsTxt', () => {
  it('reads groups, rules, crawl-delay and sitemaps', () => {
    const robots = parseRobotsTxt(REAL_WORLD);

    expect(robots.empty).toBe(false);
    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[0]?.agents).toEqual(['*']);
    expect(robots.groups[0]?.crawlDelay).toBe(2);
    expect(robots.sitemaps).toEqual(['https://primer.rs/sitemap.xml']);
  });

  it('treats stacked user-agent lines as one group', () => {
    const robots = parseRobotsTxt('User-agent: a\nUser-agent: b\nDisallow: /x');

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['a', 'b']);
  });

  it('reads an empty Disallow as allow-everything', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow:');

    expect(isAllowed(robots, TOKEN, 'https://primer.rs/anything').allowed).toBe(true);
  });

  it('ignores comments, blank lines and directives it does not know', () => {
    const robots = parseRobotsTxt(
      '# hello\n\nUser-agent: *   # everyone\nRequest-rate: 1/10s\nDisallow: /x\n',
    );

    expect(robots.groups[0]?.rules).toHaveLength(1);
    expect(robots.groups[0]?.rules[0]?.pattern).toBe('/x');
  });

  it('reports a file with no usable rules as empty', () => {
    expect(parseRobotsTxt('').empty).toBe(true);
    expect(parseRobotsTxt('total nonsense, no colons here').empty).toBe(true);
  });
});

describe('isAllowed', () => {
  const robots = parseRobotsTxt(REAL_WORLD);

  it('prefers the group written for our product token', () => {
    expect(groupFor(robots, TOKEN)?.agents).toEqual([TOKEN]);
    // Our own group has no `/pretraga` rule, so the wildcard's does not apply.
    expect(isAllowed(robots, TOKEN, 'https://primer.rs/pretraga?q=fasader').allowed).toBe(true);
    expect(isAllowed(robots, TOKEN, 'https://primer.rs/firme/premium').allowed).toBe(false);
  });

  it('falls back to the wildcard group for anyone else', () => {
    expect(isAllowed(robots, 'some-other-bot', 'https://primer.rs/pretraga').allowed).toBe(false);
    expect(isAllowed(robots, 'some-other-bot', 'https://primer.rs/firme/x').allowed).toBe(true);
  });

  it('lets the longest match win, and an Allow break a tie', () => {
    // "Only the directory" — a real and common shape. Reading it the other way
    // round would cost us the source entirely.
    const onlyDirectory = parseRobotsTxt('User-agent: *\nDisallow: /\nAllow: /firme/');

    expect(isAllowed(onlyDirectory, TOKEN, 'https://primer.rs/').allowed).toBe(false);
    expect(isAllowed(onlyDirectory, TOKEN, 'https://primer.rs/firme/abc').allowed).toBe(true);

    const tie = parseRobotsTxt('User-agent: *\nDisallow: /x\nAllow: /x');
    expect(isAllowed(tie, TOKEN, 'https://primer.rs/x').allowed).toBe(true);
  });

  it('honours wildcards and end anchors, and matches the query string', () => {
    const robots = parseRobotsTxt(
      'User-agent: *\nDisallow: /*.pdf$\nDisallow: /firme/*/print\nDisallow: /list?sort=',
    );

    expect(isAllowed(robots, TOKEN, 'https://primer.rs/docs/cenovnik.pdf').allowed).toBe(false);
    expect(isAllowed(robots, TOKEN, 'https://primer.rs/docs/cenovnik.pdf.html').allowed).toBe(true);
    expect(isAllowed(robots, TOKEN, 'https://primer.rs/firme/abc/print').allowed).toBe(false);
    expect(isAllowed(robots, TOKEN, 'https://primer.rs/list?sort=name').allowed).toBe(false);
    expect(isAllowed(robots, TOKEN, 'https://primer.rs/list').allowed).toBe(true);
  });

  it('allows everything when no rule matches', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /admin/');

    expect(isAllowed(robots, TOKEN, 'https://primer.rs/firme/x').allowed).toBe(true);
  });
});

describe('RobotsCache', () => {
  const options = { token: TOKEN, respect: true, onUnavailable: 'deny' as const };

  it('fetches robots.txt once per origin, even when requests race', async () => {
    const fetch = vi.fn(async () => ({ status: 200, body: 'User-agent: *\nDisallow: /admin/' }));
    const cache = new RobotsCache({ ...options, fetch });

    const verdicts = await Promise.all([
      cache.check('https://primer.rs/a'),
      cache.check('https://primer.rs/b'),
      cache.check('https://primer.rs/admin/x'),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://primer.rs/robots.txt');
    expect(verdicts.map((verdict) => verdict.allowed)).toEqual([true, true, false]);
    expect(cache.fetchCount()).toBe(1);
  });

  it('treats a 404 as a host with no rules', async () => {
    const cache = new RobotsCache({
      ...options,
      fetch: async () => ({ status: 404, body: 'not found' }),
    });

    await expect(cache.check('https://primer.rs/anything')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('refuses to crawl when robots.txt cannot be read at all', async () => {
    // "We could not ask" is not "we may crawl".
    const cache = new RobotsCache({
      ...options,
      fetch: async () => ({ status: 503, body: '' }),
    });

    await expect(cache.check('https://primer.rs/x')).resolves.toMatchObject({ allowed: false });
    await expect(cache.assertAllowed('https://primer.rs/x')).rejects.toThrow(RobotsDisallowedError);
  });

  it('can be configured to allow when robots.txt is unreadable', async () => {
    const cache = new RobotsCache({
      ...options,
      onUnavailable: 'allow',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(cache.check('https://primer.rs/x')).resolves.toMatchObject({ allowed: true });
  });

  it('skips every check when robots handling is switched off', async () => {
    const fetch = vi.fn(async () => ({ status: 200, body: 'User-agent: *\nDisallow: /' }));
    const cache = new RobotsCache({ ...options, respect: false, fetch });

    await expect(cache.check('https://primer.rs/anything')).resolves.toMatchObject({
      allowed: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the rule that produced a refusal', async () => {
    const cache = new RobotsCache({
      ...options,
      fetch: async () => ({ status: 200, body: 'User-agent: *\nDisallow: /pretraga' }),
    });

    await expect(cache.assertAllowed('https://primer.rs/pretraga?q=x')).rejects.toThrow(
      /Disallow: \/pretraga/,
    );
  });

  it('reports the crawl-delay so the limiter can slow down', async () => {
    const seen: number[] = [];
    const cache = new RobotsCache({
      ...options,
      fetch: async () => ({ status: 200, body: 'User-agent: *\nCrawl-delay: 4\nDisallow: /x' }),
      onFetched: (_origin, robots) => {
        for (const group of robots.groups) {
          if (group.crawlDelay !== undefined) seen.push(group.crawlDelay);
        }
      },
    });

    await cache.check('https://primer.rs/a');
    expect(seen).toEqual([4]);
  });
});
