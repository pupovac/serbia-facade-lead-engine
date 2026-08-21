# FUZZ-40 — `nadjimajstora-rs`, and the phone that was there all along

Run date 2026-08-21. Everything below is measured against the live site, not
estimated.

## The finding the issue asked for first

FUZZ-40 opened with a disposal rule: _a source that yields 56 names and no
numbers is not worth an adapter — report it and close the issue._ The rule did
not fire. **Phone coverage is 89 of 89 profiles.**

FUZZ-4 recorded this source as `0% measured` and ranked it `Low`. That
measurement was correct about the page and wrong about the source. The profile
HTML genuinely carries no phone; the number is one request away:

```
POST https://www.nadjimajstora.rs/master/show_tel/
Content-Type: application/x-www-form-urlencoded

id=2298
```

```json
{ "ind": 1, "html": "…<a href=\"tel:0645880669 \">0645880669 </a>…", "msg": "Show master phone" }
```

No cookie, no token, no referer check, no session. `/js/main.js` binds it to
the contact tab's _Prikaži brojeve telefona_ button; the adapter replays the
same request a visitor's browser makes. An unknown id answers the JSON literal
`null` — a different fact from "no number", and treated as one.

**No headless browser.** The issue pre-approved Playwright for 56 profiles if
the number turned out to be unreachable otherwise. It is reachable with `fetch`,
so cheerio it is.

`robots.txt` disallows `/cgi-bin/`, `/mezimci/`, `/ac/` and one named profile.
`/master/show_tel/` is not disallowed. Nothing was scraped behind a login and no
CAPTCHA was touched — the one CAPTCHA on this site guards its abuse-report form,
which the adapter never posts to.

## The run

```
items       discovered 89, extracted 89, skipped-fresh 0, failed 0
records     emitted 89, with a phone 89, rejected 0
leads       created 78, updated 11, phones added 93
requests    272 of 600 budget, 0 retries, 408 s wall
```

| Metric                         | Value                           |
| ------------------------------ | ------------------------------- |
| Records emitted                | 89                              |
| **Phone coverage**             | **89 / 89 — 100%**              |
| Distinct leads after dedup     | 78                              |
| Phone numbers stored           | 93, all valid under region `RS` |
| Classified `FACADE_CONTRACTOR` | 78 / 78                         |
| Classified `UNKNOWN`           | **0**                           |
| Resolved to a municipality     | 78 / 78                         |
| Mean lead score                | 70.5                            |

Categories walked: `fasader` (56) and `izolater` (33).

## What the adjacent categories are worth: nothing

The issue asked whether facade crews hide under `moler`, `zidar` or `gipsar`.
They do not, and the reason is structural rather than statistical.

Every profile renders its trade's **entire** service vocabulary and ticks the
subset the tradesman offers (`.check.checked`; unticked is a grey circle). Those
vocabularies are partitioned by trade — a `moler` chooses among `Špatulat`,
`Krečenje`, `Farbanje stolarije`; a `zidar` among `Malterisanje`, `Zidanje u
visokogradnji`; a `gipsar` among `Spuštanje plafona`, `Izrada šankova`. **No
facade or insulation option exists in any of the three.** A facade crew
registered as a moler has no way to say so.

| Category   | Listed | Sampled | With a facade/insulation service | Master ids shared with `fasader`+`izolater` |
| ---------- | ------ | ------- | -------------------------------- | ------------------------------------------- |
| `fasader`  | 56     | 56      | — (taken)                        | —                                           |
| `izolater` | 33     | 33      | — (taken)                        | 0                                           |
| `moler`    | 456    | 30      | **0**                            | 0                                           |
| `zidar`    | 65     | 30      | **0**                            | 0                                           |
| `gipsar`   | 260    | 30      | **0**                            | 0                                           |

Walking all three would cost ~2,300 requests to add zero qualified leads.
Recorded in `categories.ts` as `REJECTED_CATEGORIES` so the sample is not re-run.

`izolater` was kept: of its 33 profiles, the thermal-insulation trade is the
same wall job our panel replaces. Its ticked services split `Drenaža`,
`Hidroizolacija` and `Termoizolacija`, and the split is recorded per record, so
a reviewer wanting only the thermal ones can filter rather than re-crawl.

## New versus existing

`data/` is gitignored and each agent workdir starts empty, so there is no pilot
database to diff against — the baseline was rebuilt the same way FUZZ-18 did it.
`portal-srbija` was run into the same database as the closest comparable source:
a facade-category directory, Belgrade-heavy, the best-ranked contractor source
in the registry. It produced 485 records / 477 leads, matching FUZZ-18's figures
exactly.

**Overlap with `nadjimajstora-rs`: zero.** Not "small" — zero, at all three
levels checked:

| Overlap signal                 | Shared |
| ------------------------------ | ------ |
| Same lead after dedup          | 0      |
| Same normalized phone (`e164`) | 0      |
| Same normalized company name   | 0      |

All 78 businesses are new. That is what a sole-trader directory looks like next
to a company directory: `portal-srbija` lists `d.o.o.`s, this lists people.

The contrast in classification is the other half of the point:

| Source             | Leads | `FACADE_CONTRACTOR` | `UNKNOWN` |
| ------------------ | ----- | ------------------- | --------- |
| `nadjimajstora-rs` | 78    | 78 (100%)           | **0**     |
| `portal-srbija`    | 477   | 14 (3%)             | 362 (76%) |

## Source-asserted classification

The epic requires these adapters to set `FACADE_CONTRACTOR` from provenance and
not route records through name-based classification. That needed a mechanism,
which this issue added:

- `rawLeadSchema` gained `assertedType` / `assertedTypeReason` at the adapter
  boundary.
- `assertClassification()` in `src/lib/classify` builds the result.
- `pipeline.ts` takes the asserted label when present, and keeps the
  word-scorer's answer under `classification_evidence.inferred`.

The inferred answer is kept because it is the measurement that justifies the
mechanism. On this corpus: **34 of 78 leads (44%) would have been `UNKNOWN`**
had the scorer decided. Those are the ones who ticked no services, leaving a
personal name and nothing else to read.

The 44 the scorer did label correctly got there via the ticked services
(`Postavljanje fasade`) and the trade label, both of which ride in `categories`.

## Shared-code changes

Two, both general rather than source-specific:

1. **`FetchOptions.form`** — a url-encoded POST through `PoliteFetcher`, so a
   reveal endpoint is reachable without bypassing robots, the rate limit, the
   budget or the retry ladder. The body is re-encoded per attempt: a
   `URLSearchParams` is spent once read, and a replayed empty body would turn a
   transient 503 into a lost phone number.
2. **Source-asserted classification**, above.

## Traps worth remembering

- **Page 1 sorts differently from pages 2+.** The pager sends
  `?p=N&s=o&st=asc`; the bare category URL sorts rating-descending. Mixing them
  returns 56 `fasader` rows holding **36** distinct masters — a 36% silent loss
  that reads as a smaller source.
- **An unknown slug returns `200` with a blank template**, not a 404 — heading
  `-`, empty `ID:`, a leftover rating. A non-empty check passes it; the name
  assertion requires a Unicode letter.
- **The header count is not the row count.** `moler` prints `od 456` and
  paginates 450. The walk ends on a short page and reports the gap.
- **Unticked services are the opposite of a claim.** Reading every `h4` credits
  each fasader with all seven facade services, including the declined ones.
