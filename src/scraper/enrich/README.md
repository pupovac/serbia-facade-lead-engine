# `src/scraper/enrich` — contact enrichment

A source often yields no more than a name, a city and a phone — or worse, a name
and a website and no phone at all. Enrichment goes back to the business and
finds the rest.

```bash
npm run enrich -- --path own-site --limit 50
npm run enrich -- --path search --limit 20
npm run enrich -- --help
```

It is deliberately **not** a `SourceAdapter`. An adapter discovers businesses;
this starts from businesses already in the database. It shares the scraper's
`PoliteFetcher`, so `robots.txt`, the per-host rate limit, the honest User-Agent
and the request budget all apply.

## The rule the whole thing exists for

**Only merge when the page is confidently the same business.** A name match
alone is never enough: Serbia has many `Fasade Petrović`, and one wrong merge
writes a competitor's phone number onto a lead and quietly poisons the sales
list — the failure nobody notices, because the row looks exactly like a good one.

| Outcome   | Confidence | What it takes                                                                                                                                                                                         |
| --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge`   | ≥ 0.90     | The page is on the lead's **own domain**; or a **decisive identifier** is shared (phone, website domain, email, matični broj); or a **name match in the same place with corroboration** behind it.    |
| `suggest` | 0.50–0.89  | A strong name match in the same place with nothing corroborating it; corroboration with no name match; a decisive signal the quarantine has disarmed. Queued in `enrichment_suggestions` for a human. |
| `discard` | < 0.50     | Nothing connects the page to this lead; the lead has no city so a name cannot be placed; the page describes many businesses; the page is a directory or a platform.                                   |

The rules are pure functions in `confidence.ts`, the numbers are in
`thresholds.ts`, and the bands are imported from `src/lib/dedup` rather than
copied — enrichment asks the same question the deduplicator asks, and two
answers to one question drift apart the first time either is tuned.

`confidence.test.ts` runs a corpus of pages of _different_ businesses with
similar names through the gate and asserts the false-merge rate is **zero**.

## Layout

| File               | What it owns                                                                      |
| ------------------ | --------------------------------------------------------------------------------- |
| `targets.ts`       | Which leads are worth requests, ordered by what filling their blanks would score. |
| `contact-pages.ts` | Which links on a homepage are worth a second request.                             |
| `page.ts`          | One fetched page → `PageEvidence`. All extraction goes through `src/lib`.         |
| `confidence.ts`    | **Is this page the same business?** `merge` / `suggest` / `discard`.              |
| `thresholds.ts`    | Every number, with the reason it has the value it has.                            |
| `apply.ts`         | Attaching a merge, queueing a suggestion.                                         |
| `finder.ts`        | Finding candidate pages for a lead with no website. See the caveat below.         |
| `run.ts`           | The run loop, the tally, `crawl_runs` and the resume bookkeeping.                 |
| `sources.ts`       | The two pseudo-sources every enrichment claim is written under.                   |
| `cli.ts`           | `npm run enrich`.                                                                 |

## Two paths, and only one of them works today

**A lead with a website** is the high-confidence path and it works: fetch the
homepage, read the site's own navigation for its contact page, take up to four
pages in total, trust what is on them because the business publishes them.

**A lead with no website** needs a web search, and the project's rules leave
almost nothing available. No paid API without a go-ahead in the issue. `robots.txt`
honoured with no override, which rules out Google, Bing, Brave, Ecosia,
Startpage and Mojeek — all of them `Disallow` their result paths.
`html.duckduckgo.com` publishes `Allow: /` and is the one surface a
robots-respecting crawler may read, so that is the provider built here.

Measured on 2026-08-20: it answers a handful of queries and then serves an
anti-bot challenge instead of results — 5 of the first 12 queries, then all 40
of the next batch. That is a CAPTCHA in all but name, and the compliance rule is
absolute: never solve or bypass one, never lie about who is asking. So the
provider **detects the challenge and gives up**, and the run reports
`search_unavailable` rather than quietly reporting that the business has no
pages.

`CandidateFinder` is one method, so a permitted provider — a paid API once an
issue approves one, a Serbian directory's own search, a self-hosted index —
plugs in without touching the confidence rules.

## What enrichment does not do

- **It does not re-classify.** A page whose only text is "Kontakt" is evidence
  about how to _reach_ a business, not about what it is. Running the classifier
  over it would turn a confident `FACADE_CONTRACTOR` into `UNKNOWN` and drop the
  lead out of the export.
- **It does not overwrite.** Everything goes through `upsertLead`, which fills
  blanks; a page that disagrees with a stored value records a claim in
  `lead_field_values` with its own provenance and loses.
- **It does not overturn a reviewer.** A value a human rejected in
  `enrichment_suggestions` stays rejected however good a later run's evidence
  looks.
- **It does not write the lead's name.** The page is evidence about contact
  details; letting it restate the name would file `Kontakt | Fasade Petrović` as
  a competing claim on every run.
