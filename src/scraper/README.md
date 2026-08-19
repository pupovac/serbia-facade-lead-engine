# `src/scraper` — CLI and run orchestration

The scraper is the only part of the system that touches the network. It
discovers records, hands each one to the shared domain code in `src/lib`, and
writes the result to SQLite.

## What belongs here

- `cli.ts` — the entrypoint behind `npm run scrape`. Argument parsing, nothing else.
- run orchestration — scheduling sources, concurrency, rate limiting, retries,
  `robots.txt` checks, run logging, and the incremental-run bookkeeping
  (`last_scraped_at`).
- HTTP and browser plumbing — the shared `cheerio` fetch helper and the
  `playwright` fallback for pages that genuinely require JS rendering.
- `sources/` — one directory per source adapter. See its README.

## What does not belong here

Normalization, phone canonicalization, dedup, classification and scoring. Those
live in `src/lib` and are imported. If a source needs a new normalization rule,
the rule goes in `src/lib` with its own tests and the adapter calls it.

## Rules

- Every run is incremental: an existing lead is updated and its provenance
  extended, never re-inserted.
- Respect `robots.txt` and rate limits. Identify the crawler honestly through
  `SCRAPER_USER_AGENT` and `SCRAPER_CONTACT_EMAIL`.
- Never scrape behind a login, and never solve or bypass a CAPTCHA.
- No paid API is called without an explicit go-ahead in the issue.
