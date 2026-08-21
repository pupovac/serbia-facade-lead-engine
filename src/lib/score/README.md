# `src/lib/score` — two numbers, because there are two questions

`scoreLead(input)` answers both and keeps them apart:

- **`relevance`** — _is this a lead for us?_ The classification label, how sure
  the classifier is, and how much evidence is behind it. No contact channel
  contributes a single point.
- **`contactability`** — _how much contact data do we hold?_ Phones, extra
  numbers, mobile vs landline, email, website, social, city, corroboration,
  recency. No label contributes a single point.

Plus `score`, a derived convenience key: `relevance × contactability / 100`.
Relevance gates, contactability ranks. Neither number is a purchase prediction;
nothing here knows anything about buying.

```ts
import { scoreLead, toScoreInput } from '@/lib/score';

scoreLead({
  phones: [{ e164: '+381641234567', type: 'mobile' }],
  classification: { label: 'FACADE_CONTRACTOR', confidence: 0.9, evidenceNet: 1.5 },
});
// → { relevance: 92, contactability: 53, score: 49, capped: false,
//     components: [ { id: 'phone', points: 44, max: 44, detail: '1 phone' }, … ],
//     relevanceComponents: [ { id: 'label', points: 50, max: 50, … }, … ] }
```

## Why two numbers (FUZZ-37)

There used to be one, and 66 of its 100 points were contact completeness against
14 for relevance. On the FUZZ-22 pilot that put `Garaza Banovina d.o.o.` — a
parking garage with two phones, an email, a website and a social profile, and
zero classification evidence — at **76/100**, ahead of the average confirmed
facade contractor. 93 unclassified leads outranked the average
`FACADE_CONTRACTOR`, and **32% of the top 200 rows** the owner actually browses
were `UNKNOWN`. A perfectly-documented irrelevant business is still an
irrelevant business, and one number could not say so. Sorted by
`relevance_score`, the same corpus's top 200 is 0% undecided.

## The relevance table

| Component    | Max | Why                                                                             |
| ------------ | --: | ------------------------------------------------------------------------------- |
| `label`      |  50 | A buyer group, or not. `BOTH` scores the same as one label — not a better lead. |
| `confidence` |  25 | Rescaled from 0.5 (the floor `classifyLead` gives any decided label) to 0.98.   |
| `evidence`   |  25 | The deciding axis's net evidence, full marks at twice `DECISION_THRESHOLD`.     |

`UNCLASSIFIED` and `OUT_OF_SCOPE` score **0**, and drag the other two components
to zero with them: confidence in _not_ being a lead must not be paid for, or the
most confidently irrelevant rows would rank highest.

`evidenceNet` comes from `decidingNet(classifyLead(...))`. When it is absent —
an old row with no `classification_evidence` — the confidence stands in for it,
so a pre-existing lead is graded on what is known rather than punished for a
column that did not exist.

## The contactability table

Documented with its reasoning in `weights.ts`. The components sum to exactly
100, so a weight is also its share of the score. These are the old weights
scaled by 100/86 once relevance moved out, so the ranking _within_
contactability is the ranking the pilot was read with.

| Component         | Max | Why                                                                        |
| ----------------- | --: | -------------------------------------------------------------------------- |
| `phone`           |  44 | The deliverable. A name, a city and a phone is a good lead.                |
| `additionalPhone` |   7 | A second chance to reach the same business. Capped at two extra numbers.   |
| `mobileLine`      |   5 | Sole traders answer a 06x.                                                 |
| `email`           |   7 | Useful for the follow-up, never a reason to keep or drop a lead.           |
| `website`         |   9 | A contact channel _and_ corroboration that the business is real.           |
| `social`          |   5 | Often a fasader's only web presence.                                       |
| `city`            |  12 | Scaled by `resolveCity` confidence — an area-code guess scores 0.35 of it. |
| `corroboration`   |   7 | Two independent sources is the strongest liveness signal available. Cap 3. |
| `recency`         |   4 | Full inside 30 days, linear to zero at 365.                                |

A city is completeness, not relevance: every lead in this database is Serbian,
so knowing where one is says nothing about whether it buys facade panels.

## The one rule that is not a weight

**A lead with no phone is capped at 29, inside contactability.** Without it a
phone-less record with an email, a site, a social profile, a resolved city and
two sources reaches 44 and ties a bare phone-only lead at 44 — which inverts the
product. The cap makes every lead with a phone outrank every lead without one,
and it is recorded as a `noPhoneCeiling` component so the UI can say _why_
rather than showing a number that does not add up.

## Reading a lead out of the database

`toScoreInput` maps what the repository already returns onto the score input, so
the scorer stays free of Drizzle and the repository stays free of scoring rules;
`toGrading` maps the result back onto the columns `applyGrading` writes, so the
three callers that re-grade a lead cannot drift apart:

```ts
const score = scoreLead({
  ...toScoreInput({
    lead: getLead(db, leadId)!,
    phones: distinctPhones(db, leadId),
    contacts: leadContactClaims(db, leadId),
    sources: leadSourceRows(db, leadId),
    city: resolveCity(lead.cityRaw ?? '', { phone }),
    now: new Date(),
  }),
  // The label this run just computed, not the one still on the row.
  classification: {
    label: classification.label,
    confidence: classification.confidence,
    evidenceNet: decidingNet(classification),
  },
});

applyGrading(
  db,
  leadId,
  toGrading(
    {
      label: classification.label,
      confidence: classification.confidence,
      evidence: JSON.stringify(classification),
      industry: classification.industry ?? null,
    },
    score,
  ),
);
```

Pass the `CityMatch` when you still have it. Without it the city component falls
back to `leads.city_id` at `PERSISTED_CITY_CONFIDENCE` (0.8) — below an exact
match, because the row does not record how the city was resolved and treating an
unknown provenance as certain is how a landline guess becomes a fact.

## Backfilling an existing database

Migration `0004_relevance_and_scope` leaves all three score columns at 0 on
purpose: the old `lead_score` measured something that no longer exists.

```
npx tsx scripts/fuzz37-regrade.ts data/leads.sqlite
```

Add `--dry-run` to compute and print without writing, and
`--baseline <un-migrated copy>` to get a real before/after — the migration
rewrites the labels and zeroes the scores, so the old ranking is gone by the
time the script can read the target database.
