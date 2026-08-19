## Local-business discovery strategy (FUZZ-8)

How this project discovers Serbian facade contractors and construction-material
stores geographically, without paying for anything, and what would have to
become true before paying is worth it.

Researched 2026-08-19. Every number below came from a request that was actually
issued during this pass. Overpass queries and their raw counts are in
`research/overpass-queries/`; the executed results table is
`research/overpass-queries/RESULTS.md`.

### Recommendation

**Run Stage 3 geographic discovery on Overture Maps Places as the primary
mechanism, directory city-iteration as the sweep, and the APR open-data
register as the completeness frame. Do not buy Google Places.**

The reason to skip Places is not the price — a full national sweep costs about
**$102**, which is nothing. It is that the Google Maps Platform Terms permit
caching exactly two things from the Places API: `place_id`, and latitude and
longitude for 30 days. A permanent SQLite lead database of Google-sourced phone
numbers, exported to XLSX and handed to a sales team, is the specific thing
§3.2.3(b) forbids. Places is not a deferred purchase for this product; it is
an unavailable one.

| Option                       |           Records reachable |      With phone | Cost        | Verdict                |
| ---------------------------- | --------------------------: | --------------: | ----------- | ---------------------- |
| **Overture Maps Places**     |                   **1,856** | **1,764 (95%)** | free        | **Primary**            |
| **Directory city-iteration** |    +80% over national pages |            ~95% | free        | **Sweep**              |
| **APR open-data register**   |           133,634 companies |               0 | free        | **Frame, not leads**   |
| OpenStreetMap / Overpass     | 794 stores + 72 contractors |       378 (44%) | free        | Top-up only            |
| General web search (scraped) |                           — |               — | —           | Rejected — robots      |
| Brave Search API             |                   URLs only |               — | ~$13/sweep  | Named fallback         |
| Google Places API            |                 ~6,000 est. |            ~95% | ~$102/sweep | **Rejected — licence** |

---

### 1. OpenStreetMap / Overpass — good for stores, useless for contractors

Six queries were executed against `https://overpass-api.de/api/interpreter`.
Full counts in `overpass-queries/RESULTS.md`.

**The contractor side is dead.** The issue asked specifically about
`craft=plasterer|painter|builder`. Across the entire country:

```
craft=plasterer   1     (0 with a phone)
craft=painter     3     (1 with a phone)
craft=builder     0
craft=tiler       1     craft=roofer 0     craft=insulation 0
```

**4 elements, 1 phone number.** Adding `stonemason` (21) and `carpenter` (17)
gets the whole facade-adjacent craft set to 43 elements with 15 phones. The
only contractor-side tag with usable density is `office=construction_company`
at 29 elements, 24 of them with a phone.

This is not a wrong-tag problem that a cleverer query fixes. The census of
_every_ `craft=*` value in Serbia (`05-craft-census.overpassql`) returns **697
businesses in total** — for a country of 6.6 million. The largest single value
is `metal_construction` at 92. OSM contributors in Serbia map roads and shops;
they do not map tradespeople. No query rescues data that was never entered.

**The store side is real but thin where it counts.** 794 elements across
`shop=doityourself|hardware|trade|paint|building_materials|tiles|bathroom_furnishing|flooring`:

| `shop=`             |       n |    with phone | with website |
| ------------------- | ------: | ------------: | -----------: |
| hardware            |     297 |     148 (49%) |          123 |
| paint               |     113 |      30 (26%) |           15 |
| doityourself        |     112 |      23 (20%) |           27 |
| bathroom_furnishing |     106 |      44 (41%) |           46 |
| flooring            |      71 |      53 (74%) |           42 |
| trade               |      60 |      17 (28%) |           16 |
| building_materials  |      23 |      18 (78%) |           13 |
| tiles               |      12 |       5 (41%) |            4 |
| **total**           | **794** | **339 (43%)** |      **286** |

794 records for ~339 phone numbers, and OSM's `addr:city` is absent on 723 of
them, so city has to be derived from coordinates anyway.

**Verdict: Low priority, top-up only.** Run `02-stores-with-phone.overpassql`
once, ingest the 339 store records, and never build a geographic sweep on OSM.
The Overpass API is free, has no key, no rate-limit fee, and the whole country
answers in about 20 seconds — it costs nothing to keep as a monthly refresh.

One licensing caveat that matters more than the data: OSM is **ODbL**. Overture
Places is **CDLA-Permissive-2.0** and contains no OSM data. Merging OSM records
into the same lead database can make the resulting database a derivative under
ODbL and pull share-alike obligations onto the whole thing. Keep OSM-sourced
records flagged by source id (the schema already does per-record provenance) so
the choice stays reversible, and get a decision from the project owner before
mixing them into an exported commercial dataset.

---

### 2. Overture Maps Places — the actual answer

This was not in the issue's list and it is the finding that changes the plan.

Overture publishes a global POI dataset as GeoParquet on public S3, free, no
key, no account. Queried directly with DuckDB:

```sql
INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
SELECT count(*) FROM read_parquet(
  's3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/*')
WHERE addresses[1].country='RS'
  AND bbox.xmin BETWEEN 18.8 AND 23.1 AND bbox.ymin BETWEEN 42.2 AND 46.3;
```

**108,740 places in Serbia.** Filtering to the 16 relevant categories plus a
Serbian-name regex (`fasad|termoizolac|izolacij|stiropor|stovarišt|
građevinsk|gradjevin|demit|moler|malter`):

|                | Contractor-side | Store-side | Union incl. name-match |
| -------------- | --------------: | ---------: | ---------------------: |
| Records        |             990 |        788 |              **1,856** |
| With a phone   |       958 (96%) |  741 (94%) |        **1,764 (95%)** |
| With a website |             710 |        452 |                      — |
| With an email  |             778 |        515 |                      — |

By category in the current `2026-08-19.0` release (`taxonomy.primary`):

```
building_or_construction_service  547   phone 522   (95%)
hardware_store                    388   phone 365   (94%)
building_supply_store             236   phone 231   (98%)
contractor                        188   phone 183   (97%)
home_improvement_store            127   phone 117   (92%)
carpenter                          76   phone  75   (99%)
hardware_home_and_garden_store     39   phone  36   (92%)
lumber_store                       13   phone  11
building_contractor                10   phone  10
painting / roofing / masonry_concrete / paving_contractor /
flooring_contractor / stone_and_masonry / paint_store   ~21 combined, ~100% phone
```

The name regex is worth running on its own: 147 places match it, and **61 of
them sit outside all 16 target categories** — `Stovariste KALE DOO Pirot` filed
under `shopping`, `Moleraj-krecenje` under `janitorial_services`,
`Euro Okov građevinski materijal` under `retail`. Category filtering alone
loses those.

**Phone quality is already what the project wants.** Of 1,764 phone-bearing
records, **1,752 are distinct** and **1,736 are already E.164 `+381…`** — 98%
conformant before `libphonenumber-js` sees them.

**Coverage is national, not Belgrade-only.** 179 distinct localities. Belgrade
and its 17 city municipalities account for 512 of 1,856 records — **27.6%**,
leaving 72.4% in the rest of the country. Top localities after Београд (368):
Нови Сад 189, Ниш 68, Суботица 61, Панчево 41, Зрењанин 39, Крушевац 36,
Крагујевац 34, Стара Пазова 31, Сомбор 27, Ваљево 25, Чачак 23.

**Where the data comes from, and why that is the interesting part.** Source mix
for the Serbian relevant subset: `meta` 976 of 990 on the contractor side,
774 of 788 on the store side, with a handful from Microsoft and Foursquare.
This is Facebook Pages data. FUZZ-4 correctly rejected scraping Facebook — its
`robots.txt` prohibits automated collection without written permission. Overture
is the licensed redistribution of the same underlying business data: Meta
contributes it to the foundation under **CDLA-Permissive-2.0**. Overture's own
documentation is explicit that the places theme "contains no OpenStreetMap data
and carries none of the share-alike obligations of the ODbL."

So the compliant route to Facebook business phone numbers is to download them
from Overture rather than crawl Meta. No robots question, no ToS question, no
rate limit, no crawler to maintain.

**Two implementation notes for the Scraper Engineer.** Releases from December
2025 onward moved the taxonomy from `categories.primary` to `taxonomy.primary`
— use the new field and pin the release string, since the S3 path carries it
(`release/2026-08-19.0/`). And `confidence` is a real filter: the contractor-side
subset skews low (26 records at 0.1, 199 at 0.3), so cutting at `confidence >=
0.3` trims the noise without touching the phone-bearing core.

**Verdict: High. This is the primary Stage 3 mechanism.** One `COPY` statement,
about 90 seconds, 15 MB local parquet, ~1,764 phone numbers, no crawler, no cost.

---

### 3. Serbian directory city-iteration — additive, and the registry understated it

The registry from FUZZ-4 records that portal-srbija's city-scoped category pages
are "strict subsets — crawl the national page only." **Measured, that is not
true, and the difference is large.**

Sweep executed at 1 request/second with an honest project user agent, category
`termo-izolacija-zvucna-izolacija`, over the 32 most populous units plus all 17
Belgrade city municipalities from `data/serbia-geo.json`:

|                                   |   Firms |
| --------------------------------- | ------: |
| National category page alone      |      60 |
| Union of national + 49 city pages | **108** |
| Found **only** via a city page    |  **48** |

That is **+80% over the national page, on one category.** Nine of the twelve
firms on the Novi Sad page (`Izomonter`, `Termodom`, `Domino gradjevinski
centar`, `Eko dom`, `Hit - promet`, …) do not appear on the national page at
all. Belgrade alone contributes 52 firms via its city municipalities, 26 of them
new.

**The operational catch, and the workaround.** 14 of the 49 city slugs return a
deterministic HTTP 500 — `beograd`, `pirot`, `kikinda`, `vrsac`, `ruma`,
`backa-palanka`, `zajecar`, `paracin`, `aleksinac`, `cukarica`, `grocka`,
`obrenovac`, `rakovica`, `sopot`. Retried twice each; not transient, a site
defect. Critically **`beograd` itself is one of them** — the single most
valuable slug in the country 500s. The workaround is already in the data:
`novi-beograd` (15 firms), `zemun` (10), `vozdovac` (7), `vracar` (6),
`stari-grad` (4) and `surcin` (4) all return 200. **Iterate Belgrade through
the 17 city municipalities in `data/serbia-geo.json`, never through `beograd`.**

`robots.txt` allows this: `Allow: /`, with only `/admin*/` and `/pretraga/`
disallowed. The city-suffixed category pages are not under `/pretraga/`.

Cost of the full sweep: 9 relevant categories × ~162 units = ~1,458 requests,
about 25 minutes at 1 req/s.

**Navidiku is the counter-example — do not build a cross product.** Its
`/firme/{kategorija}/{grad}` taxonomy is sparse, not a matrix:

```
/firme/fasaderski-radovi/beograd       200,  26 tel: links
/firme/fasaderski-radovi/novi-sad      200,   9 tel: links
/firme/fasaderski-radovi/nis           404
/firme/fasaderski-radovi/kragujevac    404
/firme/gradjevinski-materijal/beograd  404
```

Generating city × category URLs there produces mostly 404s. Enumerate from its
sitemap (`sitemap-companies-001.xml.gz`, 13,408 companies) instead.

**Verdict: High as a sweep, but understand what it is.** Directory
city-iteration is not geographic _discovery_ — it re-slices a corpus that is
already enumerable from the same site. Its value is that the slicing is lossy
in the site's own favour: the national view silently truncates, and only the
city view shows the tail. Run it, and budget for the 500s.

---

### 4. General web search — rejected, and not on a technicality

All three major engines disallow the result pages in `robots.txt`:

- `google.com/robots.txt` → `Disallow: /search`
- `bing.com/robots.txt` → `Disallow: /search`
- `duckduckgo.com/robots.txt` → `Disallow: /html`, `Disallow: /lite` — precisely
  the two no-JavaScript endpoints scrapers use. The root `?q=` form that
  `Allow: /?*` permits is the JavaScript SPA and returns no results without a
  browser.

The project brief already commits to respecting `robots.txt`. There is no
compliant free path to SERP scraping, and building one on a rotating-proxy
service would contradict a standing project rule. Rejected.

**The paid alternative, costed, as the named fallback.** Brave Search API is
$5 per 1,000 requests with $5 of free credit monthly (credit card required, as
an anti-fraud measure). A full sweep of 162 units × 22 query terms = **3,564
queries = $17.82, or $12.82 after the free credit.**

The important constraint is not the price: Brave's standard terms do not grant
storage rights — those require a plan that explicitly includes them. So Brave
is usable as a **URL-discovery layer only**: take the URLs, discard the search
results, crawl the discovered sites under their own `robots.txt`, and store
what those sites publish. That is a legitimate architecture and it is the
right fallback, but it produces work for the enrichment crawler rather than
finished leads.

---

### 5. Google Places API — costed, and rejected on licence, not price

**Not called.** Costed from published pricing.

Pricing verified 2026-08-19 from `developers.google.com/maps/billing-and-pricing`.
The $200 monthly credit was withdrawn on 2025-03-01 and replaced by per-SKU
free monthly thresholds: **10,000 Essentials, 5,000 Pro, 1,000 Enterprise.**

The field mask decides the SKU, and this is what drives the budget:
`nationalPhoneNumber`, `internationalPhoneNumber` and `websiteUri` are all
**Enterprise** fields. There is no cheap tier that returns a phone number.

**Call count, derived from the real municipality count.** `data/serbia-geo.json`
(FUZZ-6) gives 145 local self-government units plus the 17 Belgrade city
municipalities = **162 geographic units**. The project brief lists 14 contractor
terms and 8 store terms = **22 query terms** (Text Search normalises diacritics,
so `građevinski`/`gradjevinski` collapse to one call). Text Search returns ≤20
results per page and ≤3 pages via `nextPageToken`.

```
first pages    162 × 22                        = 3,564
second pages   30% of those need one           = 1,069
third pages    12% need one                    =   428
                                          total = 5,061 Text Search calls
```

**Plan A — two-step, the cheap one.** Text Search _Pro_ to enumerate place IDs,
Place Details _Enterprise_ only for unique places, to fetch the phone.

```
Text Search Pro          (5,061 − 5,000 free) ×  $32/1000  =    $1.95
Place Details Enterprise (6,000 − 1,000 free) ×  $20/1000  =  $100.00
                                                     TOTAL =  $101.95
```

The 6,000 unique-place figure is anchored on measurement, not a guess: Overture
finds 1,856 relevant Serbian businesses and the APR register holds 2,813
companies under the six core activity codes. Google Maps additionally carries
preduzetnici that neither source lists. The plausible band is 4,000–9,000
unique places, which puts the sweep between **$62 and $162**.

**Plan B — one-step.** Text Search _Enterprise_, phone in the search response,
no Details call: `(5,061 − 1,000) × $35/1000 = $142.14`. More expensive, and it
returns phones only for the ≤60 results each query can reach. Plan A wins.

Refresh would be roughly **$6/month** (Text Search Pro stays inside its 5,000
free tier; a 20% Place Details refresh slice is 1,200 calls, 200 of them
billable).

**So cost is not the objection. The licence is.** Google Maps Platform Terms
§3.2.3:

> **(a) No Scraping.** Customer will not export, extract, or otherwise scrape
> Google Maps Content for use outside the Services.
>
> **(b) No Caching.** Customer will not cache Google Maps Content except as
> expressly permitted under the Maps Service Specific Terms.

And the Maps Service Specific Terms §14.3, the entire permission granted for
this API:

> **14.3 Caching.** Customer may temporarily cache latitude and longitude values
> from the Places API for up to 30 consecutive calendar days, after which
> Customer must delete the cached latitude and longitude values.

`place_id` may be cached indefinitely. Everything else — the business name, the
address, and above all **the phone number** — may not be stored at all.

This product is a permanent SQLite system of record holding phone numbers, with
incremental re-crawls, a review UI and an XLSX workbook handed to a sales team.
Every one of those is a storage of Google Maps Content that §3.2.3(b) forbids
and §14.3 does not excuse. Buying more quota does not fix it, because quota was
never the constraint.

**Verdict: rejected — and it should be recorded as rejected, not deferred.**
The project brief currently frames Places as "a Stage 4 decision made with
measured numbers." The measured number is $102, which would be an easy yes; the
blocker is a licence term that no amount of measurement moves.

### Is scraping Google Maps directly the right call?

**No.**

The legal reason is the sentence quoted above: §3.2.3(a) _No Scraping_ is not
about the API, it covers Google Maps Content however obtained, so scraping the
maps front end is a more explicit violation than paying for the API, not a way
around it. Scraping is what the API is licensed to replace, and doing it
unlicensed puts the company's Google accounts at risk for a dataset it still
could not lawfully retain.

The engineering reason is independent and would matter even if the terms
allowed it. Google Maps renders through obfuscated internal endpoints with
rotating parameter names and no stability contract, it is behind aggressive
bot detection that a compliant crawler cannot defeat without the
CAPTCHA-bypassing and detection-evasion the project brief already prohibits,
and every layout change silently breaks extraction. That is a permanently
staffed system delivering a dataset with a legal defect.

**The alternative is not a compromise, it is a better dataset.** Overture's
Serbian places are 95% Meta-sourced, published under CDLA-Permissive-2.0 with
explicit permission to store and redistribute, delivered as a single parquet
download with no crawler at all, and they carry a phone number **95%** of the
time. On phone-yield-per-record — the project's stated ranking criterion —
Overture is at least the equal of what a Google sweep would produce, and it is
the only one of the two that this product is allowed to keep.

---

### 6. Other datasets — one significant find

**APR open-data company register — free, official, and it reopens a source
FUZZ-4 had to reject.**

FUZZ-4 rejected the Agencija za privredne registre because
`apr.gov.rs/robots.txt` is `User-agent: * / Disallow: /`, and flagged licensed
bulk data as "a commercial conversation rather than an engineering task."
That conversation is unnecessary for companies: APR already publishes the
register as open data.

Found via the Serbian open-data portal (`data.gov.rs`, dataset
`api-za-registar-privrednikh-drushtava`), served from
`https://openapi.apr.gov.rs/api/opendata/companies`. Called during this pass:
**HTTP 200, 57.7 MB of JSON, 133,634 active companies, cut date 2026-07-31,
updated monthly, licence `sodl` (Serbian Open Data Licence).** The host
publishes no `robots.txt` and the endpoint is the documented, advertised
open-data delivery channel, so the `apr.gov.rs` crawl prohibition does not
apply to it.

Each record carries matični broj, business name, municipality code and name,
status, founding date, legal form, and **registered activity code**. Counts by
the codes that matter:

| Code | Activity                                          | Companies |
| ---- | ------------------------------------------------- | --------: |
| 4331 | Malterisanje                                      |       100 |
| 4334 | Bojenje i zastakljivanje                          |       155 |
| 4339 | Ostali završni radovi                             |       564 |
| 4329 | Ostali instalacioni radovi u građevinarstvu       |       266 |
| 4673 | Veleprodaja drveta, građ. materijala i sanitarije |     1,119 |
| 4752 | Maloprodaja metalne robe, boja i stakla           |       609 |
|      | **core six**                                      | **2,813** |
| 4120 | Izgradnja stambenih i nestambenih zgrada          |     6,609 |
| 4399 | Ostali specifični građevinski radovi              |     1,399 |
|      | contractor-side, all codes                        |    10,806 |
|      | store-side, all codes                             |     1,786 |

The core six span **168 municipalities**.

**It contains no phone numbers and no street addresses**, so by the project's
own ranking rule it is not a lead source. What it is, is the only complete
national frame available. Three concrete uses:

1. **Coverage measurement.** "We hold phone numbers for N of the 2,813
   companies registered under the core codes in municipality X" is a real
   coverage statistic. Nothing else in this project can produce one.
2. **Classification ground truth.** The activity code is the state's own
   classification. Matching a scraped lead to its APR record by name + city
   resolves `FACADE_CONTRACTOR` vs `CONSTRUCTION_MATERIAL_STORE` without
   guessing from description text — directly useful to the Stage 2
   classification work.
3. **Targeted enrichment.** Companies in the frame with no phone yet are a
   ranked worklist for the enrichment crawler, ordered by municipality.

**The honest limitation, and it is a big one.** This dataset covers _privredna
društva_ only — DOO and AD. It does **not** cover _preduzetnici_, the sole
traders that the project brief names as a large share of Serbian fasaderi. The
endpoints `/api/opendata/entrepreneurs` and `/api/opendata/preduzetnici` were
probed and both return 404, and `data.gov.rs` has no preduzetnici dataset. The
single largest structural gap in this project's coverage is the sole-trader
register, and it is not open data.

**Checked and not worth pursuing:** `data.gov.rs` holds 3,516 datasets across
216 organisations; apart from the APR register, none is a business directory
with contact data. Foursquare's open Places dataset is already inside Overture
(and contributes only 2,538 of Serbia's 108,740 records against Meta's
103,504), so querying it separately adds nothing. Microsoft contributes 1,258,
AllThePlaces 1,064, PinMeTo 376 — all already in the Overture download.

---

### Stage 3 mechanism, in build order

1. **Overture Maps Places** — one DuckDB `COPY` against the pinned release,
   filtered by `taxonomy.primary` plus the Serbian name regex, `confidence >=
0.3`. ~1,856 records, ~1,764 phones. No crawler.
2. **Directory city-iteration on portal-srbija.com** — 9 categories × 162 units
   from `data/serbia-geo.json`, Belgrade via its 17 city municipalities, 1 req/s,
   14 known-500 slugs skipped. ~1,458 requests, ~25 minutes.
3. **APR open-data register** — monthly refresh, loaded as the coverage frame
   and classification ground truth, not as leads.
4. **OSM top-up** — `02-stores-with-phone.overpassql`, 339 store records, one
   request, flagged by source so the ODbL question stays reversible.

**Named fallback if that underperforms:** Brave Search API as a URL-discovery
layer at ~$13 per national sweep, feeding the enrichment crawler. It requires
approval under the project cost policy — it is a paid API — but it is roughly
one-eighth the price of Places and, unlike Places, what it leads you to is
storable.

### Trigger for revisiting the paid option

Two conditions, and they are not about Google.

**Yield trigger.** Revisit paid discovery if, at the end of Stage 3, the free
stack holds fewer than **2,000 unique phone-bearing leads nationally**, or
covers fewer than **100 of the 145 local self-government units** with at least
one lead. Overture alone should clear both (1,752 distinct phones, 179
localities), so falling short means something upstream broke and the answer is
to fix it before buying anything.

**Coverage trigger, and the thing actually worth buying.** Revisit if measured
coverage against the APR frame stays below **60% of the 2,813 core-code
companies** in tier-1 and tier-2 municipalities after the enrichment crawler
has run. If that happens, the money should go to **APR licensed bulk data for
the preduzetnici register**, not to Google. The preduzetnici gap is the one
measured hole in national coverage, APR is the only source that closes it, and
its licence permits exactly the storage this product needs.

**Google Places does not get a revisit trigger,** because no measurement changes
the outcome. It would only become viable if Google changed §3.2.3(b) and §14.3,
or if the product changed into something that displays live Google results on a
Google map instead of storing leads — which is a different product.
