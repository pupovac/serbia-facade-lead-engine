# `austrotherm-distributeri` — Austrotherm Srbija, Distributeri

The top-ranked construction-material-store source in
`research/sources-stores.json`, and the cheapest source in the project:
**one GET returns the whole dataset.**

|                         |                                                             |
| ----------------------- | ----------------------------------------------------------- |
| Entry URL               | `https://www.austrotherm.rs/distributeri`                   |
| Category                | `manufacturer_distributor_list`                             |
| Lead type               | `CONSTRUCTION_MATERIAL_STORE`                               |
| Requests per full crawl | **2** (`robots.txt` + the page)                             |
| Requires JS             | no                                                          |
| Pagination              | none — the whole A–Z list is inlined in one 266 kB document |

## What it yields

Measured against `__fixtures__/distributeri.html`, saved from the live page on
2026-08-20:

|                                                     |                 |
| --------------------------------------------------- | --------------- |
| `div.dealer` rows on the page                       | 325             |
| Serbian records emitted                             | **292**         |
| …carrying a phone number                            | **290** (99.3%) |
| …carrying coordinates and a Maps link               | 291             |
| Distinct phone numbers                              | 271             |
| Distinct company names                              | 227             |
| Distinct city strings                               | 137             |
| Dropped: Montenegro (`+382`)                        | 30              |
| Dropped: map-widget templates                       | 2               |
| Dropped: the `Distributeri CRNA GORA` separator row | 1               |

Through the pipeline, on a real run against a fresh database (2026-08-20):
292 records → **265 leads** (27 branch rows merged onto a lead already found),
263 of them with a phone, **272 distinct E.164 numbers** (211 landline,
61 mobile), 262 leads resolved to **83 municipalities**, 279 `google_maps`
contacts, 264 classified `CONSTRUCTION_MATERIAL_STORE` and 1 `BOTH`,
0 records rejected at the zod boundary.

Volume is not why this source ranks first — segment fit is. A yard on
Austrotherm's distributor list is, by definition, a business that already
stocks and resells EPS facade insulation to the customers our panel targets.

## `robots.txt`

Fetched 2026-08-20 from `https://www.austrotherm.rs/robots.txt` and saved
verbatim as `__fixtures__/robots.txt`. The rules, in full:

```
User-agent: *
Disallow: /*?id=*
Disallow: /*&id=*
Disallow: /*?L=0*
Disallow: /*&L=0*
Disallow: /*?type=98*
Disallow: /*&type=98*
Disallow: /*/Private/*
Disallow: /fileadmin/templates/html/*
Disallow: /*/Configuration/*
Disallow: /typo3temp/*
Allow: /typo3temp/*.css$   (…and .css.gzip, .js, .js.gzip, .jpg, .gif, .png)
Disallow: *.sql
Disallow: *.sql.gz
Disallow: /kalkulator/
Disallow: /?_ga*
Disallow: /?_gl*
Sitemap: /sitemap.xml
```

**No rule matches `/distributeri`.** The `Disallow`s cover TYPO3 internals, the
print view, the SQL dumps, the calculator and analytics-decorated URLs. This
adapter requests exactly one content path and never appends a query string, so
it cannot drift into `?id=` or `?_ga` territory. Unchanged since the FUZZ-5
research pass.

## Rate limit

`requestDelayMs: 3000`, `requestBudget: 25` — both gentler than the environment
default (1500 ms / 5000), which is the only direction an adapter may move them.
A source that needs two requests has no business holding a 5000-request fuse,
and a 3 s spacing on a small Serbian corporate site costs this crawl six seconds
in total.

## Reading the page

Each dealer is one `div.dealer` under `#dealers-list`:

```html
<div data-dealer="1" class="dealer" data-latitude="43.305177" data-longitude="21.775493">
  <div class="header">
    <span class="text hl">21 MAJ</span><br />
    <span class="text address">Mramorsko brdo bb, 18000 Niš</span>
  </div>
  <div data-details="1" class="details text">… T +381 (0)18 469 40 13 …</div>
</div>
```

Four things about this page are worth knowing before changing the parser.

**Montenegro is interleaved, not appended.** A `Distributeri CRNA GORA` row
sits at position 69 of 325 with a rule of dashes where its address belongs —
and 229 Serbian rows follow it. Splitting the list there is the obvious reading
and it is wrong. The country comes from the `+38x` calling code on the phone
line, with the postal code (Serbia `1xxxx`–`3xxxx`, Montenegro `8xxxx`) as the
fallback for the three rows that print no usable phone.

**The map widget leaves two empty prototypes** at the head of the list — no
name, `data-latitude="0"`. They are skipped and counted, so "two rows dropped"
can never quietly become "two hundred".

**The phone is anchored on its `T` prefix.** One row prints a fax behind an `F`
on the same line (`… 414 847 F +381 (0)63 106 20 39`) and a fax is not the
number a salesperson dials. The full line still reaches the record as `text`,
so `src/lib/contact` can read whatever the field deliberately does not. Two
Serbian rows have an unusable phone field — `T Kršumlija`, and one that is
simply empty. They are emitted **without** a phone rather than with a coerced
one; a named yard at a known address is still a lead.

**Coordinates, not a Maps link.** This page publishes no `maps.google` URL. It
publishes `data-latitude` / `data-longitude` on every real row, which is
strictly better. Those travel on the record's modelled `latitude` / `longitude`,
and the Google Maps URL the store sheet wants is written from them as
`https://maps.google.com/?q=<lat>,<lon>` — the coordinates as published, in URL
form, with nothing added. `src/lib/contact` reads that link and canonicalizes it
to `https://www.google.com/maps/search/?api=1&query=<lat>,<lon>`, which is the
`google_maps` contact the store sheet reads.

The `?q=` form is deliberate: `src/lib/contact` recognises coordinates under
`q`, `destination`, `daddr`, `ll` and `center`, but **not** under `query` — so
it cannot currently re-read the canonical URL it emits itself. That round-trip
gap is the Data Engineer's to close; this adapter hands the shared extractor a
URL it can parse rather than deciding the canonical form on its own.

Because the URL is derived rather than published, every record that carries one
also carries `extra.googleMapsUrlDerivedFrom = 'data-latitude/data-longitude'`.
One row is published at `0,0`, and gets neither coordinates nor a link.

## Failing loudly

Three saved fixtures pin the ways this source could break while still returning
a healthy 200:

| Fixture                                 | What it is                                     | What must happen                                                                                                |
| --------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `distributeri-redesigned.html`          | the same dealers rendered as `li.dealer-card`  | `StructureChangedError` on `#dealers-list div.dealer`                                                           |
| `distributeri-template-only.html`       | the map widget's prototypes and nothing else   | `StructureChangedError` — a list with no names is not an empty list                                             |
| `distributeri-phones-behind-links.html` | markup intact, numbers moved into `tel:` hrefs | `StructureChangedError` — 290 of 292 rows carry a visible phone, so a page where fewer than half do has changed |

The third is the NaVidiku trap the FUZZ-5 research flagged, applied here as a
guard: without it this parser would report 292 healthy, phoneless leads and the
source would look like it was working.

## Compliance

Public business-contact data published by Austrotherm about its own trade
partners: company name, business address and a business phone. No login, no
CAPTCHA, no paid API, nothing behind a `Disallow`. The crawler identifies itself
honestly on every request. Records are per-source-URL provenanced to
`/distributeri`, which is a page anyone can re-open and check.

## Running it

```bash
npm run scrape -- --source austrotherm-distributeri --dry-run
npm run scrape -- --source austrotherm-distributeri --city nis --city beograd
```
