# `src/lib` — shared domain code

Everything that decides whether a lead is trustworthy lives here, and nothing
here knows about HTTP, HTML or a specific website. Both the scraper CLI and the
Next.js app import from this directory; neither of them re-implements any of it.

## What belongs here

| Area         | What it owns                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db/`        | Drizzle schema, migrations, the better-sqlite3 connection, and the repository functions that read and write leads. See `docs/data-model.md`.                                                                                                                                                     |
| `text/`      | Whitespace and diacritic folding — the `građevinski` / `gradjevinski` pair every query and every name comparison needs.                                                                                                                                                                          |
| `phone/`     | Finding numbers on a page and canonicalizing them to `+381641234567` via `libphonenumber-js` (region `RS`), landlines and mobiles alike, always keeping the raw string. A landline area code infers a city.                                                                                      |
| `normalize/` | Turning a validated raw record into the canonical field shapes: names, addresses, cities, emails, website URLs. `name.ts` produces the display name, the matching keys and the similarity score; `city.ts` resolves free text to a `data/serbia-geo.json` slug pair, or to `null` with a reason. |
| `dedup/`     | Match scoring and the merge itself. Signal strength, strongest first: normalized phone → website domain → email → company name + city → address.                                                                                                                                                 |
| `classify/`  | `FACADE_CONTRACTOR` / `CONSTRUCTION_MATERIAL_STORE` / `BOTH` / `UNKNOWN`.                                                                                                                                                                                                                        |
| `score/`     | The lead score — data completeness and relevance, not purchase likelihood.                                                                                                                                                                                                                       |
| `export/`    | The `exceljs` XLSX writer. Serbian column headers.                                                                                                                                                                                                                                               |
| `types/`     | Shared domain types and the zod schemas adapters validate against.                                                                                                                                                                                                                               |

## Rules

- **Pure by default.** Normalization, dedup scoring, classification, scoring and
  validation are pure functions of their input and each ships with a unit test
  table covering the messy real cases, not just the happy path.
- **No I/O outside `db/`.** No `fetch`, no filesystem reads, no `process.env`
  lookups scattered through domain functions — pass configuration in.
- **Merge, never delete.** A merge keeps every phone, every source URL and every
  field either side had. Conflicts are recorded, not silently resolved.
- **Provenance is per field.** Every value knows its source, its source URL, and
  when it was first and last seen.
- **Portable SQL.** SQLite is the system of record today; do not reach for
  SQLite-only SQL where a portable form exists. Schema changes go through a
  Drizzle migration, never a hand-edited database file.
