# FUZZ-18 — `gradjevinarstvo-rs`, and how much of it we already had

Run date 2026-08-20/21. Everything below is measured, not estimated; the
overlap figures come from `scripts/fuzz18-overlap.ts`, which is committed so the
numbers can be re-derived.

## The baseline the overlap is measured against

`data/` is gitignored and every agent run gets a fresh workdir, so the corpus
was rebuilt from scratch before anything was measured. Two adapters were run:

| Adapter           | Records | Leads created                            | Wall time | Requests |
| ----------------- | ------- | ---------------------------------------- | --------- | -------- |
| `portal-srbija`   | 485     | 477                                      | 1,721 s   | 832      |
| `overture-places` | 1,718   | 1,595 (+123 merged onto `portal-srbija`) | 39 s      | 1        |

`austrotherm-distributeri` was **not** run: it is a store source, and the
question here is contractor overlap.

`portal-srbija` yielded 485 records rather than the 81 FUZZ-17 reported, because
this was the full city sweep FUZZ-8 corrected the plan to — 9 categories across
every city page the source itself links, not the truncating national pages.

The baseline was then consolidated with `dedupeDatabase`, which found **no
further merges** (2,072 leads before and after) and queued 45 review pairs. So
the baseline is **2,072 leads**, 1,993 of them with a phone.

## What was crawled

The register holds 11,291 companies at one request each — a little over three
hours at one per second, which did not fit this run. **2,885 companies were
read, 25.6% of the register**, in two strata rather than one prefix:

| Stratum | Company ids   | Companies read | Serbian records |
| ------- | ------------- | -------------- | --------------- |
| A       | 1003 – 4117   | 1,886          | 1,032 (54.7%)   |
| B       | 16115 – 17471 | 999            | 990 (99.1%)     |

Two strata because the sitemap is ordered by company id and company id is
effectively registration order. A prefix sample is all old companies, and old
companies are exactly the ones a 2019-vintage directory like `portal-srbija`
also has — it would have biased the overlap upward. Stratum B was reached by
setting the adapter's own resume cursor to the 80th-percentile id.

**The two strata do not disagree** (11.2% vs 8.5% already known), which is the
main reason the headline figure is worth extrapolating.

### The 863 companies that were read and not emitted

All of them from stratum A, all non-Serbian. The register is regional: the
oldest 17% of it is **45% ex-Yugoslav and foreign** companies — Bosnian,
Croatian, Slovenian, Polish. The modern end is 99.1% Serbian. Worth knowing
before anyone budgets the remaining 8,400 pages: the low-id half costs nearly
twice as much per usable record.

## What the source yields

| Measured on the 2,022 emitted records |                   |
| ------------------------------------- | ----------------- |
| Records emitted                       | **2,022**         |
| …carrying a phone                     | **2,018** (99.8%) |
| Rejected at the zod boundary          | 0                 |
| Leads carrying this source            | 1,994             |
| Distinct E.164 numbers                | 5,991             |
| Leads with a website                  | 1,568             |
| Municipalities covered                | **145 of 145**    |

99.8% phone coverage against the registry's estimate of ~90%. The difference is
the multi-phone run in the contact card: a company lists three or four numbers
under one icon, and reading only the first would have thrown most of the mobiles
away.

## The overlap — the number this issue exists to produce

Every emitted record was put back through `normalizeRawLead` and scored against
the baseline with `findCandidates` + `scoreMatch` — the same engine
`dedupeDatabase` runs, quarantine included. The comparison is on the **incoming
record**, before any merge; scoring the stored lead instead would have scored
half of these records against a copy of themselves.

| Verdict       | Records   | Share     |
| ------------- | --------- | --------- |
| Already known | **200**   | **9.9%**  |
| Needs review  | 126       | 6.2%      |
| New           | **1,696** | **83.9%** |

Deciding signal on the 200 matches:

| Signal           | Matches |
| ---------------- | ------- |
| `phone`          | 169     |
| `website_domain` | 28      |
| `name_city`      | 3       |

And on the 126 review-band pairs: `name_city` 102, `address` 24.

### The 9.9% is an upper bound

Of the 200 matches, **132 are corroborated by the company name and 68 are not**
— a phone matched, the names have nothing in common. Those are shared-number
artifacts: a business-centre switchboard, a shared reception, an accountant's
line printed by several clients. `BECCHIS OSIRIDE` in Kragujevac matching
`Azma izolacioni materijali` on `+38134334455` is one of them.

They are not wrong to surface — a shared number is genuinely ambiguous, and
this is what the quarantine exists to catch once a value is seen across enough
businesses — but they should not be counted as "we already had this company".

**So the honest range is 6.5% – 9.9% already known, and 84% new.**

### On the facade slice specifically, overlap is three times higher

| Slice                                 | Records | Already known |
| ------------------------------------- | ------- | ------------- |
| All emitted records                   | 2,022   | 200 (9.9%)    |
| Facade-relevant by the source's words | 297     | 86 (29.0%)    |
| Classified `FACADE_CONTRACTOR`/`BOTH` | 59      | 16 (27.1%)    |

That is the finding that actually bears on saturation, and it points the
opposite way from the headline number: **the register as a whole is 90% new to
us, but the part of it we are in business for is only ~71% new.** A
facade-targeted directory has already found a third of the facade companies a
sector-wide register holds.

### Caveat: the facade slice is understated, and the classifier is why

1,848 of the 2,022 records classify as `UNKNOWN` — 91%. This is the ALL-CAPS
defect FUZZ-30 is fixing, and this source is the worst possible case for it:
`gradjevinarstvo.rs` prints nearly every company name in caps
(`POPOVIĆ`, `IZO PRO TEAM`, `STIROKOOP`). The 297-record text count above reads
the source's own category names and notes directly instead of trusting the
label, which is why it is five times the classifier's 59.

The overlap percentages are **not** affected — they are computed over identity
signals (phone, domain, name, address), never over classification. Only the
facade-slice split above depends on it, and it is reported both ways for that
reason.

## What this says about building more contractor sources

- **A sector-wide register is not saturated.** 84% of what this source
  published was new, and it is the largest crawlable source in the registry.
  The remaining 8,400 pages are worth the three hours.
- **Facade-targeted directories are approaching saturation faster.** 29%
  overlap on the facade slice, against a baseline of only two sources, is high.
  A third facade-category directory (`navidiku-rs`, `011info`) should be
  expected to return well under half new records — and both are Belgrade-heavy,
  where the existing overlap is concentrated.
- **The cheapest remaining win is not another directory, it is finishing this
  one.** Same adapter, same code, no new parsing risk, and the modern end of the
  register is 99% Serbian with 99.8% phone coverage.
- **Reach for a structurally different source next, not a bigger one.**
  `poslovni-kontakt` was measured during the pick for this issue and holds only
  ~12 facade-relevant records, but they are sole-trader moler/fasader crews with
  a mobile and no company website — a population neither a register nor a
  geographic dataset contains. Small, and orthogonal.

## Reproducing

```bash
npm run scrape -- --source portal-srbija --trigger backfill
npm run scrape -- --source overture-places --trigger backfill
cp data/leads.sqlite data/baseline.sqlite
npm run scrape -- --source gradjevinarstvo-rs --delay 1000 --budget 3000
npx tsx scripts/fuzz18-overlap.ts
```
