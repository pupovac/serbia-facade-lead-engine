# The lead data model

The schema every other component reads and writes. Definitions live in
`src/lib/db/schema.ts`, the migration in `drizzle/`, and every read and write
goes through `src/lib/db/repo.ts`.

## The one idea the shape follows from

The same business arrives from several sources, with conflicting spellings and
partial data, over and over as runs repeat. So **nothing here stores "the
value". Everything stores a claim**: who said it, at which URL, when it was
first seen and when it was last seen.

`Fasader Plus d.o.o.` on Portal Srbija and `FASADER PLUS DOO` on Na vidiku are
not a spelling problem to be resolved at write time. They are two claims about
one business, both true about what a source published, and the database keeps
both. The single clean row per business that the review UI and the XLSX export
need is _derived_ from those claims — it is not typed in over them.

Four properties follow:

| Property                      | How the schema gets it                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Merge, never delete           | Merged leads keep their row; children move; `merge_log` holds a reversible snapshot |
| Phones are the identifier     | `lead_phones` holds canonical + raw, one row per claiming source, indexed on `e164` |
| Provenance is per field       | `lead_field_values`, one row per (field, value, source); conflicts are rows         |
| A parser bug destroys nothing | `raw_records` keeps the untouched payload, so re-normalizing needs no re-crawl      |
| One bad value cannot cascade  | `shared_identifiers` quarantines a value spread across too many businesses          |
| A decision can be deferred    | `merge_candidates` holds the pairs a human decides, and remembers a rejection       |

## The tables

### `sources` — the Stage 1 registry, as rows

One row per data source, keyed by the same slug the research registries use
(`portal-srbija`, `austrotherm-distributeri`), so a `source_id` anywhere in this
schema is greppable in `research/`. `npm run db:setup` seeds it from
`research/sources-contractors.json` and `research/sources-stores.json`; three
sources appear in both and become one row whose segment flags are the union.

Rejected sources stay here with `enabled = false`. Knowing a source was
evaluated and dropped is worth as much as knowing it was kept.

`robots_allows` is nullable on purpose. The contractor registry states the
verdict as a sentence, the store registry as a boolean, and sometimes the
research could not tell. `null` means **unknown, not allowed** — a crawler that
reads unknown as permission is exactly the compliance failure this project
cannot have.

### `leads` — the merged business entity

One row per business, holding the values currently promoted from
`lead_field_values`. Reading a lead never requires reconstructing it from
claims; that is what makes "one clean row per business" cheap.

- `name` is Serbian, exactly as published — never translated, never "cleaned".
  `name_normalized` is the folded comparison key and is never shown to a user.
- `city_id` and `municipality_id` are slugs from `data/serbia-geo.json`, not
  foreign keys: the geo dataset is a versioned reference file loaded through
  `src/lib/geo.ts`, not a table. `city_id` is the most specific unit matched
  (`beograd-vracar`); `municipality_id` is the local self-government unit it
  rolls up to (`beograd`). Outside Belgrade they are the same slug. `city_raw`
  keeps the place string as the source published it, before matching.
- `classification` is `FACADE_CONTRACTOR` | `CONSTRUCTION_MATERIAL_STORE` |
  `BOTH` | `UNCLASSIFIED` | `OUT_OF_SCOPE`, enforced by a `CHECK` in the
  database, not only by TypeScript. The last two are not one label with two
  moods: `UNCLASSIFIED` means the classifier found nothing either way and the
  record is still worth enriching, `OUT_OF_SCOPE` means it found evidence of a
  trade we do not sell to and none of one we do. Only `OUT_OF_SCOPE` carries
  `classification_industry`, which records the trade so the exclusion can be
  audited and argued with rather than being a row that quietly vanished.
  Neither reaches the export.
- `relevance_score` and `contactability_score` are two independent 0–100
  numbers, separately indexed and separately sortable. Relevance is the label,
  its confidence and the evidence behind it; contactability is how much contact
  data the row holds. Neither reads the other's inputs. `lead_score` survives as
  a derived convenience column, `relevance × contactability / 100`, for the
  export's single sort key. None of the three is a purchase-likelihood guess,
  and nothing may smuggle a sales heuristic into them.
- `merged_into_id` is set when this lead was merged away. The row stays, so
  every id ever handed out keeps resolving.

### `lead_phones` — the primary deliverable

**A row is one source's claim about one number, not a number.** Two directories
that both list `064/123-4567` produce two rows: they disagree about the raw
formatting, and the count of distinct sources claiming a number is a real
corroboration signal that feeds the lead score.

- `e164` is the canonical `+381641234567`, produced by `src/lib/phone`.
- `raw` is exactly what the source published — `064/123-4567`,
  `+381 64 123 4567`, `00381641234567` — and is never overwritten.
- `national_format` is the form a Serbian salesperson dials.
- A number `libphonenumber-js` rejects is kept with `valid = false` rather than
  dropped. A lead is never discarded for a bad phone, and the raw string is the
  only evidence of what the source actually published.

`repo.distinctPhones()` collapses the claims into the list a human sees, in one
place, so the UI and the export do not each invent the rule.

### `lead_contacts` — emails, websites, social profiles

Same claim-shaped rule, unique on (lead, kind, value, source). `domain` holds
the registrable domain of a website or the host part of an email, extracted at
write time because dedup looks it up on every insert and a trailing `LIKE` is
not an index.

### `lead_field_values` — per-field provenance, and the conflicts

The claim log for the single-valued facts on `leads`: name, address, city,
classification, registration number and the rest.

Exactly one claim per (lead, field) carries `is_current = true` and mirrors the
`leads` column. Any other distinct value for that field **is** the recorded
conflict, preserved with its own source, URL and timestamps.
`repo.fieldConflicts()` is what the review UI reads to show a reviewer both
values; `repo.promoteFieldValue()` applies their choice. Nothing is silently
resolved in favour of whoever wrote last.

### `lead_sources` — lead ↔ source, at the exact URL

**Never collapsed.** One row per (lead, source, URL): the same business listed
on three pages of one directory is three rows, and a business seen by four
independent directories is four sources. "How many independent sources saw this
business" feeds both the lead score and the confidence of a merge, and neither
can be recovered once this is flattened.

A re-run updates `last_seen_at`, `last_scraped_at` and `times_seen`. It does not
insert.

### `raw_records` — the untouched adapter payload

What the adapter emitted, before normalization, exactly as it emitted it. This
is the insurance policy against a parser bug: re-normalizing the whole database
is a local operation over this table, not a re-crawl of every source.

It is also where a record that failed the zod boundary lands, with its
validation error, so "rejected" is inspectable instead of lost.
`(source_id, content_hash)` is unique, so a re-run of an unchanged page bumps
`seen_count` rather than accumulating identical copies.

### `crawl_runs` and `crawl_state` — incremental bookkeeping

`crawl_runs` is one row per adapter execution: what ran, when, how many requests
it made, how many records it emitted, how many were rejected, how many leads it
created and updated. These are the numbers a run report quotes.

`crawl_state` is where to resume — one row per (source, scope), a scope being
whatever unit the adapter paginates over: a city page, a category, a search
query. `cursor` is opaque to everything but the adapter that wrote it.
`attempts` counts every visit, so a scope that keeps failing is visible without
reading a log file.

### `merge_log` — every merge, explainable and reversible

Why two leads became one (`signal`, `signal_value`, `score`, `actor`) and enough
state to undo it. `snapshot` holds the merged-away lead's row, the survivor's
row as it was before, the ids of every child that moved, and the full rows of
any exact-duplicate claims that were absorbed.

The merge engine will sometimes be wrong — two branches of one company, two
businesses sharing an accountant's phone number. Reversibility is what makes an
aggressive dedup rule safe to try.

### `shared_identifiers` — the quarantine that stops a chain merge

One call-centre number, one marketplace domain, one directory's contact address:
each is published next to dozens of unrelated businesses, and each is a decisive
dedup signal. Left alone, one such value collapses a hundred leads into a single
row.

So every decisive value is counted against the number of **distinct businesses**
carrying it — businesses, not rows, because one fasader listed by eight
directories is eight rows and one perfectly good phone number. A value over its
limit is written here with `quarantined = true` and stops deciding anything:
`upsertLead` will not match on it, and `scoreMatch` downgrades it from decisive
to blocked. Nothing is deleted — a quarantined number is still the deliverable,
it just stops being an identity.

A `reason` of `manual` is a human's verdict and the automatic pass never
overwrites it, in either direction.

### `merge_candidates` — the review band, and the reviewer's answer

A pair the engine believes is probably one business but will not merge on its
own: a strong name match in one city with nothing corroborating it, or a
decisive signal that landed on a quarantined value.

The row exists for two reasons. It is what the review UI lists, and it is what
makes a rejection stick — without it, the next sweep would re-propose every pair
a human has already said no to. `lead_a_id < lead_b_id` always, so a pair has
one row however the sweep reached it.

The pipeline also _withdraws_ pairs: a question the quarantine has since
answered is resolved `rejected` with `resolved_by = 'pipeline'`, which is what
distinguishes it from a human's no.

### `erasure_log` and `erasure_blocklist` — ZZPL deletion on request

Many fasaderi are sole traders, so a business phone is personal data and an
erasure request has to actually erase. `repo.eraseLead()` hard-deletes the lead,
its phones, contacts, field claims, source sightings, raw payloads and merge
snapshots — the last two hold the number in full and would otherwise survive.

What remains is `erasure_log`: an id, a reason, a count, and no personal data at
all. `erasure_blocklist` holds the SHA-256 of each erased number so the next
crawl of the same directory does not quietly put the business back. Erasure
without that is theatre.

## Provenance

Every provenance-bearing table — `lead_phones`, `lead_contacts`,
`lead_field_values`, `lead_sources`, `raw_records` — carries `source_id`,
`source_url`, `first_seen_at` and `last_seen_at`. `Provenance` is a required
argument on every repository write, not an option, so there is no code path that
stores a value without knowing where it came from.

`source_url` is the exact page the value was read from, never the source's
homepage.

## The merge rules

### What `upsertLead` does

Matching runs the **exact** dedup signals only, strongest first:

1. normalized phone (`e164`)
2. website domain
3. email
4. company name + city

Each has an index; each is hit on every insert. `matchedBy` in the result says
which one fired.

Fuzzy matching — near-duplicate names, address similarity, two locations of one
business — is the merge engine's job. It runs afterwards, over stored leads, and
calls `recordMerge()`. Keeping the two apart is what stops an adapter from
silently collapsing two businesses on a weak signal.

An adapter should not call `upsertLead` directly: `dedup.ingestLead()` is the
entry point, and it applies the full rule set plus the guards below. Pass
`matching: 'caller'` if you call `upsertLead` yourself after matching.

Name + city requires a city on purpose: "Fasada Plus" in Novi Sad and "Fasada
Plus" in Niš are two businesses until something stronger says otherwise. A
record with no city never matches on name alone.

### Fill blanks, never clobber

An update sets a column only where the stored one is empty. A second, different
value for a field already filled is recorded in `lead_field_values` and counted
in `conflictsRecorded` — it is never written over the stored one.

Two deliberate exceptions: `UNCLASSIFIED` is not a classification but the
absence of one, so it upgrades once — `OUT_OF_SCOPE` is a _decision_ and a
later, thinner listing must not overwrite it; and the score columns are derived
numbers the scorer owns outright.

### What a merge does

`recordMerge()` moves every phone, contact, field claim and source URL from the
merged-away lead to the survivor, fills fields the survivor lacked from it, and
leaves the merged-away row as a tombstone with `merged_into_id` set. Only an
exact duplicate claim — same value, same source, already on the survivor — is
collapsed, and its full row is kept in the snapshot so a revert restores it.

The merged lead's promoted values arrive on the survivor as plain claims, not as
overwrites: they are exactly the conflicts a reviewer needs to see.

`resolveLead()` follows `merged_into_id`, so a lookup on a merged-away lead's
phone returns the survivor.

### Attaching and merging are different acts

An **attach** folds an incoming record into an existing lead and leaves no
`merge_log` row — there is nothing to undo. A **merge** leaves a snapshot and is
one `revertMerge()` away from being corrected.

So `ingestLead` only ever attaches a record to a lead whose name says it is the
same business. Everything else the rules would merge — a shared phone under two
unrelated names, which is either a real duplicate or the first sign of a
switchboard — is written as its own lead and left to the sweep, which runs the
quarantine first and merges reversibly. The database is briefly one row longer;
it is never irreversibly one row shorter.

### The three decisions

`merge`, `review`, `distinct`. The rules pick the band and the score is clamped
into it; inside a band the score orders the review queue. A shared phone merges
however different the names are, and a perfect name match with nothing behind it
only ever reaches `review` — so a single number doing both jobs would do
neither.

Full rule table, weights and thresholds: `src/lib/dedup/`.

## Keeping the Postgres door open

SQLite is the system of record today; the move to Postgres has to stay a driver
swap.

- Timestamps are `integer` epoch milliseconds mapped to `Date` by Drizzle — the
  one column type that means the same thing in both dialects without a cast.
  Comparison and ordering are numeric, so no `strftime` and no lexicographic
  date strings.
- Enums are `text` plus a `CHECK`, which is the same syntax in both.
- No `INSERT OR REPLACE`. The repository selects, then inserts or updates,
  inside a transaction — portable, and it yields accurate created/updated counts
  for run reporting.
- The only SQLite-only SQL in the project is the three PRAGMAs in
  `src/lib/db/client.ts` (`journal_mode = WAL`, `busy_timeout`,
  `foreign_keys = ON`). They are connection setup, not query text, and Postgres
  needs none of them — which is exactly why they live in the one file a driver
  swap replaces.

A test asserts the generated migration contains no `strftime`, `julianday` or
`INSERT OR REPLACE`.

## Changing the schema

Edit `src/lib/db/schema.ts`, then:

```
npm run db:generate     # writes a new migration into drizzle/
npm run db:migrate      # applies pending migrations to DATABASE_PATH
npm run db:setup        # migrate + reseed sources; idempotent
```

**Never hand-edit a database file, and never hand-edit a migration that has been
applied anywhere.** The unit tests run against a migrated in-memory database, so
a migration that stops applying cleanly fails every test in `src/lib/db` at
setup.
