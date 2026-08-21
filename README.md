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

Three commands from a fresh clone to a working UI, with no migration to run by
hand, no seed script and no env file to author:

```bash
npm install
gunzip -c ~/Downloads/leads.sqlite.gz > data/leads.sqlite   # the pilot database, attached to FUZZ-22
npm run dev                                                 # http://localhost:3000
```

`npm run dev` applies any pending migrations to that file on the first request,
so a database taken before a schema change is brought forward rather than
failing mid-render. If the file is missing or unusable the server says which
path it looked at and what to do about it, instead of quietly serving an empty
database. Point `DATABASE_PATH` somewhere else to use a different file.

### The five views

| Route          | What it is for                                                                               |
| -------------- | -------------------------------------------------------------------------------------------- |
| `/`            | Dashboard — leads by type, phone coverage, per-source yield, growth, and coverage gaps       |
| `/leads`       | Lead list — server-side search, filter, sort and pagination over the whole dataset           |
| `/leads/<id>`  | Lead detail — every phone, channel and source URL with its provenance, evidence and history  |
| `/merges`      | Merge review queue — the pairs dedup scored as `review`, side by side, with merge and reject |
| `/suggestions` | Enrichment suggestions — medium-confidence findings awaiting accept or reject                |

Filters live in the URL, so a filtered list is a link worth bookmarking:
`/leads?opstina=beograd&phone=yes&type=CONSTRUCTION_MATERIAL_STORE&sort=score`.

### A human decision is never overwritten by a crawl

Every action the UI takes — an edit, a merge, a rejection, a status change —
writes provenance recording that a human made it. A corrected field is stored as
a claim from the `manual-review` source and promoted onto the lead; the value it
replaced keeps its own provenance and is shown next to it. Because `upsertLead`
fills blanks and never clobbers, the next crawl records its differing value as a
conflict and cannot take the field back. `src/lib/review/decisions.test.ts`
asserts exactly that, and `scripts/fuzz25-e2e.ts` asserts it again end-to-end
through the browser against a real database.

Merges are transactional, write `merge_log` with a snapshot, and are reversible
from the surviving lead's detail page. A rejected pair keeps its status, so the
next dedup sweep does not re-propose a question a human has already answered.

Production build:

```bash
npm run build && npm start
```

> `dev` and `build` pass `--webpack`. `src/lib` is written in the NodeNext ESM
> style — every relative import carries the `.js` extension it will have at
> runtime — and resolving that in a bundler needs `experimental.extensionAlias`,
> which Turbopack does not support. See the comment in `next.config.ts`.

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
src/lib/review/        the review UI's read models and its human decision layer
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
