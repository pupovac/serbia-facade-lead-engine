# `src/scraper` — CLI, framework and adapters

The scraper is the only part of the system that touches the network. It
discovers records, hands each one to the shared domain code in `src/lib`, and
writes the result to SQLite.

**Adding a new source means writing one directory under `sources/`.** Nothing
here needs editing to register it. `docs/writing-an-adapter.md` walks through
building one; `sources/example/` is the working template.

## Layout

| File             | What it owns                                                                         |
| ---------------- | ------------------------------------------------------------------------------------ |
| `cli.ts`         | `npm run scrape` — argument parsing and printing the summary, nothing else.          |
| `types.ts`       | The `SourceAdapter` contract and the `CrawlContext` an adapter is handed.            |
| `raw-lead.ts`    | `RawLead` and the zod schema every emitted record is validated against.              |
| `config.ts`      | The politeness settings, layered defaults → env → adapter → CLI.                     |
| `run.ts`         | The run loop: `crawl_runs`, resume bookkeeping, the failure policy, the summary.     |
| `pipeline.ts`    | `RawLead` → a lead: normalization, classification, scoring, provenance, persistence. |
| `crawl-state.ts` | Resume points and per-item `last_scraped_at`, in `crawl_state`.                      |
| `registry.ts`    | Finds every adapter under `sources/`. There is no list to maintain.                  |
| `http/`          | The polite fetcher: `robots.txt`, the per-host rate limiter, retries and the budget. |
| `errors.ts`      | `StructureChangedError` and the rest of the failure vocabulary.                      |
| `sources/`       | One directory per source adapter. See its README.                                    |
| `enrich/`        | Contact enrichment: a lead we already have → the rest of its contact details.        |

## Running it

```bash
npm run scrape -- --list-sources
npm run scrape -- --source example --dry-run          # discovers and extracts, writes nothing
npm run scrape -- --source example --city novi-sad --limit 50
npm run scrape -- --help
```

A run ends with the numbers worth reading: items discovered, extracted, skipped
as fresh and failed; records emitted, rejected and carrying a phone; leads
created and updated; requests spent against the budget; wall time.

## Enriching what a crawl left thin

```bash
npm run enrich -- --path own-site --limit 50    # crawl the contact pages of leads that have a website
npm run enrich -- --path search --limit 20      # look for a lead that has no website at all
npm run enrich -- --help
```

Enrichment is not an adapter and is not registered as one: it does not discover
businesses, it starts from businesses already in the database and goes looking
for the phone, the email and the address they are missing. It shares this
directory's `PoliteFetcher`, so `robots.txt`, the per-host rate limit and the
request budget apply to a stranger's hosting account exactly as they do to a
directory we crawl on purpose. `enrich/README.md` has the confidence rules.

## What does not belong here

Normalization, phone canonicalization, dedup, classification and scoring. Those
live in `src/lib` and are imported — `CrawlContext` even hands the helpers to
adapters so none of them re-implements one. If a source needs a new
normalization rule, the rule goes in `src/lib` with its own tests and the
adapter calls it.

## Rules

- Every run is incremental: an item scraped inside the staleness window is
  skipped, and an existing lead is updated and its provenance extended, never
  re-inserted.
- **A selector that matches nothing raises `StructureChangedError`.** A source
  that quietly stops producing leads is the failure this project cannot have.
- Respect `robots.txt` and rate limits. Identify the crawler honestly through
  `SCRAPER_USER_AGENT` and `SCRAPER_CONTACT_EMAIL`. The framework enforces all
  three — an adapter cannot opt out, and can only ask to be gentler.
- Never scrape behind a login, and never solve or bypass a CAPTCHA.
- No paid API is called without an explicit go-ahead in the issue.
