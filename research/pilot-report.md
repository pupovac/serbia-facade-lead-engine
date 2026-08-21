# FUZZ-22 — pilot crawl and coverage analysis

Run date 2026-08-21, on `main` at the point where FUZZ-30 (ALL-CAPS / `Nj`/`Lj`
classification) and FUZZ-29 (Google Maps `query` parameter) had both landed.
Every classification number measured before those fixes is void; these are the
first ones worth quoting.

Every figure below is measured and re-derivable: `scripts/fuzz22-report.ts`
produces the JSON, `scripts/fuzz22-dedupe.ts` runs the sweep,
`scripts/fuzz22-spotcheck.ts` draws the sample, and
`scripts/fuzz22-phone-geo-check.ts` measures the phone/municipality
disagreement. All of them are committed.

## The headline, stated bluntly

**3,601 leads, 3,527 of them with a phone (97.9%). 49 of them are facade
contractors.**

That second number is the finding this pilot exists to produce. The system is
good at collecting Serbian construction businesses with working phone numbers,
and it is currently poor at finding the specific buyer this product is for.

|                                | Leads           | With a phone | Avg score |
| ------------------------------ | --------------- | ------------ | --------- |
| `UNKNOWN`                      | 3,046 (84.6%)   | 2,981        | 65.9      |
| `CONSTRUCTION_MATERIAL_STORE`  | 506 (14.1%)     | 497          | 73.5      |
| `FACADE_CONTRACTOR`            | 36 (1.0%)       | 36           | 79.3      |
| `BOTH`                         | 13 (0.4%)       | 13           | 81.7      |
| **Exportable (non-`UNKNOWN`)** | **555 (15.4%)** | **546**      |           |

Corpus totals: 3,623 lead rows of which 22 are merge tombstones; 7,838 phone
rows, 6,959 distinct E.164 numbers; 2,258 leads with a website; 1,622 with an
email; 3,591 of 3,601 resolved to a municipality.

## Scope actually crawled

The issue asked for a mixed municipality set. Three of the four adapters are
national by construction — Overture is one query over a national extract,
`gradjevinarstvo-rs` walks a national sitemap, Austrotherm publishes one
national distributor page — so they were run nationally, which is a superset of
the requested set. `portal-srbija` was run as a full city sweep for the same
reason.

`gradjevinarstvo-rs` was crawled in **two strata**, as FUZZ-18 established:
company id is registration order, so a prefix sample is all old companies.

| Stratum | Company ids | Read  | Serbian records | With phone |
| ------- | ----------- | ----- | --------------- | ---------- |
| A       | from 1003   | 1,500 | 993 (66.2%)     | 992        |
| B       | from 16114  | 499   | 494 (99.0%)     | 492        |

Stratum B reproduces FUZZ-18's finding exactly: the modern end of the register
is 99% Serbian and 99.6% phone-covered, the old end is a third foreign. **2,000
of the register's 11,291 companies were read — 17.7%.**

### The requested municipality set

| Municipality | Tier | Population | Leads | With phone | Contractors | Stores | Per 10k | Expected at national rate |
| ------------ | ---- | ---------- | ----- | ---------- | ----------- | ------ | ------- | ------------------------- |
| Beograd      | 1    | 1,681,405  | 1,297 | 1,275      | 22          | 141    | 7.71    | 908                       |
| Novi Sad     | 1    | 368,967    | 333   | 331        | 4           | 38     | 9.03    | 199                       |
| Niš          | 1    | 249,501    | 148   | 146        | 2           | 34     | 5.93    | 135                       |
| Kragujevac   | 1    | 171,186    | 71    | 67         | 0           | 9      | 4.15    | 93                        |
| Čačak        | 1    | 105,612    | 54    | 53         | 2           | 6      | 5.11    | 57                        |
| Senta        | 3    | 17,953     | 23    | 23         | 0           | 2      | 12.81   | 10                        |
| Kladovo      | 3    | 17,435     | 6     | 6          | 0           | 2      | 3.44    | 9                         |
| Nova Varoš   | 3    | 13,507     | 3     | 3          | 0           | 1      | 2.22    | 7                         |

The three tier-3 municipalities were picked before any data was looked at, one
per region, to avoid choosing the ones that would flatter the result. National
rate is **5.40 leads per 10,000 inhabitants**.

**Kragujevac is the one that should worry us**: a tier-1 city of 171,000 at 4.15
per 10k, 55% under Beograd's rate and with **zero** facade contractors. Senta at
12.81 shows the geographic mechanism can over-perform in a small municipality;
Nova Varoš at 2.22 shows it can also nearly miss one.

## Yield per source

| Source                     | Leads | Municipalities reached | t1  | t2  | t3  | Requests | Wall time |
| -------------------------- | ----- | ---------------------- | --- | --- | --- | -------- | --------- |
| `overture-places`          | 1,638 | 117 / 145              | 20  | 50  | 47  | 1        | 47 s      |
| `gradjevinarstvo-rs`       | 1,469 | **145 / 145**          | 20  | 51  | 74  | 2,000    | 74.9 min  |
| `portal-srbija`            | 475   | 67 / 145               | 20  | 27  | 20  | 797      | 16.0 min  |
| `austrotherm-distributeri` | 254   | 81 / 145               | 19  | 39  | 23  | 1        | 6.7 s     |
| `website-enrichment`       | 199   | 57 / 145               | 17  | 31  | 9   | 600      | 20.8 min  |

### Which sources stop producing outside the big cities

This is the question the issue asks, and the answer is clean:

- **`gradjevinarstvo-rs` is the only source that reaches all 145 units**, and
  the only one that reaches all 74 tier-3 municipalities. Before it, 18
  municipalities held zero leads; after it, none do.
- **`portal-srbija` is a big-city directory.** 402 of its 475 leads (85%) are in
  tier 1, and it reaches only 20 of 74 tier-3 units. Outside the cities it
  effectively stops.
- **`overture-places` degrades gracefully** — 47 of 74 tier-3 units, 125 leads —
  but it misses 28 municipalities entirely.
- **Austrotherm is a distributor list, not a directory**: 254 leads, but they
  are the highest-precision rows in the corpus (99.6% classify as a store).

Per-municipality detail for the requested set is in `runlogs`-derived JSON via
`scripts/fuzz22-report.ts` (`pilot_source_matrix`). Two illustrative rows:
in **Nova Varoš** only `gradjevinarstvo-rs` produced anything (3 leads, the
other four sources produced zero); in **Kladovo** the three leads came from
Overture (4), `gradjevinarstvo-rs` (1) and Austrotherm (1).

## Duplicate and merge rate

The sweep was run after the crawls and again after enrichment.

|                          | Value                                                 |
| ------------------------ | ----------------------------------------------------- |
| Leads before dedup       | 3,623                                                 |
| Leads after dedup        | 3,601                                                 |
| **Duplicate rate**       | **0.61%** (22 merged)                                 |
| Pairs scored             | 343,263                                               |
| Decisions                | merge 4 / review 347 / distinct 342,912 (final round) |
| Merges by signal         | phone 17, `name_city` 3, `website_domain` 2           |
| **Review queue pending** | **347**                                               |
| Review queue by signal   | `name_city` 268, `address` 77, `social_profile` 2     |
| Quarantined identifiers  | 2 of 50 assessed, both `website_domain`               |
| Merges refused           | 0                                                     |
| Rounds to fixed point    | 2 (cap not hit)                                       |

**0.61% is low, and that is the interesting part.** Four sources, 4,409
source-attachments over 3,601 leads, and only 22 real duplicates. The overlap
between sources is genuinely small:

| Source pair                                       | Shared leads |
| ------------------------------------------------- | ------------ |
| `gradjevinarstvo-rs` × `website-enrichment`       | 166          |
| `gradjevinarstvo-rs` × `overture-places`          | 90           |
| `gradjevinarstvo-rs` × `portal-srbija`            | 67           |
| `overture-places` × `portal-srbija`               | 44           |
| `austrotherm-distributeri` × `overture-places`    | 32           |
| `overture-places` × `website-enrichment`          | 23           |
| `portal-srbija` × `website-enrichment`            | 19           |
| `austrotherm-distributeri` × `portal-srbija`      | 18           |
| `austrotherm-distributeri` × `gradjevinarstvo-rs` | 11           |

3,199 leads (88.8%) are carried by exactly one source; 374 by two, 24 by three,
4 by four. **The sources are largely disjoint populations, not four views of the
same list.** That argues for adding sources rather than deepening one — with the
caveat FUZZ-18 already measured, that overlap on the _facade slice_ runs three
times higher than overlap overall.

The 347-pair review queue is dominated by `name_city` (268). That is the band
working as designed — a strong name match with nothing corroborating it is
exactly what a human should decide — but it is also 347 decisions a human has to
make, and it will scale linearly with a nationwide crawl.

## Coverage gaps: where yield is implausibly low for the population

Every one of the 145 units now holds at least one lead, so the gaps are relative
rather than absolute. Measured as shortfall against the 5.40-per-10k national
rate:

| Municipality | Tier | Population | Leads | Expected | Shortfall |
| ------------ | ---- | ---------- | ----- | -------- | --------- |
| Leskovac     | 1    | 123,950    | 33    | 67.0     | 34.0      |
| Novi Pazar   | 1    | 106,720    | 34    | 57.7     | 23.7      |
| Kraljevo     | 1    | 110,196    | 37    | 59.5     | 22.5      |
| Šabac        | 1    | 105,432    | 35    | 57.0     | 22.0      |
| Kragujevac   | 1    | 171,186    | 71    | 92.5     | 21.5      |
| Vranje       | 1    | 74,381     | 22    | 40.2     | 18.2      |
| Loznica      | 1    | 72,062     | 22    | 38.9     | 16.9      |
| Užice        | 1    | 69,997     | 23    | 37.8     | 14.8      |
| Aleksinac    | 2    | 43,098     | 9     | 23.3     | 14.3      |
| Bujanovac    | 2    | 41,068     | 8     | 22.2     | 14.2      |

**The shortfall is concentrated in tier-1 and tier-2 cities that are not
Belgrade or Novi Sad**, not in the small municipalities. Leskovac, Kraljevo,
Šabac, Kruševac and Novi Pazar are all real construction markets running at
roughly half the national rate. The cause is visible in the source matrix:
`portal-srbija` covers Belgrade densely and these cities barely, Overture's
density follows its own contributor coverage, and nothing else fills the middle.
These are collection gaps, not empty markets.

10 leads could not be resolved to any municipality at all.

## Error rate per adapter, and the failure modes

| Adapter                    | Items        | Failed    | Records emitted | Rejected at the zod boundary |
| -------------------------- | ------------ | --------- | --------------- | ---------------------------- |
| `overture-places`          | 1,718        | 0         | 1,718           | 0                            |
| `gradjevinarstvo-rs`       | 1,999        | 3 (0.15%) | 1,487           | 0                            |
| `portal-srbija`            | 485          | 1 (0.21%) | 450             | 0                            |
| `austrotherm-distributeri` | 292          | 0         | 292             | 0                            |
| `website-enrichment`       | 600 requests | —         | 447 applied     | 0                            |

**Zero records were rejected at the zod boundary, across 4,468 raw records and
all five sources.** No adapter raised `StructureChangedError`. Structurally, the
adapters are healthy.

The failure modes actually seen:

1. **SQLite writer contention — all 4 item failures, and entirely self-inflicted.**
   I ran three adapters concurrently to save wall-clock. `better-sqlite3` opens
   with `busy_timeout = 5000`, and under two concurrent crawlers writing at ~1
   record/sec that timeout is occasionally exceeded: 3 items lost on
   `gradjevinarstvo-rs`, 1 on `portal-srbija`, all with `database is locked`.
   Run alone, stratum B lost **zero** of 499. This is a property of how I ran the
   pilot, not of the adapters — but it is also a real constraint on ever
   parallelising a nationwide crawl.
2. **`portal-srbija` returns HTTP 500 on some city-category pages.** The fetcher
   retried with backoff four times and then recorded the page as failed, which
   is correct behaviour. 24 retries over the run.
3. **A killed run leaves a permanent `running` row in `crawl_runs`.** Two of the
   eight rows are stuck at `status = 'running'` because I stopped those
   processes. Nothing reconciles them, so run-level statistics silently include
   a row that never finished.
4. **The enrichment search path is 100% blocked.** See below — this is the most
   consequential failure in the run.

### The enrichment crawler's search path does not work

FUZZ-21's `--path search` made 111 attempts and returned **zero** candidates.
`html.duckduckgo.com` answers with either HTTP 403 or an anti-bot challenge
page; `lite.duckduckgo.com` does not respond at all from this network. The
provider detects the challenge and gives up rather than solving it, which is
exactly right and is what our compliance rules require — but it means the entire
"find a lead that has no website" half of the enrichment feature is currently
dead, and it burned its whole request budget discovering that.

Re-run with `--path own-site` the crawler works well: **447 enrichments applied
over 600 requests** (420 on the lead's own domain, 27 on a shared decisive
identifier), adding phones, emails and social profiles, and lifting scores
materially (one lead 60 → 83). Only **4 suggestions** landed in the review band,
because a page on the lead's own domain is a merge by ownership, not a
suggestion — the suggest band is fed almost entirely by the search path that
cannot run.

## Spot-check accuracy

Done by hand against the sources; full detail, including every error and its
cause, is in **`research/pilot-spot-check.md`**. Summary:

| Checked  | Phone correct    | City correct    | Classification                  |
| -------- | ---------------- | --------------- | ------------------------------- |
| 24 of 30 | 20 of 22 (90.9%) | 24 of 24 (100%) | 17 correct, 3 arguable, 2 wrong |

Six of the thirty could not be checked against anything, because
**`overture-places` has no browsable source URL** — its `source_url` is an S3
object prefix with a GERS id in the fragment. 607 of its 1,639 leads (37%) also
carry no website, so for those there is no page a reviewer can open at all.

The four errors:

1. `TE ST New Company` (#1609) — stored phone is not the one the company
   publishes. Stale Overture record; nothing detects it.
2. `GDC S.R.M.A` (#1723) — the Belgrade branch row carries the phone numbers of
   four other branches. Happened on the **ingest path**, not in the sweep (no
   `merge_log` row). Corpus-wide, 137 of 4,832 valid landlines (2.8%) sit on a
   lead whose municipality contradicts the number's area code.
3. `Janković inženjering` (#2090) — a thermal-insulation and finishing-works
   contractor classified `UNKNOWN`. False negative, and it is our exact buyer.
4. `Topers` (#2096) — a scaffolding hire firm classified `FACADE_CONTRACTOR` on
   the term `fasadne skele`. False positive.

## Why only 49 facade contractors — the diagnosis

This is not one bug. It is three, and they compound:

**The ambiguous-credit cap makes name-only sources unable to produce a
contractor.** `axisNet` computes `ambiguousCredit = min(ambiguous, core +
supporting)`. `fasada`, `termoizolacija` and `izolacija` are all `ambiguous`. So
a business whose only evidence is the word _fasade_ in its own name scores
**exactly zero** — `Ćorić Fasade` (Stara Pazova) is `UNKNOWN` with the evidence
`contractor.fasada`, weight 1.25, net 0. The rule is deliberate and it correctly
stops a roofer who mentions insulation four times from becoming a facade
contractor. But a company does not _name itself_ "Fasade" by accident, and the
`name` field already carries a 2.5 weight that the cap then discards.

**`moler` is not a signal at all.** The project's own terminology list has
_molersko fasaderski radovi_ and _majstori za fasadu_; `SIGNALS` has no `moler`
entry. `Moler Master`, `Bane moler`, `ULTRA Moler`, `AkiColor Moler Novi Sad`,
`Molerski Radovi GM Color` — all `UNKNOWN` with **zero** evidence recorded.
Molersko-fasaderski crews are a standard Serbian trade pairing and a large part
of the sole-trader population this product targets.

**Overture's categories are an English taxonomy the signal table does not
speak.** `Ćorić Fasade` is `building_or_construction_service`; `Moler Master` is
`contractor`. The store axis has some coverage (`hardware_store` → 159 store
classifications), the contractor axis has none. Deciding on category alone would
be wrong — the file says so and it is right — but category _plus_ a facade term
in the name is corroboration, and today it produces nothing.

The measurable consequence: 29 leads whose names contain `fasad`, `izolac`,
`termo`, `stiropor` or `moler` are still `UNKNOWN`, against 36 total
`FACADE_CONTRACTOR` in the whole corpus. Fixing the classifier is worth more
than adding a source.

## Recommended changes before the nationwide run, ranked

1. **Let a facade term in the business _name_ open the contractor gate.**
   Treat an `ambiguous` contractor signal matched in the `name` field as
   `supporting`, so `Ćorić Fasade` scores. Highest yield per line changed, and
   testable against the existing fixture set. _(pure logic, unit-testable)_
2. **Add `moler` / `molerski radovi` / `molersko-fasaderski` to `SIGNALS`**, as
   `supporting` on the contractor axis — not `core`, since a pure painter is not
   a facade installer, but enough to combine with a facade or insulation term.
3. **Suppress `fasadne skele` the way `fasadna stolarija` is suppressed.**
   One longest-span rule; removes the `Topers` class of false positive.
4. **Map Overture's English categories onto the axes as `supporting` evidence.**
   `building_or_construction_service`, `contractor`, `painter`, `plasterer` on
   the contractor axis. Never decisive alone; decisive in combination.
5. **Fix cross-branch phone leakage on the ingest path.** A same-name group at
   different addresses must not have its later records' phones attached to the
   first lead. The 2.8% area-code/municipality disagreement is the metric to
   watch.
6. **Replace or supplement the blocked search provider in FUZZ-21.** As shipped,
   `--path search` cannot run at all. Either find a provider whose `robots.txt`
   permits us and that answers, or gate the path off by default so it stops
   consuming budget. This is a prerequisite for a meaningful
   `enrichment_suggestions` queue.
7. **Give `overture-places` a browsable `source_url`.** A GERS fragment on an S3
   prefix is not something a human reviewer can open. An
   `https://explore.overturemaps.org/#/…` deep link, or the lead's own website
   where present, would make 1,638 leads reviewable.
8. **Finish `gradjevinarstvo-rs`.** 9,291 of 11,291 companies remain, the modern
   end is 99% Serbian at 99.6% phone coverage, and it is the only source that
   reaches all 145 municipalities. ~5 hours at one request/second, no new
   parsing risk.
9. **Fill the tier-1/tier-2 middle.** Leskovac, Kraljevo, Šabac, Novi Pazar,
   Kruševac, Vranje, Loznica and Užice all run at roughly half the national
   rate. This is a source-selection problem, not a crawler problem.
10. **Reconcile stale `crawl_runs` rows.** A killed process leaves `running`
    forever and quietly corrupts run statistics.
11. **Strip department labels before storing a phone.** 519 rows in
    `lead_phones` hold strings like `0xx xxx xxx, PRODAJA` as `e164`. They are
    correctly `valid = 0` and 425 have a correctly-parsed sibling, but up to ~94
    numbers may exist only in the junk form — and FUZZ-25 must filter
    `valid = 1` or it will render them.
12. **Do not parallelise adapters against one SQLite file** without raising
    `busy_timeout`. Four records were lost to `database is locked`; a run alone
    loses zero.

## Go / no-go for the nationwide crawl

**Go on collection. No-go on the export.**

The crawling half is ready. Zero zod rejections across 4,468 records, zero
structural failures, a 0.15% worst-case item failure rate that was self-inflicted
by my own concurrency, 97.9% phone coverage, and all 145 municipalities reached.
Running this nationwide will produce a large, clean, well-provenanced database
of Serbian construction businesses with working phone numbers. Nothing about the
adapters argues for waiting.

The **product** half is not ready. 15.4% of the corpus is classifiable as a
buyer at all, and 1.4% as the primary buyer. A nationwide run today would
multiply a corpus that is 85% companies we do not want to call, and the sales
list it produced would contain on the order of a few hundred facade contractors
— while the evidence says the real number in the crawled population is
materially higher and the classifier is what is hiding them.

Items 1–4 are all pure-logic changes in `src/lib/classify`, all unit-testable
against the existing fixture set, and together they address every classification
error this pilot found. **Do those first, re-classify the existing 3,601 leads,
and measure the facade-contractor count again.** That measurement — not another
crawl — is what should decide the nationwide run's scope. If it moves 49 into
the hundreds, run nationwide immediately and finish `gradjevinarstvo-rs` in the
same pass.

## Reproducing

```bash
npm run db:setup
npm run scrape -- --source overture-places --trigger backfill
npm run scrape -- --source austrotherm-distributeri --trigger backfill --delay 1000
npm run scrape -- --source portal-srbija --trigger backfill --delay 1000
npm run scrape -- --source gradjevinarstvo-rs --trigger backfill --delay 1000 --budget 1500
# stratum B: set crawl_state.cursor for scope:sitemap:firme to 16114, then
npm run scrape -- --source gradjevinarstvo-rs --trigger backfill --delay 1000 --budget 500
npx tsx scripts/fuzz22-dedupe.ts
npm run enrich -- --path own-site --budget 600 --delay 1000 --trigger backfill
npx tsx scripts/fuzz22-dedupe.ts
npx tsx scripts/fuzz22-report.ts    # every number above
npx tsx scripts/fuzz22-spotcheck.ts ./data/leads.sqlite 30 22
npx tsx scripts/fuzz22-phone-geo-check.ts
```

`scripts/fuzz22-subset.ts` builds a shape-preserving subset of the database if
the full file is ever too large to attach; it was not needed for this run.
