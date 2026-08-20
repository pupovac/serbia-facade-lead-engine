# `portal-srbija` — Portal Srbija

A national Serbian business directory with a category × city taxonomy, static
HTML, no pagination and no JavaScript. `research/sources-contractors.json` ranks
it first for phone yield among 31 contractor sources, and the sample run below
confirms it: **100% of the leads it produced carry a phone.**

- Base URL: `https://www.portal-srbija.com`
- Registry entry: `research/sources-contractors.json` → `portal-srbija`
- Renderer: `cheerio`. No Playwright — every field is in the served HTML.

## `robots.txt`

Re-fetched on 2026-08-20, identical to what FUZZ-4 recorded on 2026-08-19:

```
User-Agent: *
Allow: /
Disallow: /admin*/
Disallow: /pretraga/
Sitemap: https://www.portal-srbija.com/sitemap.xml
```

Every path this adapter requests is a category page (`/<kategorija>`,
`/<kategorija>-<grad>`) or a company page (`/<firma>`), all outside both
`Disallow` prefixes. The site's internal search under `/pretraga/` is the one
obvious way to enumerate this source, and it is disallowed, so the adapter does
not use it — the category taxonomy is the permitted route to the same records.
Verdicts checked through `PoliteFetcher.robotsVerdict` against the real
`robots.txt` on 2026-08-20:

| Path                                         | Verdict | Rule                   |
| -------------------------------------------- | ------- | ---------------------- |
| `/termo-izolacija-zvucna-izolacija`          | allowed | `Allow: /`             |
| `/termo-izolacija-zvucna-izolacija-novi-sad` | allowed | `Allow: /`             |
| `/termodom`                                  | allowed | `Allow: /`             |
| `/pretraga/?q=fasada`                        | refused | `Disallow: /pretraga/` |
| `/admin/login`                               | refused | `Disallow: /admin*/`   |

## Rate limit

`requestDelayMs: 2000` — slower than the framework's 1.5s default. `robots.txt`
asks for no `Crawl-delay`; this is our own choice for a small directory serving
150 KB static pages off one host. The measured mean interval on the sample run
was 2.02 s per request (117 requests in 234.4 s), so the configured rate is a
ceiling that was never crossed. An adapter cannot make a crawl harsher than the
environment allows — see `docs/writing-an-adapter.md`.

## How discovery works

The site has **no pagination**. Its unit of listing is one page per
(category × city), and the national page of a category is not the union of its
city pages — FUZZ-8 measured 60 companies nationally against 108 across the
national page plus 49 city pages. So both are crawled: the national page is the
seed, the city pages are the enumeration.

**Which city pages exist is the source's answer, not ours.** Every category page
links each of its city-scoped variants from `dl.dl_nei`, so `discover` reads
that list rather than composing `<category>-<grad>` from `data/serbia-geo.json`.
Composing them is what produced FUZZ-8's 14 deterministic HTTP 500s — including
`beograd`, for which this source has no page at all. The sample run below made
36 listing requests and got **zero** failures.

`data/serbia-geo.json` still decides the crawl **order** (tier, then population,
so a truncated run has covered the largest cities) and the `--city` **filter**.
Matching goes through `resolveCity`, because the source names pages after
neighbourhoods as often as municipalities: `zeleznik` is Čukarica, `palic` is
Subotica, `kac` is Novi Sad. Six of the 77 slugs on the largest category are
places the settlement dataset does not know yet; they are crawled last on an
unscoped run and skipped on a `--city` one, because there is no honest way to
say whether they are in scope.

### Scopes

| Scope key                          | Page                       |
| ---------------------------------- | -------------------------- |
| `category:<slug>`                  | the national category page |
| `category:<slug>\|city:<citySlug>` | one city page              |

The national scope's cursor holds the city slugs that page linked, so a resumed
run inside the rediscover window knows what is left to do without re-fetching
it. A page that fails leaves its scope `failed`, which means the next run
retries that page and only that page.

## Why the detail page is fetched

The listing already carries name, address and phone, so extraction could have
been free. It is not. Measured over 26 companies on 2026-08-20:

| The detail page adds     | Companies |
| ------------------------ | --------- |
| an email address         | 8 / 26    |
| an external website link | 13 / 26   |
| at least one new phone   | 15 / 26   |
| more than one location   | 12 / 26   |

**No listing page on this site publishes an email anywhere**, so every email the
source yields costs one detail request. The 14-day item staleness window means a
re-run pays that cost for almost nobody.

One record is emitted per company, not per branch: a chain's branches share a
name and `src/lib/dedup` merges on normalized phone, so seven records would
either collapse back into one or manufacture near-duplicates for a human to
un-merge. Every branch phone is on the record and the branch list is kept in
`extra.locations`.

## Failing loudly

`div.general` is asserted on the **national** page of every category and not on
a city page. The national page is the source's own claim that a category has
companies in it, so zero blocks there is a redesign; a city page is a filtered
view of the same template, and a filter returning nothing is a legitimate
answer. Both are rendered from one template, so a renamed card class still
breaks the run on the first request. `dl.dl_nei` is asserted on both — it is
what makes a page a category page at all.

`__fixtures__/listing-redesigned.html` is that failure saved: a healthy 200 full
of companies whose markup no longer matches. `parse.test.ts` asserts it raises.

## Fixtures

Real pages, saved 2026-08-20, byte for byte — `.prettierignore` covers them
because reformatting a snapshot changes what the test is testing.

| Fixture                                      | What it is                                           |
| -------------------------------------------- | ---------------------------------------------------- |
| `listing-national-radovi-na-visini.html`     | a national category page (6 companies, 7 city links) |
| `listing-city-radovi-na-visini-*.html`       | all seven city pages of that category                |
| `listing-city-termo-izolacija-novi-sad.html` | a 12-company city page                               |
| `listing-redesigned.html`                    | the national page with `div.general` renamed         |
| `detail-bartolomeo-blok.html`                | email, two phones, description table                 |
| `detail-termodom.html`                       | labelled website, email, 13 branches                 |
| `detail-izomonter.html`                      | no email, no website, one location                   |
| `robots.txt`                                 | the file quoted above                                |

`discover.test.ts` serves one whole real category — the national page and all
seven of its city pages — so the crawl plan, the resume windows and the
one-dead-page-costs-one-page rule are all verified with no network.

## Sample run — 2026-08-20, Novi Sad + Niš + Kragujevac

```bash
npm run scrape -- --source portal-srbija --city novi-sad --city nis --city kragujevac
```

| Metric                     | Value                                    |
| -------------------------- | ---------------------------------------- |
| Listing pages read         | 36 (9 national + 27 city), 0 failed      |
| Companies discovered       | 81                                       |
| Records emitted / rejected | 81 / 0                                   |
| **Records with a phone**   | **81 (100%)**                            |
| Leads created / merged     | 80 / 1                                   |
| Leads with an email        | 30 (37.5%)                               |
| Leads with a website       | 34 (42.5%)                               |
| Phones stored              | 209 (167 landline, 42 mobile) — 2.6/lead |
| City resolved              | 80 / 80                                  |
| Requests / retries         | 117 / 0                                  |
| Wall time                  | 234.4 s (208.3 s of it deliberate delay) |

City iteration earned its requests: **57 of the 81 records were first seen on a
city page**, 24 on a national one.

Re-running immediately made **0 requests** and produced 0 records. Re-running
with `--rediscover-after 0.0001` re-walked all 36 listing pages, found the same
81 companies, skipped all 81 as fresh, and created **0 leads and 0 duplicates**
for 36 requests instead of 117.

### Category yield in this scope

| Category                           | Records first seen |
| ---------------------------------- | ------------------ |
| `zavrsni-radovi-restauracije`      | 34                 |
| `termo-izolacija-zvucna-izolacija` | 22                 |
| `hidroizolacija`                   | 16                 |
| `ciscenje-fasada-skidanje-grafita` | 4                  |
| `za-gradjevinske-radove`           | 3                  |
| `sanacije-gradjevinskih-objekata`  | 1                  |
| `proizvodnja-stiropora`            | 1                  |
| `grubi-gradjevinski-radovi`        | 0                  |
| `radovi-na-visini`                 | 0                  |

## Known caveats

- **Staleness.** Every `<lastmod>` in the sitemap is `2019-04-13`, so a share of
  these numbers is old. `last_seen_at` is the honest signal; expect dead lines.
- **Truncation.** A national category page renders at most 60 companies. The
  five categories under that cap are complete nationally and their city pages
  add nothing; the four at it are why city iteration exists.
- **The store side.** These nine categories are contractor-selected, but sector
  pages mix installers and material yards — `termodom` is a stovarište filed
  under termo izolacija. `research/sources-stores.json` lists
  `portal-srbija-stovarista` as a separate source with its own category set; an
  adapter for it should reuse `parse.ts` here rather than re-parse this markup.
