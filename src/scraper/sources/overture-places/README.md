# `overture-places` — geographic discovery for the whole country

The free local-business discovery mechanism FUZZ-8 recommended: the **Overture
Maps Foundation places theme**, queried directly off public object storage. One
scan of a pinned monthly release produces the national record set; the adapter
then walks it as `municipality × query arm` scopes so that coverage is measured
per municipality rather than assumed.

Measured on release `2026-08-19.0`, national sweep, no `--city` filter:

|                                               |                                                |
| --------------------------------------------- | ---------------------------------------------- |
| Records emitted                               | **1,718**                                      |
| With a phone (as published)                   | **1,633** (95.1%)                              |
| With a phone the pipeline could parse         | **1,629** (94.8%)                              |
| With a website                                | 1,132 (65.9%)                                  |
| With an email                                 | 1,254 (73.0%)                                  |
| Website but no phone (enrichment worklist)    | 31                                             |
| **Local self-government units reached**       | **120 of 145** (82.8%)                         |
| Units with at least one phone                 | 119 of 145                                     |
| Records no municipality could be resolved for | 5                                              |
| Leads after dedup                             | 1,639 created, 79 merged into an existing lead |
| Requests to the service, second run onwards   | 1                                              |

By priority tier — tier 1 is the 20 largest units, tier 3 the small ones, which
is where a geographic mechanism has to prove itself:

| Tier | Units | Reached   | Records | With phone |
| ---- | ----- | --------- | ------- | ---------- |
| 1    | 20    | 20 (100%) | 1,171   | 1,118      |
| 2    | 51    | 50 (98%)  | 410     | 394        |
| 3    | 74    | 50 (68%)  | 132     | 124        |

## Why this and not Overpass

The issue expected OpenStreetMap via Overpass. Two independent reasons it is not
that, both checked rather than assumed.

**`overpass-api.de/robots.txt`, fetched 2026-08-20:**

```
User-agent: *
Disallow: /api/
Disallow: /munin/
```

`/api/interpreter` is the query endpoint. This project obeys `robots.txt` with
no override, and the framework enforces that with no adapter-side opt-out
(`respectRobots: false` from an adapter is ignored), so an Overpass adapter
could not issue a single query. The Overpass **commons** page is equally clear
about what the public instances are for:

> The public instances await your queries. They offer as much resources as
> possible, but they also defend themselves against overuse. Heavy users easily
> can set up their own instance. […] Examples of problematic behaviour: […]
> Stiching bounding boxes to scrape the full data of the complete world.
>
> — <https://dev.overpass-api.de/overpass-doc/en/preface/commons.html>

A 162-unit national sweep is exactly the shape it names. Running our own
instance is the sanctioned route and is a piece of infrastructure, not an
adapter.

**And the data is not there anyway.** FUZZ-8 executed the queries: across the
whole country OSM holds 4 elements under `craft=plasterer|painter|builder` with
1 phone between them, and 794 shop-side elements at 43% phone coverage. The
entire Serbian `craft=*` census is 697 businesses. Overture returns 1,718
relevant Serbian records at 95% phone coverage from one request.

One licence note, since the two are sometimes treated as interchangeable: OSM is
ODbL and merging it into this database could pull share-alike obligations onto
the whole thing. The places theme carries no OSM data.

## The service's stated policy

The data is public, anonymous, key-less object storage in the AWS Open Data
programme — `s3://overturemaps-us-west-2`, reachable over HTTPS. There is no
published rate limit and no crawl-delay to honour, and `robots.txt` on that
origin is a **404**, which the framework's own rule reads as allow-all. The
adapter asks for that verdict through `ctx.http.robotsVerdict()` before any
parquet byte is read, so it is a checked fact and not an assumption.

The binding terms are licensing, not throttling. Per
<https://docs.overturemaps.org/attribution/>, the places theme is:

> **Places** — Data from Meta. Available under **CDLA Permissive 2.0**. Data
> from Microsoft. Available under CDLA Permissive 2.0. Data from PinMeTo […]
> Data from Foursquare. Copyright 2024 Foursquare Labs, Inc. All rights
> reserved. Available under **Apache 2.0** […] Data from AllThePlaces. Available
> under **CC0 1.0**.

and the citation Overture asks for:

> Overture Maps Foundation, overturemaps.org

Every licence in that list permits storage and redistribution — which is the
whole reason this project can keep the phone numbers, and the reason the Google
Places API cannot be used no matter what it costs (FUZZ-8, §5). The source mix
of this extract is `meta` 1,690, `Microsoft` 19, `Foursquare` 9; if the export
ever ships externally, the 9 Foursquare-derived records carry the Apache-2.0
`NOTICE` requirement.

### What the adapter does about politeness anyway

|                             |                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Requests through `ctx.http` | **1 per run** — the ListObjectsV2 call that proves the pinned release still exists                |
| Parquet scan                | **once per release**, then cached to disk forever                                                 |
| `requestDelayMs`            | 2,000 (gentler than the 1,500 default; there is one request to space out)                         |
| `requestBudget`             | 50 (a fuse — the adapter should never need more than 2)                                           |
| DuckDB `http_retries`       | 5, with `http_retry_wait_ms = 500` and DuckDB's exponential backoff                               |
| DuckDB `threads`            | 4 — a handful of concurrent range requests, not a fan-out                                         |
| User-Agent                  | the project's, passed to DuckDB as `custom_user_agent` so the parquet range requests carry it too |

The scan reads ~15 MB of a 10.4 GB global dataset because the `bbox` predicate
matches the parquet row-group statistics. It took **64 s** on the measured run.

## The cache

`data/cache/overture-places/<release>/places.ndjson`, with a `manifest.json`
holding the release, the SHA-256 prefix of the SQL that produced it, the row
count and the wall time. A run whose release **and** query hash match the
manifest reads the file and makes no request at all — editing a category or the
name pattern changes the hash and re-runs the scan, so a cache can never answer
a question it was not asked. `OVERTURE_CACHE_DIR` moves the directory.

Second and subsequent national sweeps: **8 seconds, one HTTP request.**

## How the query is built

Two arms, both measured (`query.ts` carries the same reasoning next to the code):

- **Category** — `taxonomy.primary` in 16 categories, 10 contractor-side and 6
  store-side.
- **Name** — a Serbian-term regex over `names.primary`, which adds **70 records
  (65 with a phone)** that the categories miss entirely: `Stovariste Bihorac`
  filed under `shopping`, `Euro Okov građevinski materijal` under `retail`,
  `DMR Hidroizolacija Niš` under `professional_service`.

Two arms tried and rejected, so they are not re-added on a hunch:

- **`taxonomy.hierarchy` instead of `taxonomy.primary`** — +1,805 records, and
  they are furniture and lighting stores that merely share an ancestor node.
- **The Cyrillic spelling of the name regex** — +3 records, all of them schools.
  Overture's Serbian business names are written in Latin. (The project rule that
  every query exists in both spellings is about search engines and directories;
  here it was tested and it does not pay.)

**No `confidence` filter**, which is a deliberate departure from the FUZZ-8
implementation note that suggested `confidence >= 0.3`. Measured on this
release, that cut drops **379 phone-bearing records — 23% of the entire phone
yield** — and what it drops are businesses like `Pejos Gradnja doo` and
`Integral Build Farbara i Stovarište`. Overture's confidence measures source
agreement, not relevance, and this project does not discard a phone number over
it. The value is emitted on every record as `extra.confidence` so scoring and
review can weigh it.

## Municipality assignment, and where it fails

Overture carries `addresses[1].locality` on 1,714 of 1,718 records, often in
Cyrillic (`Куршумлија`). Assignment prepends the postcode and hands the string
to `resolveCity()` from `src/lib/normalize` — the Data Engineer's resolver, not
a second implementation of it. **This decides which scope a record is discovered
under; it does not fill a field.** The `RawLead` still carries the locality
exactly as published, and the pipeline resolves it again on the way to the
database.

Five records resolve to nothing and are filed under `mun:unassigned|arm:*`
rather than guessed at: two with no locality at all, two villages the settlement
dataset does not list (`Малошиште`, `Joseva`), and one `Petrovac`, which
`data/serbia-settlements.json` omits on purpose because the name is ambiguous
across municipalities. A wrong municipality is worse than an empty one — the
lead keeps its phone either way, and 3 of the 5 do carry one.

## Per-municipality yield in the database

Every scope writes its yield to `crawl_state.cursor` as JSON, including the
scopes that yielded nothing — which is the point, since a unit this mechanism
does not reach is exactly what a later source has to be pointed at:

```sql
SELECT scope_key, json_extract(cursor, '$.municipalityId') AS municipality,
       json_extract(cursor, '$.records')   AS records,
       json_extract(cursor, '$.withPhone') AS phones
FROM crawl_state
WHERE source_id = 'overture-places' AND scope_key LIKE 'scope:mun:%'
ORDER BY records ASC;
```

438 rows: 145 units plus the unassigned bucket, times three arms. The 25 units
with no record at all on this release:

`babusnica bela-palanka bojnik bosilegrad brus coka crna-trava doljevac
gadzin-han knic knjazevac koceljeva kosjeric krupanj lebane lucani majdanpek
medvedja mionica nova-crnja nova-varos rekovac trgoviste vladimirci zabari`

## Failing loudly

A dataset does not 404 when it changes shape, so three checks stand in for the
selector assertions an HTML adapter would make:

1. **The release listing returns no parquet parts** → `StructureChangedError`.
   S3 answers a missing prefix with an empty 200, so this is the only signal
   that the pin is stale.
2. **A truncated listing** → `StructureChangedError`. A partial part list would
   silently produce a smaller Serbia.
3. **A missing column** → the extract is refused before the scan is paid for.
   Overture moved `categories.primary` to `taxonomy.primary` in December 2025;
   the next such move fails on the first request instead of returning a healthy
   zero.
4. **An extract that parses to zero rows, or a row the parser cannot read** →
   `StructureChangedError`.

## Running it

```bash
npm run scrape -- --source overture-places --dry-run --limit 20   # writes nothing
npm run scrape -- --source overture-places                        # national sweep
npm run scrape -- --source overture-places --city novi-sad        # one municipality
```

A new monthly release is a one-line change to `RELEASE` in `dataset.ts` (or
`OVERTURE_RELEASE` in the environment), after which the next run re-scans once
and re-caches. Item staleness is keyed on the GERS id, not the URL, so a new
release re-emits only what actually changed rather than the whole country.

## Known gaps

- **25 small municipalities hold no Overture record at all**, and tier 3 sits at
  68% coverage against 100% for tier 1. This mechanism reaches well beyond
  Belgrade — 72% of records are outside it — but it does not reach everywhere,
  and those 25 units are the worklist for directory city-iteration and the
  enrichment crawler.
- **Classification is mostly `UNKNOWN`** — 121 store, 2 contractor, 1,517
  unknown. `src/lib/classify` reads a Serbian lexicon and Overture publishes an
  English taxonomy slug, so only businesses whose _name_ carries a Serbian trade
  term are labelled. Teaching the classifier the 16 Overture category slugs is a
  `src/lib/classify` change (Data Engineer), not an adapter one — an adapter
  that translated its source's categories would be classifying.
- **One record duplicates across runs.** A row with no phone, no website, no
  email and no resolvable city has nothing for `upsertLead` to match on, so a
  re-run creates a second lead for it (1 of 1,718). That is a dedup-path
  question for `src/lib/dedup`, raised on the issue.
