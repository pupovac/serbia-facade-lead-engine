# Source Registry — Construction-material stores (FUZZ-5)

Companion prose for `research/sources-stores.json`. That file is the machine-readable
artifact; this one explains how the ranking was reached, what was rejected and why, and
how a scraper would actually walk the top sources.

All fetches were performed from this machine on **2026-08-19**. Numbers below are measured
unless the entry says otherwise.

## Headline numbers

|                                                |                                     |
| ---------------------------------------------- | ----------------------------------- |
| Sources evaluated                              | **20**                              |
| High / Medium / Low                            | **4 / 3 / 13**                      |
| Chains with 3+ Serbian locations               | **11**                              |
| Raw phone-bearing store records across sources | **1,424**                           |
| Realistic distinct store records after dedup   | **800–950** (projection, see below) |

## The ranking rule that produced this order

Phone-number yield first, volume second — as the brief requires. That rule alone reorders
the list dramatically against what search engines suggest. `stovarista.rs` has the perfect
domain name and ranks on page one for the exact Serbian query terms; it serves 90,938 bytes
with **zero** phone numbers, so it is Low. `austrotherm.rs/distributeri` is a manufacturer
page nobody would search for; it serves 289 Serbian companies with a phone number on every
single one, in **one HTTP request**, so it is the top source in the registry.

## The four High sources

### 1. Austrotherm — Distributeri (`https://www.austrotherm.rs/distributeri`)

The best source found in this task, on every axis except volume.

- **289 Serbian entries**, all with a phone. 270 distinct numbers, 224 distinct company
  names (branches repeat the name). 60 of the numbers are mobile (06x).
- **One static HTML document**, 265,570 bytes. No JavaScript, no pagination, no API.
- **Segment fit is exact.** These are not "shops" in general — they are the yards that
  already buy and resell EPS. A yard on Austrotherm's distributor list is, by definition,
  a business that sells expanded polystyrene facade insulation to the same customers our
  panel targets.

**How a scraper would walk it.** Entry URL is the page itself; there is nothing else to
crawl. After stripping tags, entries appear as flat three-line groups:

```
21 MAJ
Mramorsko brdo bb, 18000 Niš
T +381 (0)18 469 40 13
```

Anchor on the line matching `^T\s*(\+38[12])\s*\(?0?\)?\s*[\d\s\-/]{6,15}$` and read two
lines back for name and address. **Filter on the `+381` prefix, not on the section
heading** — a "Distributeri CRNA GORA" heading appears mid-alphabet between `DEMIT CENTAR`
and `DJORDJEVIĆ`, and Montenegrin entries continue interleaved after it. Splitting on that
heading gives a wrong answer (it did on the first pass of this research); splitting on the
country calling code gives the right one: 289 × `+381`, 29 × `+382`. A couple of rows have
a malformed phone field (literally `T Kršumlija`) and must fail the zod check rather than
be coerced.

`robots.txt` disallows only `/*?id=*`, `/*&id=*`, `/*?L=0*`, `/*?type=98*`, `/*/Private/*`,
`/fileadmin/templates/html/*`, `/*/Configuration/*` and `/typo3temp/*`. Nothing matches
`/distributeri`.

### 2. PortalSrbija.com — Stovarišta (`/stovarista-<grad>`)

Best **national** coverage of the pure stovarište segment.

- **112 city pages**, enumerated from `sitemap1.xml`…`sitemap8.xml` (65,931 URLs total).
- All 112 fetched: **361 globally distinct phone numbers** (317 landline, 44 mobile).
  Only 3 city pages were empty.
- Beograd 68 phones, Novi Sad 45, Niš 18, then a long tail down to towns like Bačka Topola
  and Novi Pazar with 5 each.

**How a scraper would walk it.** Filter the eight sitemaps' `<loc>` values on
`/stovarista-`. Fetch each city page with cheerio — no pagination, the city page holds
every listing. Each listing renders as name → `Grad,` → address → one or more phone lines
joined by `|` → optional website → free-text assortment description. Everything needed is
on the category page; detail pages are not required for the phone.

`robots.txt`: `Allow: /` with `Disallow: /admin*/` and `Disallow: /pretraga/`. The
`/stovarista-*` paths are unaffected.

### 3. Mirandre.com — Stovarišta (`/stovarista/<grad>`)

Widest geographic spread and the cleanest topical focus.

- Beograd page links **161 city pages**; all 161 fetched.
- **294 distinct store detail pages**, reached via 608 city→listing links.
- Phone coverage is effectively total: Beograd shows 45 listings against 59 distinct phone
  strings, i.e. more than one number per listing on average.

**How a scraper would walk it.** Seed on `/stovarista/beograd`, harvest the 161
`https://www.mirandre.com/stovarista/<grad>` links, fetch each. Detail slugs are bare
`https://www.mirandre.com/<slug>` links — exclude `/stovarista/`, `/blog`,
`/gradjevinarstvo` and any `/cene-cenovnik` suffix. The 294 detail fetches are optional
enrichment; the phone is already on the city page.

`robots.txt`: `Allow: /`, `Disallow: /admin*/`, `/pretraga/`, `/korisnici/`.

**Important:** mirandre and portal-srbija are almost certainly the same operator family —
identical robots.txt shape, identical city-slug scheme, and visibly overlapping listings
(Nikša Komerc, Termodom, Džavić, Domino all appear on both). Run both, but expect the
dedup step to collapse a large fraction. Do not treat 361 + 294 as 655 distinct businesses.

### 4. NaVidiku.rs — Stovarišta (`/firme/stovarista-<grad>`)

Smallest of the four, but the easiest adapter to write and the least likely to break.

- **24 `stovarista-<grad>` categories**, all fetched. **132 listings** (read off the site's
  own `Prikazano 1-N od M rezultata` counter), **111 distinct `tel:` numbers** — 84%.
- A further **34 `gradjevinski-materijal-<grad>`** and 4 `boje-fasade-i-lakovi-<grad>`
  subcategories exist and are _not_ counted in the 132 (spot-check: `gradjevinski-materijal-nis`
  has 3 firms, Kragujevac 28, Subotica 32).
- Whole-site company base is 13,408 detail pages across all industries.

**The trap here:** phone numbers do **not** appear in the rendered text. They live in
HTML-escaped `tel:` hrefs — `tel:+381184562323` next to a display label like `011/311-4324`.
A visible-text regex returns zero and makes this source look worthless; it isn't. Unescape
the HTML and parse `href="tel:..."`.

`robots.txt` disallows `/firme/ajax` and `/firme/noviajax` — the AJAX endpoints only. The
rendered `/firme/<category>-<city>` pages are allowed. Do not route around it via the AJAX
API just because it would be more convenient.

## OpenStreetMap — honest coverage assessment

The brief asked for a real Overpass query and its real result count for Serbia, not an
estimate. Here is the query, run 2026-08-19 (`osm_base` 2026-08-19T20:53:16Z):

```
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
(
  nwr["shop"="doityourself"](area.rs);
  nwr["shop"="hardware"](area.rs);
  nwr["shop"="trade"](area.rs);
  nwr["shop"="paint"](area.rs);
  nwr["shop"="building_materials"](area.rs);
  nwr["shop"="building_material"](area.rs);
  nwr["trade"="building_supplies"](area.rs);
);
out tags center;
```

POST it to `https://overpass-api.de/api/interpreter` as form field `data`.

**Result: 608 elements** (523 nodes, 81 ways, 1 relation).

| tag                       |   total |    name | **phone** | website |   email | addr:street |
| ------------------------- | ------: | ------: | --------: | ------: | ------: | ----------: |
| `shop=hardware`           |     297 |     264 |   **149** |     124 |      99 |         122 |
| `shop=paint`              |     113 |      92 |    **30** |      17 |       7 |          47 |
| `shop=doityourself`       |     112 |      94 |    **23** |      27 |       9 |          31 |
| `shop=trade`              |      60 |      51 |    **17** |      17 |      10 |          23 |
| `shop=building_materials` |      23 |      23 |    **18** |      13 |      12 |           5 |
| `shop=building_material`  |       3 |       3 |     **3** |       2 |       3 |           3 |
| `trade=building_supplies` |       0 |       0 |         0 |       0 |       0 |           0 |
| **ALL**                   | **608** | **527** |   **240** | **200** | **140** |     **231** |

The honest verdict is **Medium, and only 39% phone coverage**. 81 elements have no name at
all. `trade=building_supplies` returns nothing in Serbia, and `shop=building_material`
(singular) is a 3-element typo variant of the 23-element plural — neither is the local
mapping convention, so a scraper that queries only the "correct" tags will miss most of it.
The bulk sits under `shop=hardware`, which mixes genuine gvožđare with locksmiths and tool
shops, so classification noise is high.

Its real value is not volume. It is the **only source that gives lat/lon**, which makes it
the best geographic cross-check when deduping the directory sources — and, as it turned
out, the only reliable way to _discover_ chains (see below). Rate-limit it: five sequential
queries got HTTP-throttled during this research. Use one combined query and split locally.
ODbL attribution applies to anything derived from it.

## Chains

The brief predicted that chain "prodajna mesta" pages would be the highest-yield-per-effort
source in the project. **In this segment, that prediction did not hold**, and it is worth
recording why.

Chains were discovered empirically rather than by guessing brand names: counting repeated
`name` / `brand` / `operator` values in the 608-element OSM dump, then confirming each
operator's own domain. That found 11 chains with 3+ Serbian locations. Of those 11, **not
one publishes a plain-HTML store list carrying phone numbers on its own site.** Woby Haus
(the largest, 48 mapped locations) 404s on both `/prodajni-objekti` and
`/maloprodajni-objekti`; Uradi Sam serves 911,681 bytes with zero phone numbers; Metalac
Market's `/store-locations` is a 1 MB JS locator. The one complete chain list with phone
numbers found anywhere was a **third-party article** — `krov.rs`, which carries all 36 Woby
Haus addresses with numbers such as `BEOGRAD, Batajnica — Majora Zorana Radosavljevića 319,
011/787-05-05`.

| Chain                 | OSM locations | Published | Locator                           | Phones on locator                | Segment fit                |
| --------------------- | ------------: | --------: | --------------------------------- | -------------------------------- | -------------------------- |
| Woby Haus             |            48 |        36 | wobyhaus.co.rs                    | no (use krov.rs)                 | Partial — tools/DIY        |
| Doming / Domino       |            14 |         — | doming.rs                         | no (dominosrbija.com/kontakt: 3) | **Direct**                 |
| Uradi Sam / Уради сам |            14 |         — | uradi-sam.rs                      | no                               | Partial — DIY              |
| Würth Srbija          |             6 |         — | wurth.rs                          | no                               | Partial — B2B supply       |
| Dim Trade             |             5 |         — | dimtrade.rs                       | yes                              | **Direct**                 |
| Vanas                 |             4 |         — | vanas.rs                          | yes                              | **Direct** — paints/facade |
| SRMA Group            |             — |         4 | srmagroup.com                     | yes                              | **Direct**                 |
| Bojadex               |             3 |         — | boje-lakovi.com/prodajni-objekti/ | host did not resolve             | Partial — paints           |
| Darex                 |             3 |         — | darex.rs                          | yes                              | Partial                    |
| Luxel Plus            |             3 |         — | luxel.rs                          | yes                              | Partial                    |
| Metalac Market        |             — |        81 | market.metalac.com                | no                               | **None — out of scope**    |

Two findings from this table matter beyond the chain list itself:

- **Cyrillic/Latin transliteration is a real dedup problem, not a hypothetical one.** Uradi
  Sam appears 13× as `Уради сам` and 1× as `Uradi Sam`; Würth appears 3× as `Würth` and 3×
  as `Wurth`; `Farbara` / `Фарбара` splits 4/3. Name-based dedup must fold Cyrillic→Latin
  _and_ strip diacritics, or these chains fragment into separate leads.
- **SRMA Group is the pipeline's best end-to-end test case.** It appears on the Austrotherm
  distributor list, as a listing on portal-srbija, and on its own site — three sources, one
  business. If dedup on normalized phone collapses those three into one lead with three
  source URLs preserved, the merge logic works.

Metalac Market is listed for one reason only: it has the largest published store count of
anything found (81 outlets) and it tops every "maloprodajni lanac Srbija" search, so
without this note somebody will re-investigate it. It sells cookware, water heaters, sinks,
white goods and consumer electronics. It is not a building-materials outlet and would never
resell a facade panel. **Do not scrape it.**

## What was rejected, and why

A negative result recorded here saves the next agent a day. Ordered by how likely each one
is to be re-tried by someone who hasn't read this.

**KupujemProdajem.com — reject.** Serbia's most-cited classifieds site and a hard no.
`robots.txt` contains `Disallow: /phone_*` and `Disallow: /ad_phone_image.php`: the
advertiser's phone number is rendered as an **image**, served from a path robots.txt
explicitly forbids. Extracting it would mean fetching a forbidden path and OCR-ing an image
whose entire purpose is to prevent that. Titles and cities are scrapable, but a lead with
no phone is not a lead in this project.

**Daibau.rs — reject, same reason.** The number is fetched through
`/autosecretary/getPhoneNumber/`, which is `Disallow`ed. (Primarily a contractor
marketplace, so this finding is also relevant to FUZZ-4.)

**APR company registry — reject as a discovery source.** The brief asked for it explicitly,
so it was checked properly. Two independent disqualifications: `pretraga2.apr.gov.rs`
returns HTTP 403 to non-browser clients and is a JS SPA; and, more fundamentally, **the
public register does not publish a business telephone number at all** — it carries legal
name, matični broj, PIB, registered address and šifra delatnosti. Its genuine use is later,
offline, as an authority file for canonicalising company names and attaching a PIB to a
lead found elsewhere. The APR-derived _commercial_ directories (portal-srbija, navidiku,
011info) are where that same registry data becomes reachable **with** a phone attached.

**Bekament mix-centri — reject for now, and this one stings.** Serbia's largest domestic
ETICS manufacturer publishes its sales network at `/mix-centri/`, which would be an ideal
analogue to the Austrotherm list. The page serves 873,341 bytes containing exactly one
phone number — Bekament's own head office. The distributor list is injected client-side by
a "Slider Container > Repeater" widget and never reaches the static HTML. Would need
Playwright or reverse-engineering the widget's data endpoint. Austrotherm gives equivalent
data for free; go there instead.

**Knauf — closed on all three channels.** `knauf-distributeri.com` serves 42,910 bytes of
mostly WordPress CSS with no contact data; `knaufinsulation.rs/distributeri` and
`tools.knaufinsulation.com/sr-RS/tools/distributeri` both return HTTP 403.

**HaloOglasi.com — blocked, but not forbidden.** Its `robots.txt` actually permits an
honestly-named crawler under `User-agent: *` (only the named AI crawlers — GPTBot,
ClaudeBot, CCBot, Bytespider et al. — get `Disallow: /`). The Cloudflare WAF returns 403 to
non-browser clients regardless, including on `/sitemaps/sitemap.xml`. This is a technical
block, not a permission problem; revisit only if a Playwright budget is already being spent
elsewhere.

**stovarista.rs, aladin.info, izolacija.rs — zero phone yield.** All three rank well for
the target Serbian query terms and all three serve listing pages with no reachable contact
number (90,938 / 47,567 / 252,800 bytes respectively, zero phone-shaped strings in each).
`izolacija.rs` is thematically perfect and structurally useless: it profiles brands like
Austrotherm rather than listing the yards that sell them.

**yell.rs — data present, discovery path broken.** Profile pages genuinely carry a phone
(`/profil/woby-haus/` exposes `tel:021 472 2212`), but the sitemap declared in robots.txt
returns no entries and `/delatnost/gradjevinski-materijal/` answers HTTP 200 with a JPEG
body. With no working enumeration and a binding `Crawl-Delay: 10` (≈360 pages/hour), cost
per lead is far worse than the High sources for the same businesses.

**Google Places API — deferred, not rejected.** Paid, and there is no approval in FUZZ-5,
so per project cost policy it was not called. The free sources reach ~800–950 distinct
records; measure that first, then decide with numbers.

**Facebook / Instagram — out of bounds.** Login-gated. Social URLs found as a contact field
_on_ another source are fine to store; going to Meta to discover leads is not.

## Search terminology actually used

Every query was run in both diacritic and ASCII-folded form, per project rules:
`građevinski materijal` / `gradjevinski materijal`, `stovarište` / `stovariste`,
`građevinsko stovarište`, `građevinski centar`, `fasadni materijal`,
`termoizolacioni materijal`, `prodaja stiropora`, `izolacioni materijali`,
`prodajna mesta`, `maloprodajni objekti`, `maloprodajni lanac`, `distributeri`,
`gvožđara` / `gvozdjara`. The Cyrillic finding in the chains section above shows the
folding requirement extends past diacritics to full script transliteration.

## Volume arithmetic and the dedup caveat

| Source                   | Phone-bearing records |
| ------------------------ | --------------------: |
| Austrotherm distributeri |                   289 |
| portal-srbija stovarišta |                   361 |
| mirandre stovarišta      |                   294 |
| navidiku stovarišta      |                   132 |
| OSM (with phone tag)     |                   240 |
| 011info (Belgrade)       |                   ~40 |
| Chain locations          |                   ~68 |
| **Raw total**            |             **1,424** |

That 1,424 is a **sum, not a population.** portal-srbija and mirandre are the same operator
family; Austrotherm's distributors are largely the same businesses those directories list;
011info is Belgrade-only and overlaps almost entirely. After deduping on normalized phone
the realistic distinct count is **800–950**. That range is a projection from observed
overlap, not a measurement — the first pipeline run should replace it with a real number,
and that number is the input the Google Places decision should be made on.

## Top-3 recommendation

1. **Austrotherm `/distributeri`** — build this first. One request, 289 phone-carrying
   records, no JS, no pagination, and the tightest segment fit of anything found: every
   entry is a yard that already sells EPS. Best effort-to-lead ratio in the project.
2. **portal-srbija `/stovarista-<grad>`** — build second, for national reach. 112 towns,
   361 distinct numbers, everything on the category page, sitemap-driven discovery.
3. **mirandre `/stovarista/<grad>`** — build third, for the long tail. 161 city slugs and
   294 stores at ~100% phone coverage. Ship it _after_ portal-srbija specifically so the
   dedup logic is exercised against a source it heavily overlaps, rather than having both
   land at once.

navidiku is a close fourth and the cheapest adapter of the four — a reasonable first
implementation if the Scraper Engineer wants a small, well-structured target to validate
the adapter boundary before taking on the bigger crawls.
