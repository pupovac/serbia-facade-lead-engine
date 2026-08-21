# FUZZ-22 — the 30-lead manual spot check

Sample drawn by `scripts/fuzz22-spotcheck.ts` with seed 22, stratified by source
in proportion to each source's share of the corpus, from the 3,179 active leads
that existed after `portal-srbija`, `overture-places`,
`austrotherm-distributeri` and `gradjevinarstvo-rs` stratum A had finished and
before stratum B was added. Every lead below was checked by hand against a page
a human can open, and the errors are listed individually.

## What "verified" means here, and why six leads could not be

`gradjevinarstvo-rs`, `portal-srbija` and `austrotherm-distributeri` publish a
per-company page, so the stored phone, city and address were compared against
that page directly. **`overture-places` does not.** Its `source_url` is
`https://overturemaps-us-west-2.s3.../theme=places/type=place/#<gers-id>` — an
S3 object prefix with a GERS id in the fragment. It is not a page; it does not
render; a reviewer in the FUZZ-25 UI cannot click it. So an Overture lead was
checked against **the business's own website** where the record carried one, and
against an independent public listing where it did not.

**Six of the thirty could not be checked against anything** — all six Overture
records with no website. That is not a sampling artefact: 607 of 1,639 Overture
leads (37%) carry no website, and none of them carry a browsable source URL.

## Results

| Checked  | Phone correct        | City/municipality correct | Classification correct                      |
| -------- | -------------------- | ------------------------- | ------------------------------------------- |
| 24 of 30 | **20 of 22** (90.9%) | **24 of 24** (100%)       | **17 clearly correct, 3 arguable, 2 wrong** |

Phone denominator is 22, not 24: one lead (`Časovničar`, #1041) carries no phone
at all, and one (`Keramont 013`, #1256) had its address and city confirmed by a
public listing that does not publish the number.

## The errors, individually

### 1. `TE ST New Company` (#1609, Mali Iđoš, `overture-places`) — wrong phone

Stored a `+3816…` mobile. The company's own site, `testserbia.com`, publishes a different mobile and no other number; the stored number appears
nowhere on it.
The address (`Glavna 108`) does match. **Cause:** an Overture record carrying a
phone the business itself no longer publishes. Nothing in the pipeline is wrong
— the source is stale, and there is currently no mechanism that notices.

### 2. `GDC S.R.M.A` (#1723, Zemun, `austrotherm-distributeri`) — four other branches' phones

Austrotherm lists this distributor at five addresses. The pipeline correctly
created **five separate leads** (#1723 Zemun, #1724 Kraljevo, #1725 Niš, #1726
Šabac, #1727 Vranje), and #1724–#1727 each carry exactly the one number their
branch published. But **#1723 accumulated all five**: the Kraljevo (`036`), Šabac (`015`), Niš
(`018`) and Vranje (`017`) numbers are all attached to the Belgrade row. There is no `merge_log` row, so this happened on
the **ingest path**, not in the dedup sweep — the first lead of a same-name
group absorbs the later records' phones before the branches are decided to be
distinct. A salesperson calling the Belgrade row gets four numbers in four other
cities, each labelled Belgrade.

Corpus-wide, **137 of 4,832 valid landline numbers (2.8%) sit on a lead whose
municipality does not match the number's area code.** Not all of those are this
bug — a Belgrade head office may legitimately publish a regional number — but it
bounds the size of the problem.

### 3. `Janković inženjering` (#2090, Beograd, `portal-srbija`) — false negative

Classified `UNKNOWN`. Portal Srbija files it under _Termo izolacija, zvučna
izolacija_ / _Hidroizolacija_ / _Završni radovi, restauracije_. Thermal
insulation plus finishing works **is** the ETICS trade — this is exactly the
buyer this project exists to find, and it is not in the export.

**Cause:** `classifyLead` gates the contractor axis behind a facade term, and
`termoizolacija` and `izolacija` are `ambiguous` signals whose credit is capped
at `min(ambiguous, core + supporting)`. With no core or supporting signal the
credit is zero, so the axis scores 0 however much insulation the company
publishes. The gate is deliberate and it stops roofers becoming facade
contractors — but it also means a source that describes the trade only by
category can never produce a contractor.

### 4. `Topers` (#2096, Beograd, `portal-srbija`) — false positive

Classified `FACADE_CONTRACTOR`. The company rents scaffolding: _"IZNAJMLJIVANJE
GRAĐEVINSKIH SKELA"_, ramovske / allround / aluminijumske skele. The deciding
term was **`fasadne skele`** — facade scaffolding. A scaffolding hire firm does
not buy facade panels. `fasadna stolarija` is already suppressed by a
longest-span rule; `fasadne skele` needs the same treatment.

## The three arguable ones

Counted as errors nowhere above, but a reviewer could reasonably disagree:

- **`Maks Keramika`** (#1429, Ub) — `UNKNOWN`. Independently confirmed as a
  ceramics/building-materials wholesaler on its published landline. Tiles are a building
  material; whether a tile salon is a `CONSTRUCTION_MATERIAL_STORE` for this
  product is a product call, not a classifier bug.
- **`Keramont 013`** (#1256, Vršac) — `UNKNOWN`, same question.
- **`ARIELLE`** (#2637, Niš) — `UNKNOWN`. Its own categories on
  `gradjevinarstvo.rs` are _IZVOĐENJE GRAĐEVINSKIH RADOVA_ / _Završni radovi_ /
  _Instalacioni radovi_. `contractor.zavrsni-radovi` is a signal in the table,
  and "završni građevinski radovi" is in the project's own contractor
  terminology, but it did not fire on the category text.

## Two data-quality defects the sample surfaced

**519 junk rows in `lead_phones`.** `gradjevinarstvo.rs` prints department
labels inside the number — `0xx xxx xxx, PRODAJA`, `0xx xxx xxx, DIREKTOR` — and
the adapter stores the whole string as `e164`. They are correctly flagged
`valid = 0`, so they never reach the deliverable, and 425 of the 519 are
duplicated by a correctly-parsed sibling row. Up to ~94 may be numbers held
only in the junk form. FUZZ-25 must filter `valid = 1` or the review UI will
render them.

**Mangled addresses.** `Trgokomerc` (#1264) stores `41, Miloša Obilića 26300`
where the site says `Bulevar Miloša Obilića 41, 26300 Vršac` — street number
moved to the front, postcode glued to the end, `Bulevar` dropped.
`Rasadnik VRT` (#1320) stores the address `bb`. Addresses are the weakest field
in the corpus and the weakest dedup signal; nothing downstream should rely on
them.

## Full sample

| #    | Lead                                   | Source                   | Municipality      | Phone              | City                           | Class                                        |
| ---- | -------------------------------------- | ------------------------ | ----------------- | ------------------ | ------------------------------ | -------------------------------------------- |
| 1041 | Časovničar                             | overture                 | valjevo           | _no phone_         | not checkable                  | ok (`UNKNOWN`)                               |
| 1256 | Keramont 013                           | overture                 | vrsac             | not published      | ✓                              | arguable                                     |
| 1264 | Trgokomerc                             | overture                 | vrsac             | ✓                  | ✓                              | ok                                           |
| 1267 | SIM Invest D.O.O.                      | overture                 | indjija           | ✓                  | ✓                              | ok                                           |
| 1277 | AD Professional Sobna vrata            | overture                 | aleksinac         | not checkable      | not checkable                  | not checkable                                |
| 1297 | Ramiz Stolarija Bujanovac              | overture                 | bujanovac         | not checkable      | not checkable                  | not checkable                                |
| 1305 | Andrejević                             | overture                 | bor               | ✓                  | ✓                              | ok                                           |
| 1320 | Rasadnik VRT                           | overture                 | trstenik          | not checkable      | not checkable                  | ok (`UNKNOWN`)                               |
| 1327 | MM Gvozdjara                           | overture                 | kula              | not checkable      | not checkable                  | not checkable                                |
| 1334 | SL Steel Protect                       | overture                 | velika-plana      | not published      | ✓ (Krnjevo is in Velika Plana) | ok                                           |
| 1392 | Trgovinsko molerska radnja "ML Zvezda" | overture                 | ivanjica          | ✓                  | ✓                              | ok                                           |
| 1403 | ELVOD d.o.o.                           | overture                 | backa-topola      | ✓                  | ✓                              | ok                                           |
| 1414 | Stolarska Radnja Zdravković            | overture                 | petrovac-na-mlavi | not checkable      | not checkable                  | not checkable                                |
| 1429 | Maks Keramika                          | overture                 | ub                | ✓                  | ✓                              | arguable                                     |
| 1609 | TE ST New Company                      | overture                 | mali-idjos        | **✗ wrong**        | ✓ (address)                    | ok                                           |
| 1723 | GDC S.R.M.A                            | austrotherm              | beograd           | **✗ contaminated** | ✓                              | ✓                                            |
| 1855 | TEŠIĆ KOLOR                            | austrotherm              | valjevo           | ✓                  | ✓                              | ✓                                            |
| 1907 | BIV                                    | gradjevinarstvo          | beograd           | ✓                  | ✓                              | ok (glass/mirrors)                           |
| 1971 | OPREMING                               | gradjevinarstvo          | beograd           | ✓                  | ✓                              | ok (floor coverings)                         |
| 1982 | RADIMPEX SOFTWARE                      | gradjevinarstvo          | beograd           | ✓                  | ✓                              | ok (software)                                |
| 2090 | Janković inženjering                   | portal-srbija            | beograd           | ✓                  | ✓                              | **✗ false negative**                         |
| 2096 | Topers                                 | portal-srbija            | beograd           | ✓                  | ✓                              | **✗ false positive**                         |
| 2190 | POOL SERVICE                           | gradjevinarstvo          | novi-sad          | ✓                  | ✓                              | ok (pools)                                   |
| 2192 | ALBOS                                  | gradjevinarstvo          | beograd           | ✓                  | ✓                              | ok (refractory)                              |
| 2194 | Terakota                               | gradjevinarstvo + portal | beograd           | ✓                  | ✓                              | ok                                           |
| 2196 | Clean windows servis                   | portal-srbija            | beograd           | ✓                  | ✓                              | ok (facade _cleaning_, correctly suppressed) |
| 2375 | HANAN                                  | gradjevinarstvo          | beograd           | ✓                  | ✓                              | ok (balustrades)                             |
| 2510 | ZAVARIVAČ                              | gradjevinarstvo          | vranje            | ✓ (5 numbers)      | ✓                              | ok (prefab metal)                            |
| 2524 | Geosonda fundiranje                    | portal-srbija            | beograd           | ✓                  | ✓                              | ok (foundation drilling)                     |
| 2637 | ARIELLE                                | gradjevinarstvo          | nis               | ✓                  | ✓                              | arguable                                     |
