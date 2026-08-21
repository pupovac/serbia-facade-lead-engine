# `nadjimajstora-rs` — Nađi Majstora, the tradesman directory

89 profiles, 89 phone numbers. The smallest source in the project and the only
one with **100% phone coverage**, because every record is a tradesman who
registered to be phoned.

|                         |                                                                            |
| ----------------------- | -------------------------------------------------------------------------- |
| Entry URL               | `https://www.nadjimajstora.rs/gradjevinski-radovi/<trade>.htm`             |
| Record URL              | `https://www.nadjimajstora.rs/gradjevinski-radovi/<trade>/<slug>-<id>.htm` |
| Categories walked       | `fasader` (56), `izolater` (33)                                            |
| Lead types              | `FACADE_CONTRACTOR`                                                        |
| Requests per full crawl | **272** — 5 listing pages + 3 per master                                   |
| Requires JS             | no                                                                         |
| Classification          | source-asserted, never inferred                                            |

## The phone number, and why there is no Playwright here

FUZZ-40 was opened with the phone mechanism unknown and Playwright pre-approved
if it turned out to be necessary. It is not. The profile page carries no number
— that part of FUZZ-4's reconnaissance was accurate — but the contact tab's
_Prikaži brojeve telefona_ button is bound in `/js/main.js` to a single request:

```
POST https://www.nadjimajstora.rs/master/show_tel/
Content-Type: application/x-www-form-urlencoded

id=2298
```

```json
{
  "ind": 1,
  "html": "\n<a href=\"tel:0645880669 \" >0645880669 </a><br/>\n<a href=\"tel:\" ></a>",
  "msg": "Show master phone"
}
```

No cookie, no CSRF token, no referer check, no session — the master id is the
entire request. An unrecognised id answers with the JSON literal `null`, which
is a different fact from "this tradesman has no number" and is treated as one.

`robots.txt` disallows `/cgi-bin/`, `/mezimci/`, `/ac/` and one named profile (a
driver in Kikinda, in a category this adapter never walks). `/master/show_tel/`
is not disallowed. Saved verbatim as `__fixtures__/robots.txt`.

## Three traps, each of which fails silently

**1. Single-quoted attributes.** Rows are `<a href='…' class='Master-Item '>`.
A `class="…"` matcher finds an empty page and reports a healthy run with zero
leads. cheerio makes this a non-issue; the fixture asserts it anyway.

**2. Page 1 sorts differently from pages 2+.** The pager links
`?p=N&s=o&st=asc`; the bare category URL sorts rating-**descending**. Walking
page 1 bare and the rest paged reads two different orderings of one list — on
`fasader` that returns 56 rows holding **36** distinct masters, a 36% loss that
looks exactly like a smaller source. `listingUrl` always sends the sort
parameters.

**3. An unknown slug is `200`, not `404`.** The site renders its whole template
with every field blank — `<h1> - </h1>`, `ID: `, and a leftover rating. The
name assertion in `parseProfile` requires a Unicode letter for exactly this
reason; a plain emptiness check passes, because the heading trims to `-`.

A fourth, milder one: the header count is not the row count. `moler` prints
`1 - 20 od 456` and paginates 450. The walk therefore ends on a short page and
**reports** the gap rather than asserting equality.

## The services checklist means the opposite of what it looks like

Every profile renders its trade's **entire** vocabulary and marks the ones the
tradesman offers with `.check.checked`; an unticked row is a grey circle. Read
without the class, every fasader claims all seven facade services including the
ones they declined. Only ticked services reach `categories`; the full
vocabulary is kept in `extra.occupationVocabulary`.

This is also what settles the adjacent-category question. The checklists are
**partitioned by trade** — a `moler` may pick `Špatulat` or `Krečenje`, a
`zidar` `Malterisanje`, a `gipsar` `Spuštanje plafona`. None of those
vocabularies contains a facade or insulation option at all, so a facade crew
filed as a moler has no way to say so. 30 profiles sampled from each of
`moler`, `zidar` and `gipsar` — 90 in total — produced **zero** with a facade or
insulation occupation, and the three categories share **zero** master ids with
`fasader` and `izolater`. Walking them would cost ~2,300 requests for nothing.
Recorded in `categories.ts` as `REJECTED_CATEGORIES` so nobody re-runs the
sample.

## Classification is asserted, not inferred

These are `preduzetnici` listed as `Srdjan Todić`, not `TERMO FASADE d.o.o.`.
Measured on the real run: **34 of 78 leads (44%) would have been `UNKNOWN`** if
the word-scorer had been allowed to read their names. So the adapter sets
`assertedType`, `pipeline.ts` takes it, and the scorer's opinion is kept under
`classification_evidence.inferred` — never acted on, but available for auditing
the classifier against a corpus whose answer is known.

## The address field is three slots, two of them undivided

The `Prebivalište` box separates only the last line with a `<br/>`; street and
place arrive in one text node:

```html
<p>
  Knez mihajla 5 Paraćin <br />
  Paracin
</p>
```

There is no markup to split on, so the split is on meaning: the place is
whichever known Serbian place name the chunk ends with. The vocabulary is
`src/lib/geo` — municipalities _and_ settlements, because a Belgrade tradesman
writes `Sremčica` or `Karaburma` where the site's own dropdown says `Čukarica`.
That takes place resolution from 87% to **78 of 78**.

The third line is free text the tradesmen fill inconsistently — a settlement for
some, a second street for others. Kept verbatim in
`extra.residenceExtraLine`, never trusted as a place.

## One tradesman, two profiles

A master registered in two trades gets two ids: `Knauf Profi` is 380 under
`fasader` and 395 under `izolater`, same two numbers on both. `Miloš Stojanović`
holds four ids under `fasader` alone. All of them are emitted — merging belongs
to `src/lib/dedup`, and the strongest signal it has, an identical normalized
phone, is on both records. **89 records merge to 78 leads.**

## Measured run — 2026-08-21

```
items       discovered 89, extracted 89, skipped-fresh 0, failed 0
records     emitted 89, with a phone 89, rejected 0
leads       created 78, updated 11, phones added 93
requests    272 of 600 budget, 0 retries
```

78 leads, all `FACADE_CONTRACTOR`, none `UNKNOWN`; 78/78 resolved to a
municipality; 93 phone numbers, all valid under region `RS`. Against
`portal-srbija` run into the same database (477 leads), the overlap is **zero**
at lead, phone and name-key level.
