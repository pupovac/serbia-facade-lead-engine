# FUZZ-7 — Serbian search-query library

The generator that turns the term inventory (`data/query-templates.json`) and the geographic
dataset (`data/serbia-geo.json`) into the query strings every discovery run issues.
Implementation: `src/lib/queries.ts`, `src/lib/text/cyrillic.ts`.

## What it produces

| variant          | precisions included   | place patterns                               |
| ---------------- | --------------------- | -------------------------------------------- |
| `narrow`         | narrow                | `fasader Novi Sad`                           |
| `core` (default) | narrow, medium        | + `fasader u Novom Sadu`                     |
| `all`            | narrow, medium, broad | + `fasader Novom Sadu`, `fasader Novog Sada` |

Deduplicated query-set size over all 30 tier-1 municipalities, Latin only:

| variant  | contractor | store | both lead types | both + Cyrillic |
| -------- | ---------- | ----- | --------------- | --------------- |
| `narrow` | 1,014      | 615   | 1,629           | 2,739           |
| `core`   | 2,772      | 2,142 | **4,836**       | 7,896           |
| `all`    | 6,804      | 5,232 | 11,568          | 18,888          |

Reproduce with `npx tsx scripts/report-query-set.ts`.

## Term inventory

65 templates: 42 target facade contractors, 26 target construction-material stores, 3 target both.
By precision: 38 `narrow`, 17 `medium`, 10 `broad`.

`narrow` means almost every hit is the target business type (`demit fasada`, `stovarište
građevinskog materijala`). `medium` means a predictable adjacent trade comes with it
(`ventilisana fasada` brings the aluminium/glass curtain-wall trade; `farbanje fasade` brings
painters). `broad` means target businesses are a minority — `termoizolacija` returns window,
roof and floor insulators, and `završni građevinski radovi` returns every finishing trade there
is. Broad terms are worth running where the narrow ones come back thin, and are worth budgeting
for heavy classification loss.

Two terms are deliberately kept despite a known collision, because their yield is worth the
noise: `EPS fasada` and `EPS ploče` collide with Elektroprivreda Srbije, the national power
utility. `skele za fasadu` is scaffolding rental rather than installation, kept because rental
firms publish their contractor customers.

## Both spellings

Every Latin query is emitted twice — the diacritic form and the ASCII fold — because Serbian
pages are written either way and each spelling finds pages the other misses. The fold is applied
to the **finished query**, not to term and place independently, so a query is never
`gradjevinski materijal Čačak`: it is either fully diacritic or fully folded. Where the two
collapse (`fasader Novi Sad` has no diacritics) only one is emitted.

## Inflection

Serbian listings say "fasader u Novom Sadu", not "fasader Novi Sad". The generator composes
against `search_variants` from the geographic dataset, which carries the nominative, locative
and genitive of every municipality — so `Sremska Mitrovica` yields `u Sremskoj Mitrovici` and
`Sremske Mitrovice`, not a mangled nominative.

The locative preposition is `u` almost everywhere but `na` for eight Belgrade city
municipalities — `na Vračaru`, `na Novom Beogradu`, `na Zvezdari`, `na Voždovcu`, `na Čukarici`,
`na Paliluli`, `na Savskom vencu`, `na Starom gradu` — while `u Zemunu` and `u Rakovici` stay
`u`. The exceptions live in `locative_prepositions.overrides` in the templates file.

## The Cyrillic question

**Recommendation: ship the capability, leave it off by default, and turn it on only for the
specific Cyrillic-only sources a source registry names.**

Cyrillic output works (`scripts: ['cyrillic']`) and produces correct queries —
`фасадер у Новом Саду`, `грађевински материјал Чачак` — composed from the Cyrillic place forms
already in the geographic dataset and a Serbian Latin→Cyrillic transliterator. Four brand and
acronym terms (`Baumit distributer`, `EPS ploče`, `EPS fasada`, `ETICS fasada`) suppress Cyrillic
output, because Serbian keeps those in Latin even in Cyrillic text.

What the evidence says about turning it on by default:

- **Commercial search results are Latin.** A Cyrillic query for
  `грађевинско стовариште Нови Сад` returned zero commercial listings — city-administration
  pages about _construction land_ (`грађевинско земљиште`), the Novi Sad assembly's official
  gazette, and a newspaper article. The ASCII-folded Latin query `gradjevinsko stovariste Novi
Sad` returned eight store and directory results on the first page, including
  `stovarista.rs`, `planplus.rs`, `imenik.rs` and three individual yards with contact pages.
- **The same split on the contractor side.** `фасадер Београд фирма` returned a primary school,
  job boards and a trade-school curriculum page. `fasaderi Beograd firma imenik` returned
  `daibau.rs/imenik/fasade/beograd` (a paginated contractor directory) and
  `navidiku.rs/firme/fasaderski-radovi/beograd` (10 Belgrade facade firms, phone numbers
  rendered inline — e.g. `0615300597`, `0113317534`).
- **A Cyrillic-only directory does exist, and it is a poor one.**
  `firmaodpoverenja.com/companies,100,beograd` is entirely Cyrillic with no script switcher —
  but phone numbers are hidden behind a "Прикажи" (Show) control rather than rendered in the
  listing. Under our own ranking rule — phone-number yield above everything else — that is not
  a source worth doubling the whole query budget for.

Cost of enabling it by default: the tier-1 `core` set grows from 4,836 to 7,896 queries, +63%,
for a slice of the web that is administrative and editorial rather than commercial. The Cyrillic
path stays in the code because it is nearly free to keep and because a directory-specific
adapter (site search box, not a search engine) is exactly where it will pay off — but the
default query set stays Latin.

## Limitations worth knowing

- The transliterator always takes the digraph reading of `nj`, `lj` and `dž`. That is correct
  for every term in the inventory (`lepljenje` → `лепљење`) but wrong at a morpheme boundary
  (`nadživeti` → `наџивети`, should be `надживети`). Terms hitting that class must set
  `term_cyrillic` explicitly. Do not point `toCyrillic` at arbitrary scraped text.
- The `all` variant's genitive pattern (`fasader Novog Sada`) is the weakest of the four; it
  reads naturally with a plural term (`fasaderi Novog Sada`) and stiffly with a singular one.
  It is confined to `all` for that reason.
- Query counts above are the size of the _generated_ set, not a recommendation to issue that
  many requests. Which subset a run issues, and at what rate, is the discovery-strategy
  decision (FUZZ-8), not this module's.
