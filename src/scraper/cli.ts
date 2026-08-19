#!/usr/bin/env node
/**
 * Scraper CLI entrypoint.
 *
 * Stub for now: it parses nothing and scrapes nothing, it prints the argument
 * surface the run orchestrator will implement so the shape is agreed before the
 * first adapter lands. Run it with `npm run scrape -- --help`.
 */

const USAGE = `serbia-facade-lead-engine — scraper CLI (stub)

Usage:
  npm run scrape -- [options]

Planned options:
  --source <id>          Run one source adapter (repeatable). Default: every enabled source.
  --list-sources         Print the registered source adapters and exit.
  --city <name>          Restrict the run to one city (repeatable). Default: the full geo dataset.
  --query <term>         Restrict the run to one search term (repeatable).
  --limit <n>            Stop after n results per source. Useful for smoke runs.
  --since <ISO date>     Only re-scrape leads whose last_scraped_at is older than this.
  --dry-run              Scrape and normalize, but write nothing to the database.
  --concurrency <n>      Parallel in-flight requests per source. Default: from SCRAPER_CONCURRENCY.
  --db <path>            SQLite file to write. Default: from DATABASE_PATH.
  --export <path>        Write the XLSX export after the run finishes.
  --log-level <level>    error | warn | info | debug. Default: from LOG_LEVEL.
  --help                 Show this message.

Runs are incremental: an existing lead is updated and its provenance extended,
never re-inserted. Nothing is deleted — duplicates are merged.
`;

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(USAGE);
    return 0;
  }

  console.log(USAGE);
  console.log(`Not implemented yet. Received arguments: ${JSON.stringify(argv)}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
