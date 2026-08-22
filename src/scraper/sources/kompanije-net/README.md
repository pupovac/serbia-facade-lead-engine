# `kompanije-net` — Kompanije.net Srbija

An APR-derived national business directory, indexed by KD-2010 activity code.
The largest free contractor source in the registry and the only one that reaches
**preduzetnici** at scale.

- **Base URL** — `https://www.kompanije.net`
- **Lead types** — `FACADE_CONTRACTOR`, and `CONSTRUCTION_MATERIAL_STORE` from
  `46.73` (FUZZ-46)
- **Rendering** — static HTML, `cheerio`. No JavaScript anywhere in the crawl
  path; the only scripts on the page are AdSense, Google Analytics and a
  Facebook like button.
- **Records** — 9,830 under the five core contractor codes, plus 13,095 under
  the six codes FUZZ-46 widened the crawl to. 22,925 in all, ~9.5 hours at the
  crawl's 1.5 s spacing.
- **Registry entry** — `research/sources-contractors.json`, id `kompanije-net`,
  researched by FUZZ-41 and cleared on terms by FUZZ-44.

## Why it is worth 9,830 requests

Every other contractor source in the registry is a _marketing_ surface: a
business is in it because it chose to advertise. This one is register-derived,
so being listed required nothing of the business at all — which is why it
reaches the sole traders who have no website to scrape and no directory listing
to find.

FUZZ-41 counted 9,830 records under the five core codes against **2,290 active
companies in the same codes in APR's own open data**. The ~7,540 difference is
preduzetnici, the population APR open data does not cover and this project calls
its largest structural coverage gap.

FUZZ-45 sampled 2,000 of those records — 400 per core code — and measured it:

| Measured on 2,000 core-code records | Fill                  |
| ----------------------------------- | --------------------- |
| a phone number                      | 1,278 — **63.9%**     |
| matični broj                        | 1,985 — 99.3%         |
| PIB                                 | 1,492 — 74.6%         |
| resolved to a municipality          | 94.4%                 |
| a website                           | 4 of 2,320 — **0.2%** |
| sole traders (`preduzetnik`)        | 1,439 — **71.9%**     |

Extrapolated to the full 9,830, that is **~6,280 phone-bearing contractor
records for 0 RSD**, roughly three in four of them businesses no marketing-led
directory can reach. Against a 3,024-lead reconstruction of the pilot corpus,
**95.3% of what this source publishes was new** — 1.2% merged, 3.5% landed in
the review band.

The 0.2% website fill is not a defect: it is what the source is. The `Sajt:`
field is genuinely empty on almost every record, and a parser that reported
otherwise would be reading the prose underneath it (see _Parsing_).

## Compliance

| Check            | Verdict                                                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `robots.txt`     | **Allowed, by absence of any rule.** HTTP 200, 1,248 bytes, containing _only_ the Cloudflare content-signals comment header — no `User-agent` line, no `Disallow`, and no content-signal values set. Nothing restricted, nothing granted by signal. Re-fetched and re-read 2026-08-21 for FUZZ-45. |
| Terms of service | **None exist.** The footer carries region links and a `kontakt.php` form; there is no `uslovi`, `pravila`, `impressum` or privacy page anywhere on the site. Verified by FUZZ-44.                                                                                                                  |
| Login / CAPTCHA  | Neither. Unlike `pretraga.apr.gov.rs`, this host serves an honest User-Agent normally.                                                                                                                                                                                                             |
| Rate limit       | The framework default, 1 request per 1.5 s per host — gentler than the ≤1 req/s the source was cleared for. The adapter sets no `requestDelayMs` of its own, because an adapter may only ask for gentler and 1.5 s already is.                                                                     |
| Personal data    | Most records are sole traders, so a business phone is personal data under ZZPL. Only business-contact data the business itself published is collected; provenance is per record and per field, and every record carries its exact `sourceUrl`.                                                     |

## The crawl

```
GET /Srbija/d4_GRAĐEVINARSTVO.html        once per run — resolves l<id> → category URL
GET /Srbija/l70_Malterisanje.html         once per category — 138 kB, all 900 detail links
GET /Srbija/acalend/26011                 once per record
```

**There is no pagination.** Every record in a category renders on one static
page, so discovery is one request per category and extraction is one request per
record: ~9,835 requests for the core five, a little under three hours at 1.5 s
spacing.

The framework's default request budget is 5,000, which is _below_ one full
crawl. Pass `--budget 12000` for a complete run, or let the default stop it
partway — the scope cursor is written every 100 items and the next run resumes
where it stopped.

```bash
npm run scrape -- --source kompanije-net --limit 20 --dry-run   # writes nothing
npm run scrape -- --source kompanije-net --budget 12000         # the full core five
npm run scrape -- --source kompanije-net --query 43.31          # one activity code
npm run scrape -- --source kompanije-net --city novi-sad        # see below
```

`--city` cannot narrow this crawl — the index carries only names, so a page has
to be fetched before its place is known. It still decides whether a record is
_emitted_, so a city-scoped run is honest about what it returns but costs the
same as a national one.

### Activity codes

The default crawl is the five core contractor codes. Everything else is opt-in
with `--query`, either **one code** — by code (`43.91`), šifra (`4391`) or list
id (`l75`) — or **a whole tier** by name: `core`, `widened`, `adjacent`.

| Code    | List | Sec.  | Category                                        | Records | Asserts                       | Tier     |
| ------- | ---- | ----- | ----------------------------------------------- | ------- | ----------------------------- | -------- |
| `43.31` | l70  | `d4`  | Malterisanje                                    | 900     | `FACADE_CONTRACTOR`           | core     |
| `43.34` | l73  | `d4`  | Bojenje i zastakljivanje                        | 2,619   | `FACADE_CONTRACTOR`           | core     |
| `43.29` | l69  | `d4`  | Ostali instalacioni radovi u građevinarstvu     | 652     | `FACADE_CONTRACTOR`           | core     |
| `43.39` | l74  | `d4`  | Ostali završni radovi                           | 2,880   | `FACADE_CONTRACTOR`           | core     |
| `43.99` | l76  | `d4`  | Ostali nepomenuti specifični građevinski radovi | 2,779   | `FACADE_CONTRACTOR`           | core     |
| `23.64` | l197 | `d6`  | Proizvodnja maltera                             | 40      | —                             | widened  |
| `46.73` | l548 | `d20` | Trgovina na veliko drvetom i građ materijalom   | 1,486   | `CONSTRUCTION_MATERIAL_STORE` | widened  |
| `43.33` | l72  | `d4`  | Postavljanje podnih i zidnih obloga             | 2,121   | —                             | widened  |
| `41.20` | l56  | `d4`  | Izgradnja stambenih i nestambenih zgrada        | 5,663   | —                             | widened  |
| `71.11` | l573 | `d24` | Arhitektonska delatnost                         | 499     | —                             | widened  |
| `71.12` | l574 | `d24` | Inženjerske delatnosti i tehničko savetovanje   | 3,286   | —                             | widened  |
| `43.91` | l75  | `d4`  | Krovni radovi                                   | 329     | —                             | adjacent |
| `43.32` | l71  | `d4`  | Ugradnja stolarije                              | 551     | —                             | adjacent |

Record counts are exact — `a.cat-list` company links counted on each category
index page, the core five on 2026-08-21 and the widened six on 2026-08-22.

```bash
npm run scrape -- --source kompanije-net --budget 12000            # the core five
npm run scrape -- --source kompanije-net --query widened --budget 14000
npm run scrape -- --source kompanije-net --query core widened --budget 25000
npm run scrape -- --source kompanije-net --query 71.12             # one code
```

An unrecognised `--query` **raises** rather than falling back to the core five:
a run asked for `43.21` and given `43.31` would report numbers for a category
nobody asked about.

#### Why `widened` is not name-filtered, and why FUZZ-45's yield metric is gone

FUZZ-45 scored the adjacent codes by **facade-named share** — the share of
sampled records whose registered name contains `fasad`, `termoizolac`,
`stiropor`, `demit`, `izolacij` or `malteris` — and used it to decide what to
skip. On that metric `41.20` and `43.33` scored 0% in 80 records each and were
parked.

**That metric is superseded for these six codes.** The member asked for every
record in them regardless of name: a builder trading as `GRADNJA DOO` is exactly
the lead a name filter drops, and a name is not what makes these records useful
— the activity code is. The numbers are still in `categories.ts` as evidence for
a human; nothing reads them.

#### Why most of the widened codes assert nothing

The FUZZ-38 epic rule is that an adapter under the epic sets `FACADE_CONTRACTOR`
from source provenance rather than from a name. It holds where the code _is_ the
evidence — `43.31 Malterisanje` is rendering a wall — and `46.73` is the same
argument for the other buyer group: trading building materials wholesale is the
definition of buyer group 2.

It does not extend to the rest. `71.12 Inženjerske delatnosti` is not evidence
of a fasader, and asserting it would file 3,286 engineering firms and 5,663
general builders in the corpus as facade contractors. So `41.20` and `43.33` go
through `src/lib/classify` on their name like any general directory record, and
`23.64`, `71.11` and `71.12` are neither buyer group — they are a distinct
segment, and `leads.activity_code` is what identifies them. **`UNCLASSIFIED` is
not a failure for these records.**

One extra guard, on the widened codes only: when the detail page prints a šifra
that contradicts the index the record was found on, the assertion is **withdrawn**
and the record goes to the classifier instead. The category asserts because the
code is the evidence, and a page that names a different code has withdrawn it.
The core five keep FUZZ-45's behaviour unchanged — their numbers were measured
and accepted with the assertion made from the discovery category.

#### The index chain

No URL in the chain is assembled from a constant; each is read off the page
above it, because every slug on this site carries diacritics and the site has
changed them before.

```
GET /Srbija/                             once per run  → d<id> → section URL   (a.cat-link)
GET /Srbija/d6_INDUSTRIJA.html           once per section → l<id> → category URL (a.cat-list)
GET /Srbija/l197_Proizvodnja-maltera.html  once per category → every detail link
```

FUZZ-45 hard-coded the one section it needed. FUZZ-46's codes sit in four
sections — `d4 GRAĐEVINARSTVO`, `d6 INDUSTRIJA`, `d20 TRGOVINA-NA-VELIKO`,
`d24 USLUŽNE-DELATNOSTI` — and hard-coding four more slugs carrying `Đ`, `Ž` and
a Serbian digraph would have put four more ways to 404 a five-hour crawl into a
constants table. The chain costs two requests for a core run and five for the
widened six, against 13,095 detail fetches, and only the sections a run still
needs are fetched. A missing section link or a missing category link raises
`StructureChangedError` naming what went missing.

### Two surfaces

| Surface  | Index                                             | Detail URL                         | Reaches record id |
| -------- | ------------------------------------------------- | ---------------------------------- | ----------------- |
| `modern` | `/Srbija/l70_Malterisanje.html`                   | `/Srbija/<slug>/26011`             | 382240            |
| `legacy` | `/preduzetnici/preduzetnici.php?delatnost=433100` | `/preduzetnici/p127306_<slug>.htm` | ~335903           |

They are snapshots of different vintages and **their detail markup is
identical**, so one parser serves both and every record carries
`extra.surface`.

The modern surface is the crawl. The legacy one is opt-in
(`--query legacy`, which adds it to whatever categories were selected) because
settling what it actually adds needs matični broj, not names. Measured on
`43.31`: the legacy index holds 852 records to the modern index's 900, and
comparing on a 40-character name prefix leaves ~306 of the 852 (36%) unmatched
— but the two surfaces order a personal name differently (`NEŠIĆ PREDRAG
PREDUZETNIK` against `PREDRAG NEŠIĆ PR`), so 36% is a ceiling on the gap and not
a measurement of it. The five legacy indexes hold 8,001 records in total.
Deciding it properly is a second ~8,000-request crawl, and it should be spent on
a measured gap rather than a suspected one.

## Parsing

The detail page is a `div.row-fluid` list of `div.span3` (label) /
`div.span9.bold` (value) pairs — a _structural_ label/value list, not a list of
lines. That distinction is what makes two of FUZZ-41's four traps disappear
rather than need guarding.

| Trap FUZZ-41 named                      | What happens here                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anchors use single quotes               | Every href is read through cheerio's attribute access, which does not care.                           |
| Label/value list                        | Read as `div.span3` → `div.span9`, so field order and blank cells are irrelevant.                     |
| A blank field falls to the _next_ label | A blank field is an empty value cell. `looksLikeLabel` rejects any value ending in `:` anyway.        |
| `Sajt:` is followed by a prose sentence | The sentence is outside the field block. A website is emitted only if it survives `looksLikeWebsite`. |

Two more the fixtures pin down and the research pass did not name:

- **The legacy slug can contain a slash.** A Serbian street number is written
  `PRVOMAJSKA 1/A`, and the slug embeds the address — 65 of the 852 records in
  `43.31` have one. Anything that treats the slug as a single path segment drops
  them silently.
- **Two record layouts.** A privredno društvo prints `Forma:`, `Status:` and a
  structured address (`Opština: … | Mesto: … | Ulica i broj: …`); a preduzetnik
  prints none of the three and one free-text address line. Both are the same row
  list, so only the address is parsed two ways.

### What is asserted

`parseCompany` raises `StructureChangedError` when the field block is missing,
when `Pun naziv:` has no value, or when **any** of the eight labels every record
on both surfaces prints goes missing:

```
Pun naziv:  Adresa:  Telefon:  Matični broj:  PIB:  Šifra delatnosti:  Naziv delatnosti:  Sajt:
```

`Forma:` and `Status:` are deliberately **not** in that set — a sole trader
prints neither, and demanding them would break the run on the majority of this
source. The label assertion is the one that earns its keep: a template that
renames `Telefon:` would otherwise produce a perfectly healthy run of records
with no phone, which is this source's entire value going to zero quietly.

### Phones

`+381.(0)64.4320025`, or `+381 (0)62 629230`, or `+381.(063)7193382`,
comma-separated when a record has several and sometimes with a trailing comma.
The adapter splits on the comma — `src/lib/phone` rejects the joined string and
reads either half perfectly, `.(0)` shim included — and changes nothing else.
Normalization is `src/lib/phone`'s and is not reimplemented here.

### The APR activity category

Every detail page prints both halves of the state's own classification:

```
Šifra delatnosti:   4331
Naziv delatnosti:   Malterisanje
```

FUZZ-46 carried them to the database as `leads.activity_code` /
`leads.activity_name` — two columns, because the code is what you filter and
join on and the name is what a human reads. Both are nullable and additive:
every other source leaves them null, nothing is backfilled, and null means "this
source does not publish an activity code", not "unknown".

They are stored **exactly as the page printed them**, with per-field provenance
like any other single-valued fact. Three things are deliberately not done:

- **The page's code is not reconciled against the index it was found on.** They
  disagree on a real share of records — `MET INŽENJERING 021`, found on the
  `23.64 Proizvodnja maltera` index, prints `3832`. The lead carries the page's
  code, `extra.categoryCode` carries the index's, and `extra` also flags the
  disagreement. Both are evidence; neither is a correction of the other.
- **It is not reconciled against APR open data either.** FUZZ-45 measured those
  two disagreeing on 52 of 329 records matched on matični broj. A later
  enrichment pass can decide; a write-time guess would destroy what it needs.
- **A malformed value is not promoted.** Only a four-digit value reaches
  `activity_code`; anything else stays in `raw_records`. A lead is worth having
  for its phone number whatever the register did to its activity field.

The review UI filters on the code (`/leads?delatnost=7111`) and shows the name
as a column. That filter is the reason the field exists: `41.20` and `71.11`
mostly classify as nothing from their names, and the code is the only thing that
separates an architect from a general builder from a fasader.

### Place

A sole trader's `Mesto` is very often a village (`Stubline`, `Milutinovac`) and
no gazetteer resolves a village on its own. The page states the opština in the
same sentence — "Nalazi se u opštini Obrenovac u mestu Stubline." — so `city` is
emitted as `Mesto, Opština`, the shape `src/lib/normalize` already reads.
Resolving it is still `src/lib`'s job.

## What this adapter does not do

- **It does not use `Status:` as a liveness filter.** That field exists only on
  the company layout, so filtering on it would silently drop every sole trader —
  the population this source exists for. The value is kept in `extra.status` and
  the freshness question is answered downstream against APR open data.
- **It does not emit an email.** The template has no email field. A name, a city
  and a phone is a good lead.
- **It does not fetch daibau.rs or companywall.rs.** Both are closed on terms
  (FUZZ-44), and neither is needed: this source publishes matični broj itself.

## Data quality — carry these downstream

- **The source is stale, and now there is a number for it: 54% of the company
  records are dead.** The footer reads "© Kompanije.net 2014" and neither
  surface carries a date, so FUZZ-45 measured it against APR open data on
  matični broj. Of the 650 sampled records carrying a **company** registration
  number, 297 are still trading, 32 are in liquidation or bankruptcy, and 321
  have been struck off the register entirely — **54.3% dead or dying**.
  `AGMAX DOO BEOGRAD (ČUKARICA)` is listed here as `Aktivno privredno društvo`
  and does not appear in APR's register at all.

  Two limits on that number, both load-bearing. It covers the 28% of records
  that are companies, because APR open data is privredna društva only; the 72%
  that are sole traders **cannot be checked against any free register**, and
  that is precisely what an APR purchase would buy. And "dead" here means
  deregistered, not unreachable — a struck-off company's owner often still
  answers the phone as a preduzetnik. Treat the 54% as a warning about export
  quality, not as a discard rule.

  Re-derive it with `npx tsx scripts/fuzz45-overlap.ts <crawl.sqlite>
<baseline.sqlite> <apr-companies.json>`.

  **The company/sole-trader split is read off the registration number, not off
  the page.** All 133,634 matični brojevi in APR open data begin 0, 1 or 2; a
  preduzetnik's begins 5 or 6. The page's own `Forma:` field is not a
  substitute — only 92 of the 650 company-number records printed one.

- **A phone may be user-submitted.** The site invites visitors to edit a
  company's record (`Izmeni podatke`), and the `+381.(0)NN.NNNNNN` shape
  suggests a bulk telephone-directory join rather than APR's registered kontakt
  podaci. Treat every number as needing first-call verification; do not score
  these as registrar-grade.
- **Dedup risk against `apr-opendata` is real but bounded: 14.3% measured.**
  Both are APR-derived, and 329 of the 2,302 distinct matični brojevi sampled
  are in APR open data — the ceiling is the 28% of records that are companies at
  all. `src/lib/dedup` already weights `registrationNumber` at 0.98, so the join
  happens without special-casing. It costs nothing either way: `apr-opendata`
  carries no phone, so a match adds a registered name and municipality to a lead
  this source already brought a number for. On 52 of those 329, APR's registered
  activity code disagrees with the category the record was found in.

- **Overlap with the directories already harvested is near zero: 1.2%.**
  Measured with `findCandidates` + `scoreMatch` against a 3,024-lead corpus of
  `overture-places`, `gradjevinarstvo-rs`, `portal-srbija` and
  `austrotherm-distributeri`. 27 of 2,320 merged (13 decided on phone, 14 on
  name + city), 82 landed in the review band, 2,211 were new. That is the
  register-versus-marketing split showing up as a number.

## Fixtures

Real pages saved 2026-08-21 (FUZZ-45) and 2026-08-22 (FUZZ-46), byte for byte:

| File                                                                                               | What it is                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `country-index-srbija.html`                                                                        | `/Srbija/` — the 26 sections, under `a.cat-link`.                                                                                                                                                             |
| `section-index-gradjevinarstvo.html`                                                               | The `GRAĐEVINARSTVO` index; 22 activity codes.                                                                                                                                                                |
| `section-index-industrija.html`                                                                    | `d6` — where `23.64 Proizvodnja maltera` lives.                                                                                                                                                               |
| `section-index-trgovina-na-veliko.html`                                                            | `d20` — where `46.73` lives.                                                                                                                                                                                  |
| `section-index-usluzne-delatnosti.html`                                                            | `d24` — where `71.11` and `71.12` live.                                                                                                                                                                       |
| `category-l197-proizvodnja-maltera.html`                                                           | The `23.64` category page — all 40 detail links.                                                                                                                                                              |
| `detail-l56-…`, `detail-l72-…`, `detail-l197-…`, `detail-l548-…`, `detail-l573-…`, `detail-l574-…` | One live page from each of the six widened codes, saved 2026-08-22 **before** the crawl was launched. They exist to answer one question: does a section outside `d4` print the same eight labels? All six do. |
| `category-l70-malterisanje.html`                                                                   | The `43.31` category page — all 900 single-quoted detail links.                                                                                                                                               |
| `category-legacy-433100.html`                                                                      | The legacy `43.31` index — 852 links, 65 with a slash in the slug.                                                                                                                                            |
| `detail-agmax-company.html`                                                                        | A fully populated privredno društvo: `Forma`, `Status`, structured address, phone, MB, PIB, `Članovi`.                                                                                                        |
| `detail-acalend-sajt-prose.html`                                                                   | A preduzetnik with an empty `Sajt:` followed by the prose sentence.                                                                                                                                           |
| `detail-matis-nis-blank-pib.html`                                                                  | A preduzetnik with a blank `PIB:` — the fall-through trap.                                                                                                                                                    |
| `detail-multi-phone.html`                                                                          | Two comma-separated numbers in one field.                                                                                                                                                                     |
| `detail-legacy-prizma.html`                                                                        | The legacy surface, proving the markup is the same.                                                                                                                                                           |
| `detail-sajt-populated.html`                                                                       | The other half of trap 4 — a record that really does publish `www.abode.rs`.                                                                                                                                  |

Two are **derived**, and say so in their names: `category-redesigned.html` and
`detail-redesigned.html` are the real pages with one thing broken, and they
exist to prove the adapter raises rather than reporting a healthy crawl of
nothing. When the real source changes, re-save the fixture and fix the selector
— never loosen the assertion.
