# `src/lib/score` — how good the _data_ is, not how likely the sale is

`scoreLead(input)` returns 0–100 measuring **data completeness and relevance**,
with the component breakdown that explains it. It is explicitly not a purchase
prediction; nothing here knows anything about buying.

```ts
import { scoreLead, toScoreInput } from '@/lib/score';

scoreLead({ phones: [{ e164: '+381641234567', type: 'mobile' }] });
// → { score: 46, capped: false, components: [
//      { id: 'phone', points: 38, max: 38, detail: '1 phone' },
//      { id: 'mobileLine', points: 4, max: 4, detail: '1 mobile' }, … ] }
```

## The weight table

Documented with its reasoning in `weights.ts`. The components sum to exactly
100, so a weight is also its share of the score.

| Component         | Max | Why                                                                        |
| ----------------- | --: | -------------------------------------------------------------------------- |
| `phone`           |  38 | The deliverable. A name, a city and a phone is a good lead.                |
| `additionalPhone` |   6 | A second chance to reach the same business. Capped at two extra numbers.   |
| `mobileLine`      |   4 | Sole traders answer a 06x.                                                 |
| `email`           |   6 | Useful for the follow-up, never a reason to keep or drop a lead.           |
| `website`         |   8 | A contact channel _and_ corroboration that the business is real.           |
| `social`          |   4 | Often a fasader's only web presence.                                       |
| `city`            |  10 | Scaled by `resolveCity` confidence — an area-code guess scores 0.35 of it. |
| `classification`  |  14 | Relevance. `UNKNOWN` scores zero, and `BOTH` scores the same as one label. |
| `corroboration`   |   6 | Two independent sources is the strongest liveness signal available. Cap 3. |
| `recency`         |   4 | Full inside 30 days, linear to zero at 365.                                |

## The one rule that is not a weight

**A lead with no phone is capped at 25.** Without it, a phone-less record with an
email, a site, a social profile, a resolved city and a confident label scores 52
and outranks a phone-only lead at 42 — which inverts the product. The cap makes
every lead with a phone outrank every lead without one, and it is recorded as a
`noPhoneCeiling` component so the UI can say _why_ rather than showing a number
that does not add up.

## Reading a lead out of the database

`toScoreInput` maps what the repository already returns onto the score input, so
the scorer stays free of Drizzle and the repository stays free of scoring rules:

```ts
const score = scoreLead(
  toScoreInput({
    lead: getLead(db, leadId)!,
    phones: distinctPhones(db, leadId),
    contacts: leadContactClaims(db, leadId),
    sources: leadSourceRows(db, leadId),
    city: resolveCity(lead.cityRaw ?? '', { phone }),
    now: new Date(),
  }),
);
applyGrading(db, leadId, {
  classification: classification.label,
  classificationConfidence: classification.confidence,
  classificationEvidence: JSON.stringify(classification),
  leadScore: score.score,
  scoreBreakdown: JSON.stringify(score.components),
});
```

Pass the `CityMatch` when you still have it. Without it the city component falls
back to `leads.city_id` at `PERSISTED_CITY_CONFIDENCE` (0.8) — below an exact
match, because the row does not record how the city was resolved and treating an
unknown provenance as certain is how a landline guess becomes a fact.
