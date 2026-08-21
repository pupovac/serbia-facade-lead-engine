# daibau.rs — full reconnaissance, and why no adapter was built

**Issue:** FUZZ-39 · **Date:** 2026-08-21 · **Author:** Scraper Engineer ·
**Outcome:** no adapter. The source cannot yield a phone number without breaking
`robots.txt`, and the project ranks sources phone-first.

## The one-line answer

**Contractor phone coverage is 0%, and the missing digits are behind an endpoint
`robots.txt` names in its first `Disallow` line.** Every other property of the
source is good — 748+ pre-filtered facade contractors, server-rendered HTML, no
bot challenge on listings — and none of it matters under the project's phone-first
rule.

This **confirms** the entry FUZZ-4 already filed for `daibau` in
`sources-contractors.json` on 2026-08-19 ("0% obtainable", "Do not scrape for
phones", priority Low). FUZZ-39 was opened on reconnaissance that read the same
two numbers as contractor phones; they are not. See
[Where the FUZZ-39 premise went wrong](#where-the-fuzz-39-premise-went-wrong).

## The phone, in detail

### Listing pages carry no contractor phone at all

59 listing pages were fetched and scanned: `fasade/beograd` pages 1–54, 12
adjacent category pages, and `fasade/{vranje,subotica,novi_pazar,zajecar,sombor}`.

| Measurement                                | Value |
| ------------------------------------------ | ----- |
| `href="tel:"` links found across all pages | 108   |
| distinct numbers behind them               | **2** |
| contractor numbers among them              | **0** |

The two numbers are `+381 11 418 26 07` and `+381 66 510 7 644`. They are
daibau's own switchboard, rendered site-wide in the footer help popup
(`div.popup3#contacts`), labelled `Potražnje:` (customer inquiries) and
`Preduzeća:` (companies). They appear exactly twice on every page of the site
regardless of which contractors it lists — which is the tell: 54 pages × 2 = 108.

### Detail pages truncate the number to 7 digits

Seven `/izvodjac/` profiles were fetched. Every one renders the phone as a
7-digit prefix followed by an ellipsis and the word `klik`:

```html
<div id="phoneNumToClick">
  <!--to delete-->
  0603460...klik
</div>
```

| Profile                      | Rendered     |
| ---------------------------- | ------------ |
| `raketic_zavrsni_radovi_doo` | `0603460...` |
| `rading_doo_beograd`         | `0645359...` |
| `pr_strahinja_color`         | `0611393...` |
| `estetik_gradnja`            | `0635914...` |
| `skalinada_design`           | `0649445...` |
| `novakovic_gradnja`          | `0643363...` |
| `core_invest_doo`            | `0655385...` |

A Serbian mobile is 9–10 digits, so 2–3 digits are withheld — 100 to 1000
candidates per contractor. The prefix is not a phone number and cannot be
completed by inference.

### The full number is doubly gated

1. **`robots.txt` disallows the reveal endpoint.** It is the _first_ rule in the
   file: `Disallow: /autosecretary/getPhoneNumber/`. The visible `Tel:` link
   points at `/izvodjac/<slug>/posalji_narudzbu`, which is disallowed too
   (`Disallow: *posalji_narudzbu*`).
2. **The reveal is CAPTCHA- and fingerprint-gated.** Profile pages load
   `challenges.cloudflare.com/turnstile/v0/api.js` and
   `daibau.rs/jsmodules/fingerprint2.min.js`.

Either one is disqualifying on its own under the project's compliance rules
("never ignore a `robots.txt` disallow", "never solve or bypass a CAPTCHA"). The
endpoint was **not** called during this research.

This is deliberate on daibau's part, not an oversight: routing the lead _is_
their business model.

### No email or website either

Profile pages publish no `mailto:`, no contractor website, and no social
profile. The only external links on a profile are daibau's own sister sites
(`emajstor.hr`, `mojmojster.net`). So the source cannot be rescued by
enrichment's own-site path — there is no site to start from.

## What the source would yield as names only

Complete national sweep of `fasade` anchored on Belgrade, 2026-08-21:

| Measurement                                   | Value                          |
| --------------------------------------------- | ------------------------------ |
| pages fetched                                 | 54 (51 populated, 52–54 empty) |
| unique contractors                            | **748**                        |
| distinct city strings                         | 218                            |
| Belgrade share                                | 263 / 748 (35%)                |
| phone / email / website coverage              | **0% / 0% / 0%**               |
| exact name matches in the 3,601-lead pilot DB | **12 (1.6%)**                  |

The 1.6% was measured with the project's own `normalizeCompanyName` /
`normalizedNameSimilarity`, not an ad-hoc fold. So these are genuinely _new_
businesses — which also means they cannot be used to upgrade the classification
of existing leads that already carry a phone. They would enter the database as
748 rows with a name and a city and no way to contact any of them.

## Crawl mechanics, for whoever revisits this

Recorded because it was measured, and re-measuring it costs another 60 requests.

- **Pagination** is `?page=N`, 15 cards per page. The pager does not publish a
  total — it only ever links `N+1`, so the end is found by walking until a page
  yields zero `.listbox.crli` cards.
- **Listings are national and distance-ranked, not city-scoped.** This is the
  non-obvious part. `/imenik/fasade/beograd` page 1 is 3–12 km away; page 20 is
  Obrenovac and Pančevo at 15–27 km; page 40 is Kragujevac, Kraljevo and Bačka
  Palanka at 63–98 km. A "city" page is a _ranking origin_, not a filter.
- **One anchor does not cover the country.** The Belgrade sweep caps out at 748.
  Page 1 of each far anchor adds contractors the Belgrade sweep never reached:
  Vranje +12, Subotica +13, Novi Pazar +13, Zaječar +11, Sombor +14 (of 15 each).
  A real national sweep needs a spread of anchors and slug-level dedup; the true
  total is plausibly 1,200–1,800.
- **The sitemaps are a generated matrix, not an index.** `sitemap_directory1..6`
  hold 252,545 `/imenik/<category>/<city>` URLs = 265 categories × 953 city
  slugs, cartesian. `sitemap_craftsmen.xml` holds 16,925 `/izvodjac/` profiles
  across all trades.
- **Listings need no JavaScript.** `GET /imenik/fasade/beograd` returns 322 KB of
  server-rendered HTML through Cloudflare with no challenge at ~1 req/1.3 s.
  cheerio would have been sufficient. (The registry's `requires_js: true` is
  right about the _phone_, not about the listings.)
- **Card structure**: `div.listbox.crli`; name in
  `a.crt.stretched-link > h3`; profile URL on that anchor; `span.subtt` holds
  `"<Category>, <City>"`; distance in a `location.svg` sibling.

## Category taxonomy

The issue asked whether adjacent categories are worth harvesting. Measured on
Belgrade page 1 of each, against the 748-contractor `fasade` set:

| Category                  | Cards | Already in `fasade` | Read                                         |
| ------------------------- | ----- | ------------------- | -------------------------------------------- |
| `malterisanje`            | 15    | 93%                 | same firms; almost no marginal yield         |
| `uduvavanje_izolacije`    | 15    | 67%                 | relevant, mostly overlapping                 |
| `dekorativni_malteri`     | 15    | 60%                 | relevant, facade finish                      |
| `ventilisane_fasade`      | 15    | 53%                 | relevant, competing system / same installers |
| `izolacija_potkrovja`     | 15    | 53%                 | insulation, partly facade crews              |
| `moleraj`                 | 15    | 47%                 | painters; broad                              |
| `zidarski_radovi`         | 15    | 47%                 | masons; broad                                |
| `drvena_fasada`           | 15    | 27%                 | timber cladding — different trade            |
| `metalne_fasade`          | 15    | 27%                 | metal cladding — different trade             |
| `ciscenje_fasada_krovova` | 15    | 20%                 | facade _washing_ — a classifier disqualifier |
| `termografija`            | 15    | 13%                 | thermal imaging — not a contractor           |
| `staklene_fasade`         | 15    | 0%                  | curtain walling — different trade            |

Had an adapter been built, the defensible set was `fasade`,
`ventilisane_fasade`, `dekorativni_malteri` and `malterisanje`. The bottom five
are trades `src/lib/classify` already treats as disqualifiers — `čišćenje
fasada` and composite cladding are `cancelsCore` signals — so harvesting them
would have fought the classifier.

## Where the FUZZ-39 premise went wrong

The issue's reconnaissance reported `tel:+381 11 418 26 07` and
`tel:+381 66 510 7 644` from the Belgrade listing as evidence that "the listing
page already contains the two things that matter", and noted the spaces inside
the `tel:` value as a parsing hazard. Both numbers are real and both are in the
HTML — they are simply daibau's own two office numbers in the footer, not
contractor numbers. The count is the giveaway: two numbers on a page of fifteen
contractors, unchanged on every other page of the site.

That single misreading is what promoted daibau from Low (where FUZZ-4 had
correctly placed it two days earlier) to "the highest-yield of the four new
sources".

## Recommendation

**Close FUZZ-39 without an adapter.** The sibling issue FUZZ-40 states the
disposal rule for exactly this case — "a source that yields 56 names and no
numbers is not worth an adapter … report it and close the issue instead of
shipping a name-only adapter" — and daibau is that case at 748 names.

Nothing here is worth a paid unblocker either. An unblocker defeats Cloudflare;
it does not make a `robots.txt` `Disallow` permissible, and the endpoint would
still be off-limits after any amount of spending.

If the 748 names are wanted anyway as a _target list_ — a set of businesses to
look for in sources that do publish phones, or to resolve against APR — that is
a different issue with a different acceptance test, and it should not write
uncontactable rows into `leads`.
