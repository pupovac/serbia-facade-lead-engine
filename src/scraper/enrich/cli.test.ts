/**
 * `npm run enrich` — argument parsing and the summary a human reads.
 *
 * Parsing is pure and worth pinning down: a mistyped `--path` that silently
 * fell back to "both" would quietly spend the request budget on the path the
 * operator was trying to avoid.
 */
import { describe, expect, it } from 'vitest';
import { ScraperError } from '../errors.js';
import { formatSummary, parseArgs } from './cli.js';
import type { EnrichSummary } from './run.js';

describe('parseArgs', () => {
  it('defaults to both paths and no limit', () => {
    const args = parseArgs([]);
    expect(args.path).toBe('both');
    expect(args.limit).toBeNull();
    expect(args.leadIds).toEqual([]);
    expect(args.help).toBe(false);
  });

  it('reads the flags a run is actually driven by', () => {
    const args = parseArgs([
      '--path',
      'own-site',
      '--lead',
      '12',
      '--lead',
      '34',
      '--limit',
      '50',
      '--stale-days',
      '7',
      '--budget',
      '400',
      '--delay',
      '2000',
      '--db',
      './data/test.sqlite',
      '--trigger',
      'scheduled',
    ]);
    expect(args).toMatchObject({
      path: 'own-site',
      leadIds: [12, 34],
      limit: 50,
      staleDays: 7,
      budget: 400,
      delayMs: 2000,
      db: './data/test.sqlite',
      trigger: 'scheduled',
    });
  });

  it('refuses a path it does not have', () => {
    expect(() => parseArgs(['--path', 'guess'])).toThrow(ScraperError);
  });

  it('refuses a flag with no value and an unknown flag', () => {
    expect(() => parseArgs(['--limit'])).toThrow('--limit needs a value');
    expect(() => parseArgs(['--nope'])).toThrow('unknown option');
  });

  it('refuses a limit that is not a positive number', () => {
    expect(() => parseArgs(['--limit', 'nekoliko'])).toThrow('positive number');
    expect(() => parseArgs(['--limit', '0'])).toThrow('positive number');
  });
});

describe('formatSummary', () => {
  const summary: EnrichSummary = {
    runId: 1,
    status: 'completed',
    dryRun: false,
    startedAt: new Date('2026-08-20T12:00:00Z'),
    finishedAt: new Date('2026-08-20T12:01:00Z'),
    wallTimeMs: 60_000,
    targetsSelected: 31,
    leadsProcessed: 30,
    leadsEnriched: 22,
    pagesFetched: 96,
    pagesMerged: 40,
    pagesSuggested: 3,
    pagesRejected: 53,
    fieldsAdded: { phone: 24, email: 18, social: 9 },
    leadsGainedFirstPhone: 19,
    suggestionsQueued: 7,
    rejections: { nothing_to_add: 50, no_connection: 3, fetch_failed: 2 },
    suggestionSamples: [],
    scorePointsAdded: 612,
    requests: 128,
    budget: 500,
    budgetRemaining: 372,
    rateLimitWaitMs: 94_000,
    stoppedBecause: null,
  };

  it('reports the numbers the issue asks for', () => {
    const text = formatSummary(summary);
    expect(text).toContain('processed 30');
    expect(text).toContain('phone 24, email 18, social 9');
    expect(text).toContain('7 queued for review');
    expect(text).toContain('nothing_to_add 50');
    expect(text).toContain('gained a first phone 19');
  });

  it('orders the rejections by how often they happened', () => {
    const line = formatSummary(summary)
      .split('\n')
      .find((row) => row.includes('rejections'));
    expect(line).toBe('  rejections  nothing_to_add 50, no_connection 3, fetch_failed 2');
  });

  it('says so plainly when a run added nothing', () => {
    const text = formatSummary({ ...summary, fieldsAdded: {}, rejections: {} });
    expect(text).toContain('none added');
    expect(text).toContain('rejections  none');
  });

  it('names the reason a run stopped early', () => {
    expect(
      formatSummary({ ...summary, stoppedBecause: 'request budget of 500 exhausted' }),
    ).toContain('stopped     request budget of 500 exhausted');
  });
});
