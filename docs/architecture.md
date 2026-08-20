# Architecture and conventions

The rules a change to this repository has to hold to. They exist so that later
work inherits them from the code rather than from an issue thread.

## The one-line version

**SQLite is the system of record. XLSX is a generated artifact. The phone number
is the primary deliverable. Merge, never delete.**

## Layering

```
  app/                      src/scraper/
  (Next.js review UI)       (CLI, orchestration, source adapters)
        \                        /
         \                      /
          -----> src/lib <-----
             (shared domain code — pure, no network)
                   |
              src/lib/db
          (Drizzle schema + repositories)
                   |
             data/*.sqlite
```

Both surfaces depend on `src/lib`. `src/lib` depends on neither. There is no
edge from `src/lib` back up to `app/` or `src/scraper/`, and no edge between
`app/` and `src/scraper/`.

**Consequence:** any rule both the scraper and the UI need is written once, in
`src/lib`, with tests. If you find yourself copying a normalization detail into a
route handler or an adapter, it belongs in `src/lib` instead.

## Where normalization lives

All of it in `src/lib`, none of it in an adapter and none of it in a component.

| Concern                        | Home                | Note                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whitespace + diacritic folding | `src/lib/text`      | `građevinski` / `gradjevinski`, `Čačak` / `Cacak`. Every query exists in both forms.                                                                                                                                                                              |
| Phone parsing                  | `src/lib/phone`     | `libphonenumber-js`, region `RS`. Canonical `+381641234567`. Landlines (011, 021, 018, 034, …) and mobiles (060–069) alike. **The raw original string is always preserved alongside the canonical one.**                                                          |
| Names, addresses, cities       | `src/lib/normalize` | Company names are preserved in Serbian, never translated or "cleaned" into a different name. `normalizeCompanyName(name).ascii` is the value written to `leads.name_normalized`; `resolveCity` returns the `data/serbia-geo.json` slugs, or `null` with a reason. |
| Emails, website URLs           | `src/lib/normalize` | Domain extraction feeds dedup.                                                                                                                                                                                                                                    |

A source adapter that needs a new rule adds it here, with tests, and calls it.

## The adapter boundary

An adapter is given a source and a page; it returns **raw records** and nothing
more. **Adding a source means writing one directory under
`src/scraper/sources/`** — nothing shared is edited to register it. The contract
lives in `src/scraper/types.ts`; `docs/writing-an-adapter.md` walks through
building one end to end.

1. Fetch (through `ctx.http`, which enforces `robots.txt`, the User-Agent, the
   per-host rate limit, the retry ladder and the per-run request budget — an
   adapter cannot opt out, and can only ask to be gentler).
2. Parse — a **pure function of the response body**, tested against saved
   fixtures, never against the live site. A selector that matches nothing
   **raises `StructureChangedError`**; it never yields zero leads quietly.
3. Validate with the zod schema in `src/scraper/raw-lead.ts` **at the boundary**.
   The schema sits with the contract rather than in `src/lib` because `RawLead`
   is the scraper's input shape and nothing in `app/` has any use for it. A
   record that fails is reported in the run log and archived in `raw_records`,
   never silently dropped.
4. Attach provenance: source id and the exact source URL, for every record.
5. Return. `src/scraper/pipeline.ts` normalizes, deduplicates, classifies and
   scores, calling `src/lib` for every one of those rules.

An adapter never canonicalizes a phone, never decides a lead's type, never
merges and never writes to the database.

## Deduplication

Signal strength, strongest first:

1. normalized phone
2. website domain
3. email
4. company name + city
5. address

**Never merge on a vaguely similar name alone.** `nameSimilarity` scores a pair
0–1 and `RECOMMENDED_NAME_MATCH_THRESHOLD` says where the measured separation
between same-business and different-business pairs sits — but the score is one
signal among five, and the module that produces it never merges anything. Two
locations of the same business are a real case and are represented as such, not
collapsed.

**Merge, never delete.** A merged lead keeps every phone, every source URL and
every field either side had. Where two sides disagree on a single-valued field,
the conflict is _recorded_ — both values with their provenance — not silently
resolved in favour of whichever was written last.

## Provenance

Per record **and per field**. Every value knows:

- which source produced it (source id)
- the exact URL it was seen at
- `first_seen_at`, `last_seen_at`, `last_scraped_at`

This is what makes a re-run incremental (update, don't re-insert), what makes a
merge auditable, and what makes ZZPL deletion-on-request possible.

## Classification and scoring

- Classification is one of `FACADE_CONTRACTOR`, `CONSTRUCTION_MATERIAL_STORE`,
  `BOTH`, `UNKNOWN`. Clearly irrelevant companies stay out of the export.
- **The lead score measures data completeness and relevance, not purchase
  likelihood.** Do not smuggle a sales heuristic into it.

## Database

Every table, the merge rules and the provenance rules in prose:
**`docs/data-model.md`**.

- Schema and migrations live in `src/lib/db`. **Every schema change goes through
  a Drizzle migration** — never a hand-edited database file.
- **Keep the Postgres door open.** No SQLite-only SQL where a portable form
  exists; Drizzle should keep a later move a driver swap.
- Reads and writes go through repository functions, not raw SQL scattered
  through route handlers and scripts.
- `better-sqlite3` is server-side only. It is declared in
  `serverExternalPackages` in `next.config.ts` and must never enter a client
  component's import graph.

## Language

English for code, comments, docs, commit messages and issue text. Serbian for
search queries, preserved company names, and the XLSX column headers (`Naziv`,
`Telefon`, `Grad`, `Opština`, …) — a salesperson reads that file.

## Compliance (ZZPL)

Many fasaderi are sole traders, so a business phone is personal data.

- Collect only what a business has published publicly about itself, for
  business-contact purposes.
- Respect `robots.txt` and rate limits; identify the crawler honestly via
  `SCRAPER_USER_AGENT` / `SCRAPER_CONTACT_EMAIL`.
- Never scrape behind a login. Never solve or bypass a CAPTCHA.
- The schema must support per-field provenance and deletion of a record on
  request.

## Cost policy

Free sources first. **No paid API is called without an explicit go-ahead in the
issue.** Google Places is deferred and will be decided with measured yield
numbers, not assumptions. ScrapeGraph has no credits provisioned — nothing may
depend on it.

## Testing

Every pure function — normalization, dedup scoring, classification, lead
scoring, validation — ships with a unit test table covering the messy real
cases, not just the happy path:

- Serbian phone formats: `064 123 4567`, `064/123-4567`, `+381 64 123 4567`,
  `00381 64 123 4567`, `381641234567`, and landlines
- names with and without diacritics
- businesses with two locations
- near-duplicate company names

Adapter parsers are tested against saved fixtures. Tests never hit the network.
