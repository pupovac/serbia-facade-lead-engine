/**
 * Configuration layering.
 *
 * The rule under test is the asymmetry: an adapter may make a crawl gentler
 * than the environment asks for and never harsher. Nobody gets a faster crawl
 * of a small Serbian site by editing an adapter.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  DEFAULT_USER_AGENT,
  assertHonestUserAgent,
  configFromEnv,
  resolveConfig,
  userAgentToken,
} from './config.js';
import { ScraperConfigError } from './errors.js';

describe('resolveConfig', () => {
  it('layers defaults, environment and CLI', () => {
    const config = resolveConfig({
      env: { requestDelayMs: 2000, timeoutMs: 5000 },
      cli: { timeoutMs: 9000 },
    });

    expect(config.requestDelayMs).toBe(2000);
    expect(config.timeoutMs).toBe(9000);
    expect(config.maxRetries).toBe(DEFAULTS.maxRetries);
  });

  it('lets an adapter slow itself down', () => {
    const config = resolveConfig({
      env: { requestDelayMs: 1000 },
      adapter: { requestDelayMs: 4000 },
    });

    expect(config.requestDelayMs).toBe(4000);
  });

  it('does not let an adapter speed itself up', () => {
    const config = resolveConfig({
      env: { requestDelayMs: 4000 },
      adapter: { requestDelayMs: 100 },
    });

    expect(config.requestDelayMs).toBe(4000);
  });

  it('lets an adapter shrink the request budget but not raise it', () => {
    expect(
      resolveConfig({ env: { requestBudget: 1000 }, adapter: { requestBudget: 50 } }).requestBudget,
    ).toBe(50);
    expect(
      resolveConfig({ env: { requestBudget: 100 }, adapter: { requestBudget: 9999 } })
        .requestBudget,
    ).toBe(100);
  });

  it('never lets an adapter switch robots.txt off', () => {
    // Ignoring robots is a written-permission decision, not an adapter's.
    const config = resolveConfig({ adapter: { respectRobots: false } });

    expect(config.respectRobots).toBe(true);
  });

  it('ignores an override whose value is undefined', () => {
    const config = resolveConfig({ cli: { requestDelayMs: undefined } });

    expect(config.requestDelayMs).toBe(DEFAULTS.requestDelayMs);
  });

  it('derives the robots product token from the User-Agent', () => {
    const config = resolveConfig({ env: { userAgent: 'my-crawler/2.0 (+https://example.rs)' } });

    expect(config.userAgentToken).toBe('my-crawler');
  });
});

describe('assertHonestUserAgent', () => {
  it('accepts a User-Agent that carries a contact', () => {
    expect(() => assertHonestUserAgent(DEFAULT_USER_AGENT)).not.toThrow();
    expect(() => assertHonestUserAgent('crawler/1.0 (+mailto:me@firma.rs)')).not.toThrow();
  });

  it('refuses to start without one', () => {
    // A site owner who wants us to stop must not have to guess who we are.
    expect(() => assertHonestUserAgent('crawler/1.0')).toThrow(ScraperConfigError);
    expect(() => assertHonestUserAgent('   ')).toThrow(ScraperConfigError);
    expect(() => resolveConfig({ env: { userAgent: 'Mozilla/5.0' } })).toThrow(ScraperConfigError);
  });
});

describe('configFromEnv', () => {
  it('builds a User-Agent from the contact address when none is set', () => {
    const config = configFromEnv({ SCRAPER_CONTACT_EMAIL: 'prodaja@firma.rs' });

    expect(config.userAgent).toContain('mailto:prodaja@firma.rs');
  });

  it('falls back to the project default when neither is set', () => {
    expect(configFromEnv({}).userAgent).toBe(DEFAULT_USER_AGENT);
  });

  it('reads the politeness numbers, ignoring unusable values', () => {
    const config = configFromEnv({
      SCRAPER_REQUEST_DELAY_MS: '2500',
      SCRAPER_MAX_RETRIES: 'lots',
      SCRAPER_STALE_AFTER_DAYS: '7',
      SCRAPER_RESPECT_ROBOTS: 'false',
    });

    expect(config.requestDelayMs).toBe(2500);
    expect(config.maxRetries).toBe(DEFAULTS.maxRetries);
    expect(config.stalenessMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.respectRobots).toBe(false);
  });

  it('leaves staleness alone when the variable is unset', () => {
    expect(configFromEnv({}).stalenessMs).toBeUndefined();
  });
});

describe('userAgentToken', () => {
  it('takes the product token, not the whole header', () => {
    expect(userAgentToken('serbia-facade-lead-engine/0.1 (+https://x)')).toBe(
      'serbia-facade-lead-engine',
    );
    expect(userAgentToken('bare-name')).toBe('bare-name');
    expect(userAgentToken('   ')).toBe(DEFAULTS.userAgentToken);
  });
});
