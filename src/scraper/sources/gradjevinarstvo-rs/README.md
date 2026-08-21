# `gradjevinarstvo-rs` — Gradjevinarstvo.rs, the company register

The second-ranked contractor source in `research/sources-contractors.json`, and
the **largest crawlable source in the project**: 11,291 company pages, one
request each.

|                         |                                                    |
| ----------------------- | -------------------------------------------------- |
| Entry URL               | `https://www.gradjevinarstvo.rs/firme-sitemap`     |
| Record URL              | `https://www.gradjevinarstvo.rs/firme/{id}/{slug}` |
| Category                | `construction trade portal with company register`  |
| Lead types              | `FACADE_CONTRACTOR`, `CONSTRUCTION_MATERIAL_STORE` |
| Requests per full crawl | **11,292** (the sitemap + one page per company)    |
| Requires JS             | no                                                 |
| Pagination              | none that may be used — see below                  |

## Why this source, after `portal-srbija`

A different population, reached a different way. `portal-srbija` enumerates
**facade categories** and finds the businesses that filed themselves under one.
This register enumerates **companies** and asks each one what it does.

That difference is not theoretical. `POPOVIĆ` in Kragujevac is filed under
`Izvođenje građevinskih radova`, `Malterisanje` and `Postavljanje toplotne
izolacije` — generic construction categories. The only text on the page that
says what the company actually is sits in the free-text note under one of those
categories:

> Specijalizovana ekipa za izvođenje fasaderskih radova (izrada
> termoizolacionih fasada od stiropora po sistemu Demit)

A facade-category walk does not reach that company. A company walk does, which
is why the note is parsed and folded into `description`, where
`src/lib/classify` reads it.

## `robots.txt`

Fetched 2026-08-20 and saved verbatim as `__fixtures__/robots.txt`:

```
User-agent: *

Disallow: /admin/
Disallow: /Kategorije/GetFirme/
Disallow: /FirmaDetaljiURL/
Disallow: /TekstDetaljiURL/
Disallow: /Pretraga/
Disallow: /Komentari/
Disallow: /VestDetaljiURL/
Disallow: /malioglasi/
Disallow: /PrintTekst.aspx*
Disallow: /firmadetalji.aspx*
Disallow: /Pretraga/PretragaVesti*
Disallow: /Pretraga/GetTekstoviZaPretragu/*
Disallow: /Pretraga/PretragaKategorijaPoTekstovima/*
Disallow: /Pretraga/GetFirme*
Disallow: /pretraga/GetVesti*
Disallow: /malioglasi/PrintOglas.aspx*
Disallow: /malioglasi/DetaljiOglasa/UnosOglasa.aspx*
Disallow: /news.aspx*

Sitemap: https://www.gradjevinarstvo.rs/sitemap_index.xml
```

Nothing here matches `/firme/{id}/{slug}` or `/firme-sitemap`, and the file
advertises its own sitemap index. The crawl uses the route the site publishes
for exactly this purpose.

### The disallow that decided the design

`Disallow: /Pretraga/GetFirme*` is the endpoint behind the "Prikaži više"
button on every category page. A category page renders its **first twenty**
companies server-side and loads the rest through that endpoint — so a category
can be read once and never paged without breaking the rule.

That ruled out the obvious cheap design: "walk the ten facade-relevant
categories, take their companies." It would have been ~10 requests and would
have carried a silent 20-per-category ceiling, reporting a healthy crawl of a
fraction of the register. The sitemap walk costs 11,292 requests and is
complete. Permitted and complete beat permitted and truncated.

## Page shape

One `div.col-md-12.left` contact card, holding a place line, a street line, and
then a run of `col-md-1` / `col-md-11` div pairs. The narrow half carries a
Font Awesome icon naming the field; the wide half carries the value:

```html
<div class="col-md-1 …"><i class="fa fa-align-left fa-phone"></i></div>
<div class="col-md-11 …">031 3868 000</div>
<div class="col-md-1 …"></div>
<!-- no icon: still a phone -->
<div class="col-md-11 …">031 3100 108</div>
```

An **empty** narrow cell means "same field as the row above". That is how a
company lists four numbers, and reading the pairs independently would keep only
the first — a quiet loss of every second-and-later number, which on this source
is where most of the mobiles are.

| Icon          | Field                                    |
| ------------- | ---------------------------------------- |
| `fa-phone`    | phone (repeats until the next icon)      |
| `fa-fax`      | fax — kept out of `phones` on purpose    |
| `fa-smile`    | contact person → `extra.contactPerson`   |
| `fa-home`     | website                                  |
| anything else | `extra.unreadFields`, keyed by icon name |

An icon this parser does not know is **kept, not dropped**. A source that adds
a field should show up as an unread field rather than as nothing.

Categories come from `a[role=link].color-gray.padding-5[href^="/kategorije/"]`.
That one selector covers both layouts the site uses — the `Kategorije za NAME`
heading on a plain page and the `KATEGORIJE` sidebar on a paid presentation —
and it does not match the site navigation or the footer, which link
`/kategorije/…` without those classes.

**No email anywhere.** Contact runs through an on-page form that POSTs to the
site. This is a phone-and-website source, which is what the product asks for.

## Serbia only

The register is regional, not Serbian. The place line names the country, and
`SKUPŠTINA OPŠTINE` prints `74470 VUKOSAVLJE, BIH` with three `+387` numbers.
A record whose card names a country other than `SRB` is not emitted, and the
count of those is logged at the end of every walk — a filter nobody can see is
indistinguishable from a parser that lost the records.

A card with **no** country named is kept. If the template ever stops printing
the field, dropping the whole register is the wrong failure.

## Cost, and re-runs

One request per company, ~11,300 of them: a little over three hours at one per
second. That is paid once. Items carry the standard 14-day staleness window, so
a second run re-fetches almost nothing, and the walk records its position every
50 companies — a run stopped by `--limit`, by the request budget or by a signal
resumes at the next company id.

The cursor is a **company id**, not an index into the sitemap, because the
sitemap grows between runs and an index would silently skip whatever was added
in front of it.

One deliberate subtlety: the cursor records the last company the walk
_completed_, not the last one it handed over. A generator interrupted at a
`yield` has produced an item the runner has not extracted yet — `--limit` and
the request budget are both checked before the fetch — so recording it as
reached would lose that company. It is re-yielded next run instead, and the
item-level staleness window makes the repeat free.

## What it yields

Measured over 2,885 companies — 25.6% of the register, crawled 2026-08-20/21 in
two strata (the oldest ids and the newest, so the sample is not all
long-established firms):

|                              |                   |
| ---------------------------- | ----------------- |
| Companies read               | 2,885             |
| Dropped as non-Serbian       | 863               |
| Records emitted              | **2,022**         |
| …carrying a phone            | **2,018** (99.8%) |
| Rejected at the zod boundary | 0                 |
| Distinct E.164 numbers       | 5,991             |
| Leads with a website         | 1,568             |
| Municipalities covered       | **145 of 145**    |

99.8% phone coverage, against the registry's ~90% estimate. The difference is
the multi-phone run: reading only the first number in each card would have
thrown most of the mobiles away.

The 863 drops are all from the low-id end, which is **45% ex-Yugoslav and
foreign**; the modern end is 99.1% Serbian. Budget the remaining pages knowing
the old half costs nearly twice as much per usable record.

**Overlap against the leads already in the database** (`portal-srbija` +
`overture-places`, 2,072 leads): **9.9% already known, 6.2% needs review, 83.9%
new** — decided by phone on 169 of the 200 matches. On the facade-relevant slice
alone the overlap is 29%. The full measurement, its caveats and what it implies
for the source roadmap are in
`docs/runs/2026-08-20-fuzz-18-gradjevinarstvo-rs.md`.
