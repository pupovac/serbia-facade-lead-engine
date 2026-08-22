# FUZZ-32 — classification recall on the pilot corpus

What the four changes in `src/lib/classify` do to the 3,601-lead pilot corpus from
FUZZ-22, measured rather than argued. Every number below is reproducible with
`npx tsx scripts/reclassify.ts` against that database; no phone numbers appear
here and no lead data is committed.

## The headline

**The four changes did not add facade contractors. They replaced six false ones
with six real ones.** Contractor-side leads (`FACADE_CONTRACTOR` + `BOTH`) stand
at 51 before and 51 after the signal changes — the composition changed, the count
did not.

The pilot's diagnosis was that 49 contractors out of 3,601 is a classifier
problem. On this corpus it is not: **the whole corpus contains 8 leads with
`fasad` in the business name**, and 6 of them already carried a label. The
recall ceiling the classifier can reach here is a handful of leads, because the
contractor-side records were never collected. That is the finding that should
decide FUZZ-26's scope.

## Before and after

Three columns, because two of them would conflate two different causes. The
re-classification path rebuilds each lead's classifier input from _every_ source
that has seen it (source categories live only in `raw_records.payload`, and a
lead five directories agree on has five category lists). That richer input moves
leads on its own, before any signal changes.

| Label                         | Pilot, as stored | Re-run, old signals | Re-run, new signals | With a phone |
| ----------------------------- | ---------------: | ------------------: | ------------------: | -----------: |
| `UNKNOWN`                     |    3,046 (84.6%) |       3,031 (84.2%) |   **3,034 (84.3%)** |        2,969 |
| `CONSTRUCTION_MATERIAL_STORE` |      506 (14.1%) |                 519 |     **516 (14.3%)** |          507 |
| `FACADE_CONTRACTOR`           |        36 (1.0%) |                  34 |       **32 (0.9%)** |           32 |
| `BOTH`                        |        13 (0.4%) |                  17 |       **19 (0.5%)** |           19 |
| Contractor-side total         |               49 |                  51 |              **51** |           51 |

Phone coverage is unchanged at 97.9% (3,527 of 3,601), 6,959 distinct valid
numbers — re-classification touches labels and scores, never contacts.
Contractor-side leads now reach 25 municipalities, up from 22.

37 leads changed label in total: **24 from the merge-aware input, 13 from the
signal changes**. Attribution matters, so the two are reported separately below.

### The 13 the signal changes moved

Gained a contractor-side label (6):

| #    | Lead                           | From → to                              | Why                                                        |
| ---- | ------------------------------ | -------------------------------------- | ---------------------------------------------------------- |
| 1164 | Ćorić Fasade                   | `UNKNOWN` → `FACADE_CONTRACTOR`        | change 1 — the name is the only evidence there is          |
| 849  | Marko-Pan boje.fasade.keramika | `UNKNOWN` → `FACADE_CONTRACTOR`        | change 1                                                   |
| 1079 | Farbax Boje, Lakovi i Fasade   | `UNKNOWN` → `FACADE_CONTRACTOR`        | change 1 + change 4 (`painting`)                           |
| 2222 | Dekor centar Babić             | `UNKNOWN` → `FACADE_CONTRACTOR`        | change 2 — `molersko` + `fasade` + `mašinsko malterisanje` |
| 2011 | Neimar projekt                 | `CONSTRUCTION_MATERIAL_STORE` → `BOTH` | change 2                                                   |
| 2672 | FASADA                         | `CONSTRUCTION_MATERIAL_STORE` → `BOTH` | change 1                                                   |

Lost a label they should not have had (7):

| #    | Lead           | From → to                                 | Why                                       |
| ---- | -------------- | ----------------------------------------- | ----------------------------------------- |
| 2096 | Topers         | `FACADE_CONTRACTOR` → `UNKNOWN`           | change 3 — scaffolding hire               |
| 2704 | EURO STOLARIJA | `FACADE_CONTRACTOR` → `UNKNOWN`           | glazed-wall category                      |
| 73   | Termoplast     | `FACADE_CONTRACTOR` → `UNKNOWN`           | PVC windows and glazed walls              |
| 134  | Terasko        | `FACADE_CONTRACTOR` → `UNKNOWN`           | terrace glazing                           |
| 2964 | VAN CO GROUP   | `FACADE_CONTRACTOR` → `UNKNOWN`           | PVC/alu joinery                           |
| 969  | Vibbet         | `FACADE_CONTRACTOR` → `UNKNOWN`           | precast concrete for _ventilisane fasade_ |
| 2771 | YU-KANBERA     | `CONSTRUCTION_MATERIAL_STORE` → `UNKNOWN` | PVC/alu profile agent                     |

Every one of the seven is a window, glazing, curtain-wall or scaffolding
business. None of them is a buyer for a prefabricated EPS facade panel.

## The two errors the issue named

- **`Topers` (#2096) — fixed.** It is now `UNKNOWN`. The pilot's diagnosis was
  wrong about the mechanism: nothing in the record says `fasadne skele`. The
  label came from _"radovima na revitalizaciji/restauraciji i sanaciji fasada"_
  in its own Portal Srbija description, which is facade `core` evidence. The
  rule that removes it is `adjacent.scaffolding`, matched on the category
  `Gradjevinske skele`, cancelling that core. `fasadne skele` is suppressed too,
  as asked, but it is not what this record needed.
- **`Janković inženjering` (#2090) — not fixed, and none of the four changes
  reaches it.** Its entire stored record is a name with no trade word and three
  Portal Srbija categories: `Termo izolacija, zvučna izolacija`,
  `Hidroizolacija`, `Završni radovi, restauracije`. There is no facade term
  anywhere in it. Labelling it would mean letting _thermal insulation + finishing
  works_ open the facade gate, which is exactly the combination every roofer,
  waterproofer and HVAC insulator in this corpus publishes — 141 leads sit in
  that band. This is a **collection** gap (the source page carries more than the
  adapter kept), not a classifier gap, and it should be fixed by the adapter.

## The manual precision check

37 changed leads checked by hand against their stored source text and, where one
exists, the business's own website. The acceptance criterion asks for 25 leads
that newly became `FACADE_CONTRACTOR` or `BOTH`; **there are only 9 in the whole
corpus**, so all 37 changes were checked instead.

### The 9 newly contractor-side leads

| #    | Lead                           | Verdict                                                                                                                                                                                                      |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1164 | Ćorić Fasade                   | ✅ facade contractor                                                                                                                                                                                         |
| 2222 | Dekor centar Babić             | ✅ _fasade, mašinsko malterisanje, molersko-dekorativni radovi_                                                                                                                                              |
| 2011 | Neimar projekt                 | ✅ sells materials and does facades — `BOTH` is right                                                                                                                                                        |
| 1075 | Fasaderska Radnja Hodoba       | ✅ fasaderska radnja and an Austrotherm distributor                                                                                                                                                          |
| 1114 | Jedinstvo Metalogradnja        | ⚠️ verified on its site: a steel-structures works that mounts _krovnih pokrivača, fasada i plafona od sendvič panela_. A real facade installer, but of industrial cladding — a marginal buyer for this panel |
| 849  | Marko-Pan boje.fasade.keramika | ⚠️ verified on its site: a **retailer** of paints, facades and ceramics. Plausible buyer, wrong axis — should be `CONSTRUCTION_MATERIAL_STORE`                                                               |
| 1079 | Farbax Boje, Lakovi i Fasade   | ⚠️ no website; name reads as a paint-and-facade shop. Plausible buyer, axis unverifiable                                                                                                                     |
| 2062 | Baumit                         | ❌ **manufacturer** of ETICS systems. A supplier, not a buyer                                                                                                                                                |
| 2672 | FASADA                         | ❌ **manufacturer** — its own site says _"Proizvodnja fasadnih materijala"_                                                                                                                                  |

**Precision: 7 of 9 (78%) are a plausible buyer for the panel; 5 of 9 (56%) carry
the right label.** Both are below the 80% bar, so per the issue this is reported
rather than shipped as a win.

One more lead gained a second axis rather than its first: **Agens beograd**
(#2116) went `FACADE_CONTRACTOR` → `BOTH` on _"Trgovina na veliko i malo
(građevinskim materijalom)"_, and **OFFER TRADE** (#1792) the same way. Both are
correct.

Both hard false positives are the same failure: **an ETICS materials
manufacturer whose record never says `proizvodnja`.** `adjacent.manufacturing`
fires on the word, and Baumit's and FASADA's directory records do not contain
it — Baumit's description is a product list, FASADA's is empty. This is not
fixable by another Serbian phrase. The rule to add is a **manufacturer/brand
denylist** in `src/lib/classify`: Baumit, Weber Saint-Gobain, Sika, Austrotherm,
Knauf, Nexe/Polet, FIM, Vin-haus. It would have caught 5 of the 37 changes, and
it is a bounded, testable list rather than a weight to tune.

### The 16 newly `CONSTRUCTION_MATERIAL_STORE` leads

All 16 come from the merge-aware input, not from the four signal changes.
9 correct (Kalcer, Kej, Džavić, IZOTERM, Izo dom, KOMPANIJA DACIĆ, INFO MARKET,
P.V.F. Traders, Abs commerce — the last three weakly). 7 wrong, in two clusters:

- **Manufacturers** — FABRIKA IZOLACIONIH MATERIJALA FIM, POLET IGK (a Nexe
  brick and tile plant), Sika Srbija. Same denylist fix.
- **Machinery and tool dealers** — Uniwab (recycling plant), Radex (construction
  machinery), J & V finishing (power tools). `store.veleprodaja` +
  `store.distributer` clear the retail gate, and the `GRAĐEVINSKE MAŠINE I
OPREMA` category adds nothing against them. The rule to add is an
  `adjacent.machinery` disqualifier: a company that sells excavators is not a
  stovarište.
- One sideways move: **Vertical construction** (#2153), a rope-access
  waterproofing firm, went `FACADE_CONTRACTOR` → `CONSTRUCTION_MATERIAL_STORE`.
  Losing the contractor label is right; the store label is not.

## Why `UNKNOWN` is still 84.3%

A 20-lead sample — every 151st still-`UNKNOWN` lead in id order, so it is spread
across all five sources rather than picked — read by hand:

| What it actually is                                     |   n | Examples                                                                                                                   |
| ------------------------------------------------------- | --: | -------------------------------------------------------------------------------------------------------------------------- |
| A trade we do not sell to                               |  12 | locksmith, doors-and-windows, furniture salon, lifts, refrigeration, pool installer, electrical design, non-ferrous metals |
| Not a business at all                                   |   3 | a residential building, a building site listing, a municipal assembly                                                      |
| An Overture record with nothing but an English category |   3 | `building_or_construction_service` and a name, no other text                                                               |
| A building-materials or hardware store we missed        |   2 | N Centar, Pro-Technic — both `hardware_store`, no Serbian text                                                             |

**15 of 20 are correctly `UNKNOWN`.** The corpus is 84% out-of-market because
the crawl was broad, not because the classifier is blind. Two of the twenty
are real misses, and they share one cause.

That cause is measurable: **639 still-`UNKNOWN` leads carry a store-side Overture
category** (`hardware_store` 388, `building_supply_store` 236, …) that maps to
nothing in `SIGNALS`, and 1,168 `UNKNOWN` leads carry no signal evidence at all —
almost all Overture records whose only text is a name and an English category.
Change 4 mapped the contractor side of that taxonomy, as the issue asked. **The
store side is the single largest remaining recall lever in this corpus**, worth
an estimated 200–400 leads, and it should be measured before the nationwide
crawl rather than after.

## What each change actually did

| #   | Change                                                                | Reach on the corpus                                                                                   |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | An `ambiguous` contractor term in the **name** counts as `supporting` | 4 leads gained a contractor label; 8 leads in the corpus have `fasad` in the name at all              |
| 2   | `moler` / `krečenje` as `supporting`, gate-less                       | 65 leads now carry the evidence; 10 are labelled, 41 remain `UNKNOWN` because no facade term joins it |
| 3   | `fasadne skele` suppressed, scaffolding hire cancels facade core      | 7 leads carry scaffolding evidence, all 7 `UNKNOWN`; removes the `Topers` class                       |
| 4   | Overture's English taxonomy on the contractor axis                    | 737 leads carry the evidence; it is decisive in combination on 7 and never on its own                 |

Two interactions had to be resolved before 1, 2 and 4 were safe together, both
measured on the 161-record labelled fixture set:

- **`Molerski, fasaderski i gipsarski radovi` is one Poslovni Kontakt shelf
  covering three trades.** With `moler` as evidence, a gate opened on that
  category turned 8 sole-trader painters into facade contractors. The shelf now
  has its own longest-span signal, marked `shelfIn: ['category']`: in a company's
  own _name_ those two words are a facade crew and open the gate; as a _category_
  they corroborate and nothing more.
- **`zastakljeni zidovi, fasade`, `ventilisane fasade` and `bond fasade`** are
  spellings of terms already in `adjacent.joinery-fasada` (`staklena fasada`,
  `ventilirana fasada`) that the pilot corpus publishes and the table missed.
  Adding them removed 6 glazing companies from the contractor label.

Fixture-set accuracy: **94.4% → 95.7%**. Contractor recall 83.3% → 91.7%,
contractor precision 90.9% → 91.7%, false-positive rate unchanged at 0.7%.

## Recommendation for FUZZ-26

**Not yet — not at nationwide scale, and not for contractors.**

The measured case: five sources, 3,601 leads, 145/145 municipalities, and
**51 contractor-side leads**. The classifier is not what is holding that number
down — after these changes it labels essentially everything in the corpus that
names facade work, and the manual check says the ones it now labels are real.
Scaling the same five sources ten-fold scales stores and `UNKNOWN`; it does not
find fasaderi, because four of the five sources are materials registers and a
places dataset.

What to do before the crawl, in order:

1. **Map the store side of Overture's taxonomy** and measure it. 639 `UNKNOWN`
   leads are waiting on it; it is one signal-table entry plus a precision check.
2. **Add the manufacturer denylist.** It removes the two hardest false positives
   found here and will scale with the corpus.
3. **Add a contractor-first source.** The registry in FUZZ-4 ranks several that
   this pilot never ran. A nationwide crawl of the current five sources will
   return roughly 10× of what we already have, at the same 1.4% contractor rate.
4. Then re-run this script on the result and re-measure. The path is committed.

## Reproducing every number here

```bash
# the pilot database, from the FUZZ-22 comment attachment
multica attachment download 01a02437-5c3b-7779-89b1-9c34ac5e6520 -o ./attachments
gunzip -c attachments/leads.sqlite.gz > data/leads.sqlite

npx tsx scripts/reclassify.ts                      # dry run: the before/after table
npx tsx scripts/reclassify.ts --json out.json      # + every lead's new label and evidence
npx tsx scripts/reclassify.ts --apply              # write the labels and re-score what moved
npx tsx scripts/report-classification-precision.ts # the fixture-set accuracy above
```

`--apply` re-grades only the leads whose label moved. Re-grading the whole corpus
would also re-score 3,600 unchanged leads, and `toScoreInput` discounts a city
read back from the database (`PERSISTED_CITY_CONFIDENCE`), so a pure
classification run would quietly deflate every score by two points.
