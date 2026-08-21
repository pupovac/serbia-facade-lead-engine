# companywall.rs — no-go on Terms of Service, and the free substitutes for what it offered

**Issue:** FUZZ-44 · **Date:** 2026-08-21 · **Author:** Scraper Engineer ·
**Outcome:** **NO-GO.** No enrichment path, no adapter, no bulk fetching. The
Terms of Service prohibit exactly the thing the spike proposed, in one sentence
that names `scraping` and `crawling` as words.

## The one-line answer

**companywall.rs's Terms of Service explicitly forbid automated, scripted, bulk
or systematic data retrieval without prior written consent — and they bind on
access, not on registration.** The permissive `robots.txt` the issue relied on
is contradicted by the contract sitting behind it, and where the two disagree
the contract is the stronger signal, not the weaker one.

The issue itself set this rule: _"read companywall's Terms of Service and report
what they say about automated access and re-use … If the ToS forbid it, stop and
report — same rule that ended FUZZ-39."_ They forbid it. This is that report.

Because the ToS were checked first (as the issue instructed), **questions 1–4
were never measured and must not be.** Measuring them requires the sitemap sweep
and the profile fetches the ToS prohibit. What that costs the project is
answered below under _What is actually lost_ — the short version is: very
little, because free and compliant substitutes exist for all three of
companywall's claimed unique values.

## What was fetched

Four pages, at ~1 req/s, honest User-Agent, no session, no login. Nothing that
resembles enumeration.

| URL                     | Status | Purpose             |
| ----------------------- | ------ | ------------------- |
| `/robots.txt`           | 200    | compliance          |
| `/` (homepage)          | 200    | locate the ToS link |
| `/uslovi-koriscenja`    | 200    | **the finding**     |
| `/izjava-o-privatnosti` | 200    | ZZPL posture        |

No `/firma/` profile was fetched during FUZZ-44. The one profile the issue
describes was read on 2026-08-21 while triaging FUZZ-39, before the ToS were
known; that measurement is not repeated here and should not be extended.

## The ToS finding, quoted

Source: <https://www.companywall.rs/uslovi-koriscenja>, header
`Posljednje ažurirano: 14.08.2025. godine`. All emphasis added.

### 1. The prohibition on scraping is explicit and by name

Under **`b. Strogo zabranjene aktivnosti`** ("strictly forbidden activities"),
the user is expressly forbidden to:

> „**Automatizovano, robotsko, skriptovano, masovno ili sistematično preuzima
> podatke, kao I da radi scraping, crawling, indeksiranje ili bilo koji oblik
> masovnog izvlačenja informacija bez prethodne pisane saglasnosti
> CompanyWall-a.**"
>
> _(Automatically, robotically, by script, in bulk or systematically download
> data, or perform scraping, crawling, indexing or any form of mass extraction of
> information without CompanyWall's prior written consent.)_

There is no ambiguity to argue about and no reading under which a 748-profile
join is permitted. The same list also forbids
„_Korišćenje automatizovanih alata, VPN, proxy ili drugih tehnologija za
skrivanja identiteta_" — automated tools and identity-hiding technologies — so
the polite-crawler defence is not available either.

### 2. It binds on access, not on registration

The obvious counter-argument is that these are subscriber terms and we never
subscribe. The document forecloses it in its opening section:

> „Ovi Opšti uslovi korišćenja Portala … uređuju prava i obaveze privrednih
> subjekata i njihovih ovlašćenih predstavnika … **pri pristupu, registraciji i
> korišćenju** portala www.companywall.rs"
>
> „**Pristupanjem i/ili korišćenjem Portala, Korisnik potvrđuje da je pročitao,
> razumeo i prihvatio ove Uslove** … U slučaju neslaganja sa Uslovima, Korisnik
> je dužan da odmah prestane sa korišćenjem Portala."
>
> _(These Terms govern rights and obligations … on **access, registration and
> use** … **By accessing and/or using the Portal, the User confirms they have
> read, understood and accepted these Terms** … If they disagree, the User must
> immediately cease using the Portal.)_

The homepage additionally renders a consent banner whose accept control links to
`/uslovi-koriscenja` with the label `Prihvatam uslove` ("I accept the terms").

### 3. Even lawfully obtained data could not be used the way this project uses data

Under **`a. Dozvoljeno korišćenje`**:

> „Izričito je zabranjeno svako korišćenje Portala, njegovih podataka ili analiza
> u svrhu prodaje, preprodaje, ustupanja, javnog objavljivanja ili redistribucije
> trećim licima … **Korisnik nema pravo da, direktno ili posredno, koristi bilo
> koje podatke ili sadržaje Portala radi izgradnje, unapređenja ili obogaćivanja
> sopstvenih baza podataka, servisa ili proizvoda koji se nude trećim licima.**"
>
> _(… **The User has no right, directly or indirectly, to use any data or content
> of the Portal to build, improve or enrich their own databases, services or
> products offered to third parties.**)_

"Enrich our own database" is a verbatim description of the proposed enrichment
path. This clause would bite even on data collected by hand.

### 4. Their own fair-use policy puts the abuse threshold below our volume

> „ukoliko u toku jednog meseca ostvarite protok, koji je jednak ili iznad **1000
> pregledanih kompanija**, smatraćemo da ste napravili nadprosečno veliki broj
> pregleda stranica."

The daibau join alone is 748 profile views, and the kompanije.net cross-check
would be ~9,830. The site's own stated threshold for "above-average" usage sits
between the two. Even a hand-operated version of this join is outside what they
consider normal.

### 5. Stated consequences

Suspension without warning, a demand to delete all copied data, damages, and
„pokretanje odgovarajućih pravnih radnji pred nadležnim sudom … uključujući
krivične, prekršajne i građanske postupke" — civil, misdemeanour and criminal
proceedings. Separately, the intellectual-property section asserts rights over
„baze podataka" as such, which in Serbian law (Zakon o autorskom i srodnim
pravima, database producer's right) is an independent bar on systematic
extraction of a substantial part of a database — it does not depend on the
contract having been formed.

### 6. `robots.txt` — accurate, and beside the point

Re-fetched 2026-08-21, verbatim on the relevant lines:

```
User-agent: *
Disallow: /Home/ExportCsv*
Disallow: /Home/ExportExcel*
Disallow: /Home/Company*
Disallow: /Home/Search*
Disallow: /pretraga*
Allow: /
Sitemap: https://www.companywall.rs/sitemap
Sitemap: https://www.companywall.rs/CWBizApp_sitemapRS.xml
```

The issue read this correctly: `/firma/*` is permitted, search is not, and the
export endpoints are not. The reading error was treating that as the whole
compliance question. `robots.txt` is a crawler-routing convention; it is not a
licence, and a site that publishes both a permissive `Allow: /` and a ToS
banning scraping has not granted permission — it has told a crawler which URLs
not to waste requests on. The sitemap listing in `robots.txt` is likewise a
search-engine affordance, not an invitation to mirror 613,000 profiles.

**Verdict: NO-GO.** Do not fetch companywall.rs profiles, do not walk its
sitemap, do not build an adapter or an `enrich` source against it.

## Answers to the six questions

| #   | Question                                            | Answer                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Match rate, 748 daibau names → companywall profiles | **Not measured, and must not be.** Requires the 613-page sitemap sweep the ToS forbid.                                                                                                                                                                                                                                                                            |
| 2   | Phone coverage on matched facade contractors        | **Not measured, and must not be.** Requires bulk `/firma/` fetching.                                                                                                                                                                                                                                                                                              |
| 3   | Prefix-agreement rate on matched pairs              | **Not measured, and must not be.** Same dependency as 2.                                                                                                                                                                                                                                                                                                          |
| 4   | Sitemap cost and stability                          | **Not measured, and must not be.** ~110 MB of systematic retrieval is the textbook case of „masovno ili sistematično preuzimanje".                                                                                                                                                                                                                                |
| 5   | Does the join beat going direct?                    | **No — and it is moot.** See below.                                                                                                                                                                                                                                                                                                                               |
| 6   | Coverage of the unregistered                        | **Structurally incomplete by design.** companywall is an APR mirror, by its own ToS §"COMPANYWALL preuzima podatke iz zvaničnih izvora, uključujući Agenciju za privredne registre". A daibau contractor trading informally has no profile to match. The share was not measured; it is not zero, and on a trade with a large grey segment it is not small either. |

Recording "not measured" here is deliberate. The numbers are not missing through
lack of effort — they are the price of the compliance finding, and a future run
should not read the blanks as an invitation to go and fill them in.

## What is actually lost — and the free substitute for each part

The issue framed companywall's distinct value as three things. None of them is
lost, because each has a free, compliant source, and two of them are more
authoritative than companywall.

### `U blokadi` → **NBS Registar dužnika u prinudnoj naplati** (verified today)

The National Bank of Serbia operates the official register of debtors in
enforced collection — the primary source companywall is itself mirroring. Free,
public, no login:

- Entry point `https://nbs.rs/sr/drugi-nivo-navigacije/servisi/duznici-dupn`,
  which redirects to
  `https://webappcenter.nbs.rs/PnWebApp/EnforcedCollectionDebtor/EnforcedCollectionDebtor/Index`
  (HTTP 200, 14 KB, server-rendered).
- **Queried by matični broj or PIB** — exactly the two identifiers kompanije.net
  already publishes on every record. No name matching, no fuzzy join, no
  check-digit trick: it is an exact-key lookup on a state register.
- `nbs.rs/robots.txt` disallows only `/sr_RS/o_nbs/.content/` and
  `/system/modules/yu.nbs.news/`. `webappcenter.nbs.rs` serves no `robots.txt`
  at all (404), so nothing there is disallowed.
- Its own note states the identification database is built from APR-registered
  business names plus names banks supply to NBS's Jedinstveni registar računa —
  so unlike APR open data it is **not** limited to privredna društva, and should
  reach preduzetnici holding a business account. Not measured; verify before
  relying on it.

Caveat before anyone builds on this: NBS terms of use were **not** reviewed in
this spike, and the query form's parameter contract was not tested. That is a
separate, small piece of work — see _Recommendation_.

### Freshness / active status → **APR open data** (already established, free)

`openapi.apr.gov.rs` was established as free open data in FUZZ-8 and reconfirmed
in FUZZ-41 (133,634 active privredna društva, cut 2026-07-31, joinable on matični
broj). That answers "is this company still alive" for the company side directly
from the registrar, which is strictly better provenance than a commercial mirror
of the same registrar.

The residual gap is real and unchanged: **APR open data excludes preduzetnici**,
which is precisely the segment kompanije.net reaches (~7,540 of its 9,830 core
records). companywall would not have closed that gap either — its ToS closed it
first — and the NBS route above is the more promising lead on it.

### Email → **not a project blocker**

The project's stated rule is phone-first: _"Never discard a lead for missing an
email. A lead with only a name, a city and a phone is a good lead."_ Trading a
ToS breach for a field the product explicitly deprioritises is not a trade worth
considering.

### Question 5, answered plainly

kompanije.net already yields ~9,830 core facade records at a measured **68%**
phone fill, indexed by activity code, with street addresses, matični broj and
PIB, requiring **no join at all** and carrying no robots rule and no ToS
restriction (FUZZ-41). companywall is a lookup source that cannot be enumerated
by trade, needs a fuzzy name join to be useful, and forbids the join in writing.
It loses on every axis, including the ones that have nothing to do with
compliance.

## A note on the daibau prefix trick

The join design was clever and the reasoning about `confidence.ts` was sound —
a 7-digit prefix genuinely is a good corroborating identifier, and insisting on
it was the right instinct. It is worth separating that from the outcome: the
idea did not fail on its logic, it failed on the counterparty's terms.

One thing to sit with if a similar design comes up again. The purpose of the
prefix trick is to reconstruct a number daibau deliberately withholds, because
routing that lead _is_ daibau's business. Sourcing the missing digits elsewhere
avoids the robots-disallowed endpoint, which is a real distinction and not a
dishonest one — but it does not change what the finished record is. That is
worth deciding on purpose rather than by accident, and it is a question for the
project owner, not for an adapter.

## Registry

`research/sources-contractors.json` gains a `companywall` entry with priority
`Low`, `recommended_approach` beginning `REJECTED`, and the id added to
`summary.rejected_ids`, so the next source survey does not re-open this.

## One gap this exposed in the `sources` table

`src/lib/db/seed-sources.ts` maps a registry entry's `robots_allows` to a
`sources.robots_allows` boolean, and there is no column for "the Terms of
Service forbid this". companywall seeds as `robots_allows = true`, which is
factually correct about `robots.txt` and yet the opposite of the operative
verdict. Nothing is broken today — the entry is in `summary.rejected_ids`, so
it seeds with `priority = 'rejected'` and `enabled = false`, and the
orchestrator will not run it — but a future reader querying
`SELECT … WHERE robots_allows = 1` gets a misleading row.

`src/lib/db` is the Data Engineer's boundary, so this write-up does not change
the schema. The suggestion, for whoever owns that call: a nullable
`tos_allows` column alongside `robots_allows`, seeded from a `tos_forbids` key
in the registries (this entry already writes one). companywall is the first
source in either registry where robots and the contract disagree; it will not
be the last.
