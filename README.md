# Serbia Facade Lead Engine

A lead-generation and web-scraping system that discovers **facade contractors**
and **construction-material stores** across Serbia, stores them in a normalized
local database, and exposes them through a React review UI plus an XLSX export
for phone-first sales outreach.

The product being sold is a prefabricated EPS/styrofoam facade panel with an
integrated finished facade layer — a 2-in-1 replacement for the multi-step ETICS
process. The market is Serbia only, and the two buyer groups are:

| Type                          | Who                                                                 |
| ----------------------------- | ------------------------------------------------------------------- |
| `FACADE_CONTRACTOR`           | fasaderi, facade installation companies, independent facade workers |
| `CONSTRUCTION_MATERIAL_STORE` | građevinska stovarišta, building-supply yards, distributors         |

**The phone number is the primary deliverable.** A lead with only a name, a city
and a phone is a good lead — nothing is discarded for a missing email.

## Requirements

- **Node 20.9+** (ESM, TypeScript strict)
- npm

## Install

```bash
git clone https://github.com/pupovac/serbia-facade-lead-engine.git
cd serbia-facade-lead-engine
npm install
cp .env.example .env.local   # then fill in SCRAPER_CONTACT_EMAIL
```

`better-sqlite3` is a native module; `npm install` fetches a prebuilt binary for
supported Node versions and falls back to compiling from source.

Playwright is only needed for sources that require JS rendering. Install its
browser when you first hit one:

```bash
npx playwright install chromium
```

## Run a scrape

```bash
npm run scrape -- --help          # the argument surface
npm run scrape -- --list-sources  # registered source adapters
npm run scrape                    # every enabled source
npm run scrape -- --source <id> --city Čačak --limit 50
```

Runs are **incremental**: an existing lead is updated and its provenance
extended, never re-inserted, and duplicates are merged rather than deleted. The
database is written to `DATABASE_PATH` (default `./data/leads.sqlite`).

> The CLI is currently a stub that prints its planned arguments. Source adapters
> and the run orchestrator land in the Stage 2 issues.

## Open the review UI

```bash
npm run dev     # http://localhost:3000
```

The dashboard lists leads, shows where every field came from, and lets a human
correct a classification. Production build:

```bash
npm run build && npm start
```

## Generate the XLSX export

```bash
npm run scrape -- --export ./exports/leads.xlsx
```

or from the review UI's export action. The spreadsheet uses Serbian column
headers (`Naziv`, `Telefon`, `Grad`, `Opština`, …) because a salesperson reads
it. **The XLSX is a generated artifact — SQLite is the system of record, and
nothing may live only in a spreadsheet.**

## Scripts

| Script                 | What it does                         |
| ---------------------- | ------------------------------------ |
| `npm run dev`          | Next.js dev server for the review UI |
| `npm run build`        | Production build of the review UI    |
| `npm start`            | Serve the production build           |
| `npm run typecheck`    | `tsc --noEmit` over the whole tree   |
| `npm run lint`         | ESLint                               |
| `npm run test`         | Vitest unit tests                    |
| `npm run format`       | Prettier, write                      |
| `npm run format:check` | Prettier, check only                 |
| `npm run scrape`       | The scraper CLI                      |

## Repository layout

```
src/lib/               shared domain code — schema, normalization, dedup, scoring
src/scraper/           CLI entrypoint and run orchestration
src/scraper/sources/   one directory per source adapter
research/              committed research artifacts
data/                  geo + query datasets (committed); *.sqlite (gitignored)
app/                   Next.js review UI (App Router)
docs/                  architecture and conventions
```

Each of those directories has its own `README.md` stating what belongs in it.
The layering rules, the adapter boundary and where normalization lives are in
[`docs/architecture.md`](docs/architecture.md) — read it before adding code.

## Stack

TypeScript (strict, ESM) · Next.js App Router · better-sqlite3 + Drizzle ORM ·
cheerio (+ Playwright where JS rendering is genuinely required) ·
libphonenumber-js (region `RS`) · zod · exceljs · vitest · ESLint · Prettier.

## Compliance

Many fasaderi are sole traders (preduzetnici), so a business phone is personal
data under Serbia's ZZPL. We only collect data a business has published publicly
about itself, for business-contact purposes. We respect `robots.txt` and rate
limits, identify the crawler honestly, never scrape behind a login, and never
solve or bypass a CAPTCHA. The schema supports per-field provenance and record
deletion on request. See [`docs/architecture.md`](docs/architecture.md).

## Contributing

Conventions, the definition of done and the PR checklist are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).
