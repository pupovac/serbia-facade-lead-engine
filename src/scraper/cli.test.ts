/**
 * Argument parsing and the summary line.
 *
 * The CLI's whole job is turning flags into a `RunScope`; anything it got wrong
 * would be a crawl of the wrong thing, so the parsing is pinned down here and
 * the orchestration is tested in `run.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSummary, main, parseArgs, resolveCities } from './cli.js';
import { ScraperError } from './errors.js';
import type { RunSummary } from './run.js';

describe('parseArgs', () => {
  it('shows the help when given nothing', () => {
    expect(parseArgs([]).help).toBe(true);
  });

  it('reads the flags in the issue', () => {
    const args = parseArgs([
      '--source',
      'primer',
      '--city',
      'novi-sad',
      '--limit',
      '50',
      '--dry-run',
    ]);

    expect(args.sources).toEqual(['primer']);
    expect(args.cities).toEqual(['novi-sad']);
    expect(args.limit).toBe(50);
    expect(args.dryRun).toBe(true);
  });

  it('takes --source, --city and --query more than once', () => {
    const args = parseArgs([
      '--source',
      'a',
      '--source',
      'b',
      '--city',
      'nis',
      '--city',
      'cacak',
      '--query',
      'fasader',
      '--query',
      'stovarište',
    ]);

    expect(args.sources).toEqual(['a', 'b']);
    expect(args.cities).toEqual(['nis', 'cacak']);
    expect(args.queries).toEqual(['fasader', 'stovarište']);
  });

  it('parses --since as a date', () => {
    expect(parseArgs(['--since', '2026-08-01']).since).toEqual(new Date('2026-08-01'));
    expect(() => parseArgs(['--since', 'last tuesday'])).toThrow(/ISO date/);
  });

  it('refuses a flag with no value, so `--limit --dry-run` is not a silent 0', () => {
    expect(() => parseArgs(['--limit', '--dry-run'])).toThrow(/--limit needs a value/);
    expect(() => parseArgs(['--source'])).toThrow(/--source needs a value/);
  });

  it('refuses a number that is not one', () => {
    expect(() => parseArgs(['--limit', 'many'])).toThrow(/positive number/);
    expect(() => parseArgs(['--budget', '0'])).toThrow(/positive number/);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--yolo'])).toThrow(ScraperError);
  });

  it('reads the politeness overrides', () => {
    const args = parseArgs(['--budget', '250', '--delay', '4000', '--stale-days', '30']);

    expect(args.budget).toBe(250);
    expect(args.delayMs).toBe(4000);
    expect(args.staleDays).toBe(30);
  });
});

describe('resolveCities', () => {
  it('takes a geo slug or a name', () => {
    expect(resolveCities(['novi-sad'])[0]?.id).toBe('novi-sad');
    expect(resolveCities(['Čačak'])[0]?.id).toBe('cacak');
  });

  it('refuses an unknown city rather than quietly crawling the whole country', () => {
    expect(() => resolveCities(['Atlantis'])).toThrow(/not in data\/serbia-geo.json/);
  });
});

describe('formatSummary', () => {
  const summary: RunSummary = {
    sourceId: 'primer',
    runId: 7,
    status: 'completed',
    dryRun: false,
    startedAt: new Date('2026-08-20T10:00:00Z'),
    finishedAt: new Date('2026-08-20T10:00:12Z'),
    wallTimeMs: 12_000,
    itemsDiscovered: 6,
    itemsSkippedFresh: 1,
    itemsExtracted: 5,
    itemsFailed: 1,
    recordsEmitted: 5,
    recordsRejected: 0,
    recordsWithPhone: 4,
    leadsCreated: 4,
    leadsUpdated: 1,
    phonesAdded: 6,
    requests: 8,
    retries: 1,
    budget: 5000,
    budgetRemaining: 4992,
    rateLimitWaitMs: 7000,
    stoppedBecause: null,
    failures: [{ url: 'https://primer.rs/firme/x', message: 'HTTP 500', kind: 'http' }],
  };

  it('reports the numbers a human asks for after a crawl', () => {
    const text = formatSummary(summary);

    expect(text).toContain('primer: completed');
    expect(text).toContain('discovered 6');
    expect(text).toContain('with a phone 4');
    expect(text).toContain('8 of 5000 budget');
    expect(text).toContain('https://primer.rs/firme/x — HTTP 500');
  });

  it('says so when nothing was written', () => {
    expect(formatSummary({ ...summary, dryRun: true })).toContain('nothing written');
  });

  it('says why a run stopped early', () => {
    expect(formatSummary({ ...summary, stoppedBecause: 'limit of 2 records reached' })).toContain(
      'limit of 2',
    );
  });
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return lines;
  }

  it('prints the usage and exits 0 with no arguments', async () => {
    const lines = captureStdout();

    await expect(main([])).resolves.toBe(0);
    expect(lines.join('\n')).toContain('--dry-run');
  });

  it('lists the adapters it found on disk', async () => {
    const lines = captureStdout();

    await expect(main(['--list-sources'])).resolves.toBe(0);
    expect(lines.join('\n')).toContain('example');
  });

  it('runs a dry run without opening a database', async () => {
    const lines = captureStdout();

    // No --db and no DATABASE_PATH would open ./data/leads.sqlite if --dry-run
    // did not mean "never open the database".
    await expect(main(['--source', 'example', '--dry-run', '--limit', '2'])).resolves.toBe(0);

    const output = lines.join('\n');
    expect(output).toContain('nothing written');
    expect(output).toContain('records     emitted 2');
  });

  it('exits non-zero when a source fails', async () => {
    captureStdout();

    await expect(main(['--source', 'nope', '--dry-run'])).rejects.toThrow(/unknown source/);
  });
});
