#!/usr/bin/env node
/**
 * `npm run enrich` — the enrichment entrypoint.
 *
 * Argument parsing, a database handle, and printing the summary. Every decision
 * about what to enrich and how politely belongs to `run.ts`, `targets.ts` and
 * `config.ts`, exactly as it does for `npm run scrape`.
 */
import { closeDatabase, openDatabase, type Db } from '@/lib/db';
import { ScraperError } from '../errors.js';
import { createLogger, parseLogLevel, type LogLevel } from '../logger.js';
import {
  DEFAULT_ENRICHMENT_PATH,
  runEnrichment,
  type EnrichmentPath,
  type EnrichSummary,
} from './run.js';
import type { ConfigOverrides } from '../config.js';

const USAGE = `serbia-facade-lead-engine — contact enrichment

Usage:
  npm run enrich -- [options]

Takes leads that are missing high-value contact details and goes looking for
them, ordered by how much filling the blanks would improve the lead score.

Options:
  --path <which>         own-site | search | both. Default: own-site.
                         own-site  crawls the contact pages of a lead's own website.
                         search    looks for a lead that has no website at all.
                                   OFF BY DEFAULT: the only search provider whose
                                   robots.txt permits us answers every query with a
                                   403 or an anti-bot challenge, so the path made 111
                                   attempts and returned 0 candidates in the pilot.
                                   Asking for it logs why and runs it anyway.
  --lead <id>            Enrich one lead (repeatable). Default: every lead that would gain.
  --limit <n>            Stop after n leads.
  --stale-days <n>       Skip a lead enrichment visited inside the last n days. Default: 30.
  --budget <n>           Hard ceiling on requests for this run.
  --delay <ms>           Minimum milliseconds between requests to one host.
  --db <path>            SQLite file. Default: from DATABASE_PATH.
  --trigger <name>       Recorded on the crawl_runs row. manual | scheduled | backfill.
  --log-level <level>    error | warn | info | debug. Default: from LOG_LEVEL.
  --help                 Show this message.

Nothing is merged onto a lead unless the page is confidently the same business:
its own domain, a shared decisive identifier, or a name match in the same place
with corroboration behind it. Anything less confident is queued for review in
\`enrichment_suggestions\`; anything unconvincing is discarded with a reason.
`;

export interface EnrichCliArgs {
  readonly path: EnrichmentPath;
  readonly leadIds: readonly number[];
  readonly limit: number | null;
  readonly staleDays: number | null;
  readonly budget: number | null;
  readonly delayMs: number | null;
  readonly db: string | null;
  readonly trigger: string;
  readonly logLevel: LogLevel;
  readonly help: boolean;
}

const PATHS: readonly EnrichmentPath[] = ['own-site', 'search', 'both'];

/** Exported for the unit test — parsing is pure and worth pinning down. */
export function parseArgs(argv: readonly string[]): EnrichCliArgs {
  const leadIds: number[] = [];
  let path: EnrichmentPath = DEFAULT_ENRICHMENT_PATH;
  let limit: number | null = null;
  let staleDays: number | null = null;
  let budget: number | null = null;
  let delayMs: number | null = null;
  let db: string | null = null;
  let trigger = 'manual';
  let logLevel = parseLogLevel(process.env.LOG_LEVEL);
  let help = false;

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
      case '--path': {
        const value = valueOf(flag, index) as EnrichmentPath;
        if (!PATHS.includes(value)) {
          throw new ScraperError(`--path must be one of ${PATHS.join(', ')}, got \`${value}\``);
        }
        path = value;
        index += 1;
        break;
      }
      case '--lead':
        leadIds.push(number(flag, valueOf(flag, index)));
        index += 1;
        break;
      case '--limit':
        limit = number(flag, valueOf(flag, index));
        index += 1;
        break;
      case '--stale-days':
        staleDays = number(flag, valueOf(flag, index));
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
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new ScraperError(`unknown option \`${flag}\`. Run with --help.`);
    }
  }

  return { path, leadIds, limit, staleDays, budget, delayMs, db, trigger, logLevel, help };
}

/** How long a lead stays enriched before it is worth another look. */
export const DEFAULT_STALE_DAYS = 30;

/** The lines a human actually reads after an enrichment run. */
export function formatSummary(summary: EnrichSummary): string {
  const seconds = (summary.wallTimeMs / 1000).toFixed(1);
  const fields = Object.entries(summary.fieldsAdded)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([field, count]) => `${field} ${count}`)
    .join(', ');
  const rejections = Object.entries(summary.rejections)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');

  const lines = [
    `enrichment: ${summary.status} in ${seconds}s`,
    `  leads       selected ${summary.targetsSelected}, processed ${summary.leadsProcessed}, ` +
      `enriched ${summary.leadsEnriched}, gained a first phone ${summary.leadsGainedFirstPhone}`,
    `  pages       fetched ${summary.pagesFetched}, merged ${summary.pagesMerged}, ` +
      `suggested ${summary.pagesSuggested}, rejected ${summary.pagesRejected}`,
    `  fields      ${fields === '' ? 'none added' : fields}`,
    `  suggestions ${summary.suggestionsQueued} queued for review`,
    `  rejections  ${rejections === '' ? 'none' : rejections}`,
    `  score       +${summary.scorePointsAdded} points across enriched leads`,
    `  requests    ${summary.requests} of ${summary.budget} budget, ` +
      `${(summary.rateLimitWaitMs / 1000).toFixed(1)}s spent being polite`,
  ];
  if (summary.stoppedBecause !== null) lines.push(`  stopped     ${summary.stoppedBecause}`);
  return lines.join('\n');
}

function configFrom(args: EnrichCliArgs): ConfigOverrides {
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

  const log = createLogger({ level: args.logLevel });
  const db: Db = openDatabase(args.db === null ? {} : { url: args.db });

  try {
    const summary = await runEnrichment({
      db,
      log,
      path: args.path,
      limit: args.limit,
      trigger: args.trigger,
      config: configFrom(args),
      select: {
        ...(args.leadIds.length === 0 ? {} : { leadIds: args.leadIds }),
        stalenessMs: (args.staleDays ?? DEFAULT_STALE_DAYS) * 24 * 60 * 60 * 1000,
      },
    });
    console.log(formatSummary(summary));
    return 0;
  } catch (error) {
    console.error(`enrichment failed — ${(error as Error).message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
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
