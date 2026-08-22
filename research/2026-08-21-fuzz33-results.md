# FUZZ-33 — measured before and after, on the pilot corpus

Everything below is measured, not asserted. `scripts/fuzz33-replay.ts` replays
all 4,468 payloads from the FUZZ-22 pilot's `raw_records` through
`validateRawLead` → `normalizeRawLead` → `persistLead` — the same three calls
`src/scraper/run.ts` makes — in their original write order, then runs the dedup
sweep. It was run twice with the same method and the same input: once on `main`
at `ef0ab6a`, once on this branch.

486 of the 4,468 records are `website-enrichment` payloads, which are not
`RawLead`s and are rejected at the zod boundary by both runs equally. 3,982
records are replayed.

## Items 1 and 2 — the numbers the issue asks for

|                                                    | before (`main`) | after     |          |
| -------------------------------------------------- | --------------- | --------- | -------- |
| `lead_phones` rows                                 | 7,636           | 7,158     |          |
| valid                                              | 7,004           | **7,126** | +122     |
| invalid                                            | 632             | **32**    | −600     |
| junk `e164` (`0xx xxx xxx, PRODAJA` in the column) | 621             | **0**     | −621     |
| distinct valid E.164                               | 6,760           | **6,875** | **+115** |
| leads carrying a phone                             | 3,522           | 3,529     | +7       |
| phones carrying a department/branch label          | 0               | 599       |          |
| phones scoped `branch`                             | 0               | 306       |          |
| leads (after dedup)                                | 3,607           | 3,614     |          |
| merge tombstones                                   | 19              | **14**    | −5       |
| merges decided on a phone                          | 13              | **8**     | −5       |
| review queue pending                               | 424             | 427       |          |

**Item 2 — department labels.** 600 of the 632 unparseable rows now parse. Of
those, **115 are numbers that existed nowhere else in the corpus** — the issue
estimated "up to ~94". The other 485 turned out to be a second spelling of a
number the lead already had, and collapse into the existing claim, which is why
the row count falls while the valid count rises. The 32 that still fail are the
ones that should: foreign numbers (`+385…`, `+36…`, `+380…`) and two genuinely
malformed strings.

**Item 1 — cross-branch phone leakage.**

|                                                   | before | after   |
| ------------------------------------------------- | ------ | ------- |
| valid geographic landlines checked                | 4,733  | 4,835   |
| area code disagrees with the lead's municipality  | 316    | 361     |
| …on how many leads                                | 126    | 157     |
| **…and is still treated as that lead's identity** | 316    | **105** |
| **…on how many leads**                            | 126    | **41**  |

The raw disagreement count goes **up**, and that is the two fixes interacting
rather than a regression: label stripping recovered 600 numbers, and a good
share of them are exactly the branch numbers a directory prints under a head
office (`021 xxxx xxx, CENTRALA BEČEJ`). They were invisible to the proxy while
they sat in the corpus as unparseable junk; now they parse, so now they count.

The number that matters is the last pair. A phone the record itself says belongs
to another location is not a contradiction — it is a labelled branch line, kept
and delivered — and it can no longer merge two businesses together. Measured on
identity only: **316 → 105 phone rows (−67%), 126 → 41 leads (−67%)**.

### The spot-check case, followed end to end

`GDC S.R.M.A` is why this issue exists. Before, the Belgrade branch absorbed
four other branches' numbers and the sweep then merged those four real leads
into it — five businesses, one row, four tombstones. After:

| lead | city          | valid phones | of which its own |
| ---- | ------------- | ------------ | ---------------- |
| 1723 | Beograd-Zemun | 8            | 4                |
| 1724 | Kraljevo      | 1            | 1                |
| 1725 | Niš           | 1            | 1                |
| 1726 | Šabac         | 1            | 1                |
| 1727 | Vranje        | 1            | 1                |

**All four branch leads survive.** The Belgrade row still carries all eight
numbers — nothing was deleted — but four of them are now scoped `branch`, so
they are not its identity and cannot pull another lead in.

### What the residual 41 leads actually are

The issue is right that the area-code check is a proxy, so the residual was
diagnosed rather than assumed. Sampled on the replayed corpus:

- **21 leads where every landline disagrees.** These are **city-resolution**
  errors, not phone leakage: `DOO Zidar, Negotin` is filed under `beograd` with
  two `019` (Negotin) numbers, `Artinvest` under `beograd` with `022` (Sremska
  Mitrovica), `Woby Haus Rumenka` under `beograd` with `021`. The phone is
  right and the city is wrong. The rule deliberately does **not** demote a
  lead's only line — doing so would cost the lead its deliverable to fix a
  field that is wrong somewhere else. Worth its own issue against
  `resolveCityDetailed`.
- **20 leads where a chain was merged into one row.** `overture-places` files
  each branch as its own record with its own single phone, so the per-record
  rule sees nothing wrong; the sweep then merges them and the survivor
  accumulates the lot. `recordMerge` now re-scopes the survivor's whole phone
  list against the survivor's municipality, which is what took this class from
  ~23 leads to 20 and the phone rows from 124 to 105. The remainder are chains
  with no number matching their own filed municipality — nothing to anchor
  against, so nothing is demoted.

### Does the sweep still settle?

A merge re-scopes the survivor's phones, which changes what the next round can
match on, so this needed checking rather than assuming. Re-running the sweep on
the finished corpus: **1 round, 0 merges, `roundsExhausted: false`.** It is at a
fixed point. The sweep does take more rounds than the pilot's 2 to get there —
demoting a number relaxes the quarantine on it, which lets a later round decide
a pair it previously declined — but it converges on its own, well inside the cap
of 8.

## Reproducing

```bash
multica attachment download 01a02437-5c3b-7779-89b1-9c34ac5e6520 -o ./data
gunzip -c data/leads.sqlite.gz > data/leads.sqlite
npx tsx scripts/fuzz33-replay.ts ./data/leads.sqlite --out ./tmp/after.sqlite
```

About nine minutes, no network. Check out `main` and run the same script to
reproduce the `before` column.
