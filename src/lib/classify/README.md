# `src/lib/classify` — which buyer group a business belongs to

`classifyLead(input)` returns `FACADE_CONTRACTOR` | `CONSTRUCTION_MATERIAL_STORE` |
`BOTH` | `UNCLASSIFIED` | `OUT_OF_SCOPE`, a confidence, and **the evidence**:
every span it matched, every span it deliberately refused to count, and the
arithmetic between them.

```ts
import { classifyLead } from '@/lib/classify';

classifyLead({
  name: 'Fasaderski radovi Veljko',
  categories: ['Molerski, fasaderski i gipsarski radovi'],
  description: 'Izrada demit fasada, malterisanje.',
});
// → { label: 'FACADE_CONTRACTOR', confidence: 0.98,
//     contractor: { core: 2.5, …, net: 3.6, gateOpen: true },
//     evidence: [{ signalId: 'contractor.fasader', matched: 'fasaderski', field: 'name', … }, …],
//     suppressed: [], reason: 'Facade evidence 3.6 from `fasaderski` (name)…' }
```

Pure. No clock, no I/O, no database. Every field goes through
`foldForComparison` in `src/lib/text/fold.ts` first, so script, case and
diacritics are all invisible to the matcher: `Građevinsko stovarište`,
`GRAĐEVINSKO STOVARIŠTE`, `gradjevinsko stovariste` and
`ГРАЂЕВИНСКО СТОВАРИШТЕ` are one string by the time the signal table sees them.
Callers pass what the source published; they do not pre-transliterate.

## The two rules that do the work

**1. The longest match over a span wins.** Every false positive in this domain
is a longer phrase containing a shorter one:

| The text says               | Naive match    | What actually claims it    | Result          |
| --------------------------- | -------------- | -------------------------- | --------------- |
| `čišćenje fasada`           | `fasada`       | `adjacent.cleaning-fasade` | facade washing  |
| `fasadna stolarija`         | `fasadn…`      | `adjacent.joinery-fasada`  | window hardware |
| `alubond fasada`            | `fasada`       | `adjacent.joinery-fasada`  | curtain wall    |
| `fasadni materijal`         | `fasad…`       | `store.fasadni-materijal`  | a shop's shelf  |
| `materijal za demit fasadu` | `demit fasada` | `store.fasadni-materijal`  | a shop's shelf  |

So a new false positive is fixed by adding the _longer_ phrase, never by adding
an exception. The loser is reported in `suppressed`, which is how the review UI
can answer "this company says fasada six times, why is it not a lead".

**2. A gate, not a sum.** `termoizolacija` and `izolacija` never open the facade
gate, so no quantity of them produces `FACADE_CONTRACTOR` — that single rule is
what keeps roofers, window fitters, waterproofers and pipe insulators out of the
contractor label. Ambiguous evidence is also capped at `core + supporting`, so a
word shared with another trade can corroborate real evidence but never
substitute for it.

Two smaller rules follow the same logic:

- **A source category corroborates, it never decides.** `category` is weighted
  _below_ `description` because Poslovni Kontakt files every sole trader under
  `Molerski, fasaderski i gipsarski radovi`; at any weight that lets a category
  decide alone, ten painters become facade contractors. Measured, not assumed —
  it happened on the first tuning pass.
- **A manufacturer is a supplier, not a buyer.** A record naming `fabrika` or
  `proizvodnja` with no counter (`stovarište`, `veleprodaja`, `farbara`) gets no
  label. An EPS factory is our competitor; a yard that also produces is still a
  yard.
- **A selling word is not a product list.** `veleprodaja` says the business
  sells; it does not say _what_. In a record naming no building material at all
  the signal is demoted to `supporting` **and discounted to
  `NO_ASSORTMENT_DISCOUNT` (0.3) of its weight**. Demoting without discounting
  — which is what happened until FUZZ-37 — changes the evidence trail and
  nothing in the arithmetic, because a `supporting` 0.95 clears the threshold on
  its own. All eight pilot leads whose store label rested on that one word sell
  carpets, circuit breakers, hand tools, spare parts, traffic cones or aluminium
  profiles; `veleprodaja.test.ts` holds them, and holds the three real yards
  that must keep their labels.

`BOTH` is not a tie-break. Both axes are scored independently and `BOTH` is what
happens when both clear the threshold — which is the normal state of a
stovarište that also installs.

## "Not a lead" is two different answers

When neither axis clears the threshold, the label says _why_:

- **`UNCLASSIFIED`** — nothing was found either way. A thin record; a crawl or an
  enrichment pass may still turn it into a lead. It stays in the review list.
- **`OUT_OF_SCOPE`** — an adjacent trade was positively identified **and nothing
  at all argued for either buyer group**. `result.industry` names the trade, and
  it is persisted to `leads.classification_industry` so the exclusion is
  auditable and reversible. It is dropped from the default list and the export.

Anything mixed — joinery evidence _and_ a facade term — stays `UNCLASSIFIED`,
because mixed evidence is a question, not a verdict. On the FUZZ-22 pilot the
rule ruled out 243 of 3,046 previously-`UNKNOWN` leads, most of them
general construction, industrial insulation, manufacturing and joinery.

## Measured precision

`__fixtures__/labelled-businesses.json` holds **161 real Serbian businesses**,
extracted verbatim from public directory listings and labelled by hand. The set
is adversarial on purpose: 110 of the 161 are neither buyer group, and most of
those publish `fasada`, `termoizolacija` or `izolacija` while belonging to a
trade we do not sell to. The fixture labels those `UNKNOWN` — its own vocabulary
for "neither" — and `toFixtureLabel` folds `UNCLASSIFIED` and `OUT_OF_SCOPE`
back onto it, so the measurement below is comparable across the FUZZ-37 split.

```
Overall accuracy 94.4% (152/161)

                              predicted  correct  precision  recall  false-positive rate
FACADE_CONTRACTOR                    11       10      90.9%   83.3%   0.7% (1/149)
CONSTRUCTION_MATERIAL_STORE          38       34      89.5%   91.9%   3.2% (4/124)
BOTH                                  1        1     100.0%   50.0%   0.0% (0/159)
UNKNOWN                             111      107      96.4%   97.3%   7.8% (4/51)
```

**No record whose true label is `UNKNOWN` is classified `FACADE_CONTRACTOR`.**
The one contractor false positive is a materials trader whose product list
includes `TERMO FASADA`, not a company from an adjacent industry. The two
contractor misses and the store misses are recall, not precision — the
classifier's failure mode is silence, which is the failure mode the brief asks
for.

Re-run and inspect:

```
npx tsx scripts/report-classification-precision.ts            # the table above
npx tsx scripts/report-classification-precision.ts --errors   # every mistake, with evidence
npx tsx scripts/report-portal-srbija-classification.ts --unknown  # a real source, record by record
npx vitest run src/lib/classify                               # the same numbers, as assertions
```

`precision.test.ts` asserts floors a little below today's numbers, so tuning the
signal table is free until it costs accuracy.

## Where the fixture came from

Five public category pages, one polite `GET` each, honest user agent,
`robots.txt` read first — `portal-srbija.com` (`Allow: /`, only `/admin*/` and
`/pretraga/` disallowed) and `poslovnikontakt.com` (`Disallow:`, empty). Public
business-contact listings published by the businesses themselves; nothing behind
a login, no CAPTCHA, and no phone numbers stored in the fixture. The categories
were chosen to be hostile rather than representative:

| Category                          |   n | What it contributes                                     |
| --------------------------------- | --: | ------------------------------------------------------- |
| Termo izolacija, zvučna izolacija |  60 | Yards and paint shops, plus HVAC, rubber, manufacturers |
| Završni radovi, restauracije      |  58 | Adjacent trades: gips, parket, plumbing, curtain wall   |
| Čišćenje fasada, skidanje grafita |  27 | 27 companies that say `fasada` and wash it              |
| Sanacije + radovi na visini       |   6 | Rope-access firms, of which one advertises demit fasade |
| Molerski, fasaderski, gipsarski   |  10 | Sole traders — name and city only, no description       |

The labelling rubric is in the fixture's `_meta`, and every non-obvious record
carries a `note` saying why it was labelled that way.
