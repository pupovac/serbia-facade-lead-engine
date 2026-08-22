# `src/lib/classify` — which buyer group a business belongs to

`classifyLead(input)` returns `FACADE_CONTRACTOR` | `CONSTRUCTION_MATERIAL_STORE` |
`BOTH` | `UNKNOWN`, a confidence, and **the evidence**: every span it matched,
every span it deliberately refused to count, and the arithmetic between them.

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
can answer "this company says fasada six times, why is it UNKNOWN".

**2. A gate, not a sum.** `termoizolacija` and `izolacija` never open the facade
gate, so no quantity of them produces `FACADE_CONTRACTOR` — that single rule is
what keeps roofers, window fitters, waterproofers and pipe insulators out of the
contractor label. Ambiguous evidence is also capped at `core + supporting`, so a
word shared with another trade can corroborate real evidence but never
substitute for it.

Three smaller rules follow the same logic:

- **An ambiguous contractor term in the business's own _name_ counts as
  `supporting`.** `fasada` is ambiguous in a product catalogue, where a roofer, a
  window fitter and a cleaning company all print it; it is not ambiguous in
  `Ćorić Fasade`, because a business names itself after the trade it performs.
  Without this the only evidence a one-man fasader ever publishes nets exactly
  zero, since ambiguous credit is capped at `core + supporting`. The gate is
  untouched, so it promotes evidence rather than inventing it: `Termoizolacija
d.o.o.` still scores zero.
- **A source category corroborates, it never decides.** `category` is weighted
  _below_ `description` because Poslovni Kontakt files every sole trader under
  `Molerski, fasaderski i gipsarski radovi`; at any weight that lets a category
  decide alone, ten painters become facade contractors. Measured, not assumed —
  it happened on the first tuning pass. A signal may also declare `shelfIn:
['category']`, which lets it corroborate there but never **open** an axis
  gate — `contractor.molersko-fasaderski` is that case: in a company's name
  those two words are a facade crew, on a directory shelf they are three trades
  filed together.
- **A manufacturer is a supplier, not a buyer.** A record naming `fabrika` or
  `proizvodnja` with no counter (`stovarište`, `veleprodaja`, `farbara`) is
  `UNKNOWN`. An EPS factory is our competitor; a yard that also produces is
  still a yard.

`BOTH` is not a tie-break. Both axes are scored independently and `BOTH` is what
happens when both clear the threshold — which is the normal state of a
stovarište that also installs.

## Measured precision

`__fixtures__/labelled-businesses.json` holds **161 real Serbian businesses**,
extracted verbatim from public directory listings and labelled by hand. The set
is adversarial on purpose: 110 of the 161 are `UNKNOWN`, and most of those
publish `fasada`, `termoizolacija` or `izolacija` while belonging to a trade we
do not sell to.

```
Overall accuracy 95.7% (154/161)

                              predicted  correct  precision  recall  false-positive rate
FACADE_CONTRACTOR                    12       11      91.7%   91.7%   0.7% (1/149)
CONSTRUCTION_MATERIAL_STORE          37       34      91.9%   91.9%   2.4% (3/124)
BOTH                                  2        2     100.0%  100.0%   0.0% (0/159)
UNKNOWN                             110      107      97.3%   97.3%   5.9% (3/51)
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

## Re-classifying a stored corpus

The signal table is only worth what it moves on real leads, so re-classification
is a committed code path rather than a query somebody typed once:

```
npx tsx scripts/reclassify.ts            # dry run: labels before and after, and every transition
npx tsx scripts/reclassify.ts --json f   # + each lead's new label, net scores and evidence
npx tsx scripts/reclassify.ts --apply    # write the new labels and re-score the leads that moved
```

`leadClassificationInput` in `reclassify.ts` rebuilds the classifier input from
**every source that has seen the lead**, not from the lead row: source categories
are stored only inside `raw_records.payload`, and a lead five directories agree
on has five category lists. `regradeLead` uses the same function, so a merge and
a re-classification never read the same lead differently.

`research/fuzz32-report.md` is what one such run looks like, measured on the
3,601-lead pilot corpus.

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
