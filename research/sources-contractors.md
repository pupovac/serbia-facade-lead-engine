## Source registry: Serbian facade-contractor data sources (FUZZ-4)

Companion to `research/sources-contractors.json`. That file is the machine-readable registry; this file explains how it was ranked, what was rejected and why, and how a scraper would walk the top three sources.

Researched 2026-08-19. Every source was opened over HTTP during the pass — no source in the registry was rated from search-engine snippets alone.

### Headline numbers

|                                                 |        |
| ----------------------------------------------- | ------ |
| Sources evaluated                               | 30     |
| High                                            | 6      |
| Medium                                          | 6      |
| Low                                             | 10     |
| Rejected                                        | 8      |
| Raw records reachable across the 6 High sources | 16,409 |
| Facade-relevant after classification            | ~2,600 |
| Estimated unique after cross-source dedup       | ~1,900 |
| Expected phone-bearing share of those           | 85–90% |

### How the ranking was decided

The project brief is unambiguous: rank by phone-number yield above everything else. That rule did most of the work here, and it inverted the ranking that a volume-first or relevance-first read would have produced.

Three sources look like obvious winners on any other criterion and are ranked Low on this one:

- **Daibau.rs** is the best-known facade contractor directory in Serbia, facade-named, city-segmented, top of every Serbian search result. Its contractor phone numbers are served by `/autosecretary/getPhoneNumber/` — which is the **first line** of its `robots.txt` Disallow list. Fetching the profile page for a real contractor (`/izvodjac/rading_doo_beograd`) returns exactly one phone number: `+381 11 418 2607`, Daibau's own switchboard. Lead routing is their business model; the gate is deliberate.
- **KupujemProdajem** is Serbia's largest classifieds site (5,733,201 live ads) and structurally holds more active fasaderi than every directory in this registry combined. I fetched a real facade ad and inspected the raw HTML: the embedded state carries `"phone":""` and `"Phones":[]`, and the page renders a _Klik za broj telefona_ button. `robots.txt` disallows `/phone_*` and `/ad_phone_image.php`. There is no compliant path to the number.
- **NadjiMajstora.rs** has a clean, crawlable, facade-named category with 56 registered fasaderi and a permissive `robots.txt`. I fetched five profile pages. Zero phone numbers on any of them — contact runs through an on-site form.

Conversely, **Portal Srbija** would not stand out on brand recognition at all, and it is the best source in the registry, because it prints the phone number directly in the category listing HTML.

A methodological note on the numbers: phone counts came from applying `(\+381|00381|\b0)[0-9 /-]{7,13}[0-9]` to raw HTML and de-duplicating after stripping separators. That regex produces false positives against image filenames — the timestamped filenames on KupujemProdajem's CDN matched it twice — so every number quoted for a High source was checked against rendered page text before it was recorded.

### The six High sources

**1. Portal Srbija — `portal-srbija.com`.** Phones are inline on the category listing page, so one request yields ~150 companies _with numbers_. Measured: 195 unique phones across 141 companies on `/termo-izolacija-zvucna-izolacija`, 213 across 156 on `/zavrsni-radovi-restauracije`, 199 across 94 on `/za-gradjevinske-radove`. No pagination anywhere — every company in a category renders on one static page. Nine relevant categories, ~642 companies, roughly ten requests for the entire source. `robots.txt` says `Allow: /` and restricts only `/admin*/` and `/pretraga/`. The one real caveat: sitemap `lastmod` values are uniformly `2019-04-13`, so expect stale numbers.

**2. Gradjevinarstvo.rs.** Highest absolute volume that is compliantly reachable: `firme-sitemap` contains exactly **11,291** company URLs. Nine of ten sampled company pages carried at least one phone (the single miss was a municipal body, not a business). It is sector-wide rather than facade-specific, so classification decides the real yield — sampling suggests 8–12% are facade/insulation/finishing firms, i.e. ~900–1,350 usable records. Important detail: the category UI loads companies through `/Kategorije/GetFirme/`, which `robots.txt` disallows, but the sitemap is explicitly advertised in the same file. Enumerate from the sitemap, not the category pager.

**3. Navidiku.rs.** Best per-record data quality measured: the phone lives in a `tel:` href _and_ in a `data-fg-phone-options` JSON attribute carrying every number with its display label. All nine sampled company pages carried `tel:` links. 13,408 companies overall; 330 in 68 facade-relevant category-city segments — a floor, since the `/firme/fasaderski-radovi/beograd` filter view surfaces firms filed under other primary segments. Note `robots.txt` gives ClaudeBot its own `Disallow: /` block; use an honest project-specific user agent.

**4. Gradjevinskefirme.cu.rs.** ~3,000 firms across ~400 cities, 50 per page, phone on the detail page (verified: `+381 11 3349 936`). Old static site, ~10 KB detail pages, no anti-bot. It publishes **no `robots.txt` at all** (HTTP 404) — no restrictions expressed, so crawl politely and identify the bot honestly.

**5. Poslovni Kontakt.** Smallest of the six (746 directory items total) and the highest phone density per listing: every card renders one to three numbers inline — _"Moler Dragomir — 069 1484637, 064 1484637, 011 2778129"_. `robots.txt` is `User-agent: *` / `Disallow:` (empty — allow everything). It reaches exactly the buyer profile the product targets: sole-trader fasaderi with a mobile and no company website. That also makes it the source where the ZZPL personal-data handling in the project brief bites hardest, since preduzetnici business numbers are personal data.

**6. 011info.** Belgrade only, no facade-specific subcategory (closest is `izolacija-hidroizolacija-termoizolacija`), and phones appear on detail pages rather than cards — six distinct numbers on `/izolacija-hidroizolacija-termoizolacija/bimax-doo`. `robots.txt` is `Allow: /` with no Disallow rules at all. Ranked High on phone quality and permissiveness, not volume. Its record estimate (~400) is the weakest number in the registry and should be re-measured before crawler budget is committed; the site search at `/pretraga?q=` returns navigation only and must not be built on.

### How a scraper would walk the top three

#### Portal Srbija

Entry: the nine category URLs listed in the JSON — `https://www.portal-srbija.com/termo-izolacija-zvucna-izolacija` and siblings. **Pagination: none.** The full category is one static response (`/zavrsni-radovi-restauracije` is 147 KB carrying all 156 firms). City-scoped `<category>-<grad>` pages exist and are strict subsets — crawl the national page only, or you will re-fetch the same records 100 times.

Listing shape — every company is a `div.general` block:

```
div.general
  div.gen_top
    a[href]            -> detail URL
      h2.nazivfirme    -> company name
    address.adresa
      span.grad        -> city
      span.neighbourhood
      span.street      -> street address
      span.phone-number-1 > a.phone-number-gen[href^="tel:"]   -> phone (normalized digits in href, display form in text)
    div.web > a.web_site[href]   -> website
  div.textfirma        -> long description
```

Additional numbers appear as `span.phone-number-2`, `-3`, … so select on the `[class^="phone-number-"]` prefix rather than hardcoding `-1`. **The detail page is not needed for contact data** — name, city, street, phone and website are all on the listing. Follow the detail slug only if the long description is wanted. Whole source: ~10 requests.

#### Gradjevinarstvo.rs

Entry: `https://gradjevinarstvo.rs/firme-sitemap` — one 2.0 MB XML, 11,291 `<loc>` entries of the form `https://www.gradjevinarstvo.rs/firme/{id}/{slug}`. **Pagination: not applicable** — the sitemap _is_ the enumeration, and the category pager must be avoided because it calls the robots-disallowed `/Kategorije/GetFirme/`.

Detail shape is a Bootstrap grid with no semantic classes, so anchor on the icon rather than the container:

```
h1.naslov-firme-boja                    -> company name
div.col-md-12.font12px                  -> address lines ("34000 KRAGUJEVAC, SRB", "MILEVE RAIČEVIĆ 15")
div.col-md-1 > i.fa-phone               -> phone marker; the NEXT SIBLING div.col-md-11.font12px holds the number
  subsequent div.col-md-1 (empty) + div.col-md-11 pairs -> additional numbers
div.col-md-1 > i.fa-fax                 -> fax marker, same sibling pattern — do not ingest as a phone
```

Take the numeric `{id}` from the URL as the stable source key; the slug can change. Budget 11,291 detail requests, ~3 h at 1 req/s. Classify from category tags plus description text and discard everything that is not `FACADE_CONTRACTOR` or `CONSTRUCTION_MATERIAL_STORE` — this is the source where classification quality, not crawl coverage, determines the yield.

#### Navidiku.rs

Entry: `https://www.navidiku.rs/sitemap/sitemap-companies-001.xml.gz` (gzipped, 13,408 company URLs) for exhaustive enumeration, or the 68 facade-relevant `/firme/{kategorija-grad}` listing pages for the targeted slice. Do **not** guess category-city pairs: `/firme/fasaderski-radovi/beograd` works while `/firme/fasaderski-radovi/nis` and `/firme/gradjevinski-materijal/beograd` both 404 — the taxonomy is not a full cross product. **Pagination:** listings state their own bounds (`Prikazano 1-10 od 10 rezultata`) and never overflow within the facade slice.

Listing shape — the cleanest of the three:

```
.fg-listing-card[data-id][data-map-lat][data-map-lng]     -> card, with coordinates as attributes
  .fg-listing-card__title-row h3 a[href]                  -> name + detail URL
  .fg-listing-card__verified                              -> verified-business badge
  .fg-listing-card__rating                                -> rating ("5,0")
  .fg-listing-card__member                                -> tenure ("Član 1 godinu")
  .fg-work-status__label                                  -> opening status
  p.fg-listing-card__description                          -> description
  a.fg-button--call[href^="tel:"]                         -> phone
    @data-fg-phone-options                                -> JSON array of ALL numbers:
        [{"href":"tel:0615300597","label":"061/53 00 597"}]
```

Parse `data-fg-phone-options` rather than the single `href` — it carries every number the business registered, with both the dialable form and the display form, which satisfies the project rule about preserving the raw original string alongside the canonical `+381…`. Avoid `/firme/ajax` and `/firme/noviajax` entirely; both are robots-disallowed.

### What was rejected, and why

Eight sources were rejected outright. Each is in the JSON with its full reasoning; the short version:

| Source                                                                                      | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **APR** (Agencija za privredne registre)                                                    | `robots.txt` is exactly `User-agent: *` / `Disallow: /`. No exceptions. This is the most painful rejection in the registry — the register is the only route to complete national coverage of every preduzetnik with a facade-related activity code. **Flagging to the project owner:** the compliant route is official bulk-data or API licensing from the agency, which is a commercial conversation rather than an engineering task.                                                     |
| **Facebook**                                                                                | `robots.txt` opens with _"Collection of data on Facebook through automated means is prohibited unless you have express written permission from Facebook."_ Only named authorized agents are permitted.                                                                                                                                                                                                                                                                                     |
| **Instagram**                                                                               | Identical Meta notice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Manufacturer installer lists** (Baumit, Bekament, JUB, Röfix, Austrotherm, Knauf, Maxima) | The issue's hypothesis was sound — vendor installer rosters are usually high-quality and rarely scraped — but **for Serbia these lists are not on the public web.** `baumit.rs` exposes no partner link and `/prodajna-mesta` returns 404; Bekament runs a training centre for fasaderi but publishes no alumni roster; JUB has no public Master-klub list; Austrotherm's "200+ partnera" are distributors, unlisted. Not dead as an idea, just not a scrape: it is a partnership request. |
| **e-majstori.rs**                                                                           | Presents as a national platform, is one operator — every page routes to `062 497 000`, and there is no fasade category. The same applies to `majstorfasada.rs`, `supermajstor.rs`, `majstorukuci018.rs` and `majstorbeograd.com`: individual contractors' own sites, each worth exactly one lead.                                                                                                                                                                                          |
| **Nekretnine.rs**                                                                           | HTTP 403 on every attempt; unmeasured. Recorded so the block is not rediscovered.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Lalafo.rs**                                                                               | Every guessed category path 404s behind an SPA shell. Recoverable later — Goglasi links to working `/belgrade/ads/…` URLs, so the slug pattern can be lifted from outbound links rather than guessed.                                                                                                                                                                                                                                                                                      |
| **Stovarista.rs**                                                                           | Zero contractor content — exclusively stovarišta. Out of scope here, forwarded to the store registry (unrestricted `robots.txt` is a point in its favour there).                                                                                                                                                                                                                                                                                                                           |

`Halo Oglasi` is **not** in that table but is worth calling out: it returned HTTP 403 to every request, so no page was ever rendered. Its `robots.txt` actually permits a project crawler (`Allow: /`) — it is the Cloudflare edge that blocks. Rather than estimate fields I could not observe, it is recorded as Low with `estimated_records: null` and every unknown field marked unknown. It is the one Low entry that could move up, after a timeboxed Playwright spike to check whether phones sit in the ad body or behind a KupujemProdajem-style click-gate.

### Two findings that belong to the next issue

The store-side source registry should start from these rather than rediscover them:

- **PTT Imenik** (`pttimenik.com`) is a negative result here and a strong candidate there. All 16 sitemap pages were fetched: 31,608 URLs, of which `fasad` matches **6** — but `stovarist` matches **643**. Phones and emails are on the detail pages (`011 993698`, `hemoluks@beotel.rs`), `robots.txt` is stock Drupal with nothing blocking company pages.
- **OpenStreetMap via Overpass** is Low for contractors for a measured reason: a national query returns **3** `craft=painter` and **1** `craft=plasterer` nodes for all of Serbia. Fasaderi do not map themselves. The same single query returns **468** store-type POIs (`hardware` 296, `doityourself` 112, `trade` 60), **40% carrying a phone** already in `+381` form, with coordinates and opening hours — one API call, no robots or ToS friction, ODbL attribution required.

Portal Srbija's `/stovarista-beograd` (137 unique phones on one page) and Navidiku's 114 `gradjevinski-materijal` city segments are the other two obvious store-side starting points.

### Recommended build order

1. **Portal Srbija** — ~10 requests, ~642 companies with inline phones. Highest yield per unit of engineering effort by a wide margin; ship this adapter first.
2. **Navidiku.rs** — cleanest structured data (phone as JSON in a DOM attribute), ~100% phone coverage. Best source to calibrate the phone normalizer and the dedup keys against, because its data is near-lossless.
3. **Gradjevinarstvo.rs** — the volume play, ~11,291 records at ~90% phone coverage. Do it third: it needs the classifier to be working before the crawl is worth running, and steps 1–2 will have surfaced most of the normalization edge cases.

`Gradjevinskefirme.cu.rs`, `Poslovni Kontakt` and `011info` follow. Of those, Poslovni Kontakt is the most interesting despite being the smallest — it is the least-overlapping source in the registry, reaching sole-trader fasaderi who appear in none of the corporate registers.
