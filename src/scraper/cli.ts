#!/usr/bin/env node
/**
 * `npm run scrape` — the scraper entrypoint.
 *
 * Argument parsing, a database handle, and printing the summary. Every decision
 * about what to crawl and how politely belongs to `run.ts` and `config.ts`; if
 * a rule ever needs to live here, it is in the wrong place.
 */
import { closeDatabase, openDatabase, type Db } from '@/lib/db';
import { findMunicipalityByName, getMunicipalityById, type Municipality } from '@/lib/geo';
import { ScraperError, StructureChangedError } from './errors.js';
import { createLogger, parseLogLevel, type LogLevel } from './logger.js';
import { loadAdapters, type AdapterRegistry } from './registry.js';
import { runSource, type RunSummary } from './run.js';
import type { ConfigOverrides } from './config.js';
import type { RunScope } from './types.js';

const USAGE = `serbia-facade-lead-engine — scraper CLI

Usage:
  npm run scrape -- --source <id> [options]

Options:
  --source <id>          Run one source adapter (repeatable). Default: every registered source.
  --list-sources         Print the registered source adapters and exit.
  --city <id|name>       Restrict the run to one city (repeatable). Default: the full geo dataset.
  --query <term>         Restrict the run to one search term (repeatable).
  --limit <n>            Stop after n records per source. Useful for smoke runs.
  --since <ISO date>     Re-scrape items last scraped before this. Overrides --stale-days.
  --stale-days <n>       Re-scrape a detail page older than n days. Default: 14.
  --rediscover-after <h> Re-walk a finished listing older than h hours. Default: 24.
  --budget <n>           Hard ceiling on requests per source for this run.
  --delay <ms>           Minimum milliseconds between requests to one host.
  --dry-run              Discover, fetch and extract; write nothing to the database.
  --db <path>            SQLite file to write. Default: from DATABASE_PATH.
  --trigger <name>       Recorded on the crawl_runs row. manual | scheduled | backfill.
  --log-level <level>    error | warn | info | debug. Default: from LOG_LEVEL.
  --help                 Show this message.

Runs are incremental: an item scraped inside the staleness window is skipped,
an existing lead is updated and its provenance extended, never re-inserted.
`;

export interface CliArgs {
  readonly sources: readonly string[];
  readonly cities: readonly string[];
  readonly queries: readonly string[];
  readonly limit: number | null;
  readonly since: Date | null;
  readonly staleDays: number | null;
  readonly rediscoverAfterHours: number | null;
  readonly budget: number | null;
  readonly delayMs: number | null;
  readonly dryRun: boolean;
  readonly db: string | null;
  readonly trigger: string;
  readonly logLevel: LogLevel;
  readonly listSources: boolean;
  readonly help: boolean;
}

/** Exported for the unit test — parsing is pure and worth pinning down. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const sources: string[] = [];
  const cities: string[] = [];
  const queries: string[] = [];
  let limit: number | null = null;
  let since: Date | null = null;
  let staleDays: number | null = null;
  let rediscoverAfterHours: number | null = null;
  let budget: number | null = null;
  let delayMs: number | null = null;
  let dryRun = false;
  let db: string | null = null;
  let trigger = 'manual';
  let logLevel = parseLogLevel(process.env.LOG_LEVEL);
  let listSources = false;
  let help = argv.length === 0;

  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ScraperError(`${flag} needs a value`);
    }
    return value;
  };

  const number = (flag: string, raw: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ScraperError(`${flag} needs a positive number, got \`${raw}\``);
    }
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    switch (flag) {
      case '--source':
        sources.push(valueOf(flag, index));
        index += 1;
        break;
      case '--city':
        cities.push(valueOf(flag, index));
        index += 1;
        break;
      case '--query':
        queries.push(valueOf(flag, index));
        index += 1;
        break;
      case '--limit':
        limit = number(flag, valueOf(flag, index));
        index += 1;
        break;
      case '--since': {
        const raw = valueOf(flag, index);
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          throw new ScraperError(`--since needs an ISO date, got \`${raw}\``);
        }
        since = parsed;
        index += 1;
        break;
      }
      case '--stale-days':
        staleDays = number(flag, valueOf(flag, index));
        index += 1;
        break;
      case '--rediscover-after':
        rediscoverAfterHours = number(flag, valueOf(flag, index));
        index += 1;
        break;
      case '--budget':
        budget = number(flag, valueOf(flag, index));
        index += 1;
        break;
      case '--delay':
        delayMs = number(flag, valueOf(flag, index));
        index += 1;
        break;
      case '--db':
        db = valueOf(flag, index);
        index += 1;
        break;
      case '--trigger':
        trigger = valueOf(flag, index);
        index += 1;
        break;
      case '--log-level':
        logLevel = parseLogLevel(valueOf(flag, index), logLevel);
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--list-sources':
        listSources = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new ScraperError(`unknown option \`${flag}\`. Run with --help.`);
    }
  }

  return {
    sources,
    cities,
    queries,
    limit,
    since,
    staleDays,
    rediscoverAfterHours,
    budget,
    delayMs,
    dryRun,
    db,
    trigger,
    logLevel,
    listSources,
    help,
  };
}

/** `--city` takes a geo slug or a name. An unknown one is an error, never a silent full crawl. */
export function resolveCities(names: readonly string[]): Municipality[] {
  return names.map((name) => {
    const resolved = getMunicipalityById(name) ?? findMunicipalityByName(name);
    if (resolved === undefined) {
      throw new ScraperError(`unknown city \`${name}\` — not in data/serbia-geo.json`);
    }
    return resolved;
  });
}

/** Six lines a human actually reads after a crawl. */
export function formatSummary(summary: RunSummary): string {
  const seconds = (summary.wallTimeMs / 1000).toFixed(1);
  const lines = [
    `${summary.sourceId}: ${summary.status}${summary.dryRun ? ' (dry run — nothing written)' : ''} in ${seconds}s`,
    `  items       discovered ${summary.itemsDiscovered}, extracted ${summary.itemsExtracted}, ` +
      `skipped-fresh ${summary.itemsSkippedFresh}, failed ${summary.itemsFailed}`,
    `  records     emitted ${summary.recordsEmitted}, with a phone ${summary.recordsWithPhone}, ` +
      `rejected ${summary.recordsRejected}`,
    `  leads       created ${summary.leadsCreated}, updated ${summary.leadsUpdated}, ` +
      `phones added ${summary.phonesAdded}`,
    `  requests    ${summary.requests} of ${summary.budget} budget, ${summary.retries} retries, ` +
      `${(summary.rateLimitWaitMs / 1000).toFixed(1)}s spent being polite`,
  ];
  if (summary.stoppedBecause !== null) lines.push(`  stopped     ${summary.stoppedBecause}`);
  for (const failure of summary.failures) {
    lines.push(`  ! ${failure.kind.padEnd(10)} ${failure.url} — ${failure.message}`);
  }
  return lines.join('\n');
}

function scopeFrom(args: CliArgs): Partial<RunScope> {
  return {
    municipalities: resolveCities(args.cities),
    queries: args.queries,
    limit: args.limit,
    since: args.since,
    ...(args.staleDays === null ? {} : { stalenessMs: args.staleDays * 24 * 60 * 60 * 1000 }),
    ...(args.rediscoverAfterHours === null
      ? {}
      : { rediscoverAfterMs: args.rediscoverAfterHours * 60 * 60 * 1000 }),
  };
}

function configFrom(args: CliArgs): ConfigOverrides {
  return {
    ...(args.budget === null ? {} : { requestBudget: args.budget }),
    ...(args.delayMs === null ? {} : { requestDelayMs: args.delayMs }),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const registry: AdapterRegistry = await loadAdapters();

  if (args.listSources) {
    for (const adapter of registry.all()) {
      console.log(
        `${adapter.id.padEnd(24)} ${adapter.leadTypes.join(',').padEnd(45)} ${adapter.name}`,
      );
    }
    return 0;
  }

  const adapters =
    args.sources.length === 0 ? registry.all() : args.sources.map((id) => registry.require(id));
  if (adapters.length === 0) {
    console.error('no source adapters registered under src/scraper/sources');
    return 1;
  }

  const log = createLogger({ level: args.logLevel });
  // `--dry-run` never opens the database. That is the guarantee, not a flag
  // checked at each write site.
  const db: Db | null = args.dryRun ? null : openDatabase(args.db === null ? {} : { url: args.db });

  let failed = 0;
  try {
    for (const adapter of adapters) {
      try {
        const summary = await runSource({
          adapter,
          db,
          scope: scopeFrom(args),
          config: configFrom(args),
          log,
          dryRun: args.dryRun,
          trigger: args.trigger,
        });
        console.log(formatSummary(summary));
      } catch (error) {
        failed += 1;
        if (error instanceof StructureChangedError) {
          console.error(
            `${adapter.id}: STRUCTURE CHANGED — ${error.message}\n` +
              '  The source no longer matches this adapter. Re-save the fixture, fix the ' +
              'selector, and re-run; do not "fix" it by loosening the assertion.',
          );
        } else {
          console.error(`${adapter.id}: run failed — ${(error as Error).message}`);
        }
      }
    }
  } finally {
    if (db !== null) closeDatabase(db);
  }

  return failed === 0 ? 0 : 1;
}

/* c8 ignore start -- the process entry point; `main` itself is covered */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
