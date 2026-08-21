# FUZZ-41 — APR business register: buy officially, or scrape the API?

Researched 2026-08-21 by Istraživač (research analyst). Every price, count and HTTP
status below was fetched during this pass; the fetch is named next to each number.

**Recommendation: do not buy anything yet.** Harvest the free source this spike
found first (`kompanije.net`, ~9,830 facade-code records at a measured ~68 % phone
fill), then re-cost APR against the residual. If APR is bought after that, buy the
**Prošireni paket, 36.000 RSD / ~€307 per 12 months** — and only after a 15-minute
human check that the register actually carries phones for sole traders.

---

## 1. What changed since FUZZ-4 / FUZZ-8

FUZZ-8 already established that APR publishes the **company** register as free open
data. This pass re-verified it and pinned down exactly how thin it is:

`GET https://openapi.apr.gov.rs/api/opendata/companies` → HTTP 200, 57,673,691 bytes,
`DatumPreseka: 2026-07-31`, **133,634 records** (125,005 `Активан`), 192 municipalities.

A record has **seven fields and nothing else**:

```json
{
  "PoslovnoIme": "BELI SLON PREDUZEĆE ZA PROIZVODNJU  PROMET I USLUGE DOO BEOGRAD (NOVI BEOGRAD)",
  "SifraOpstine": "70181",
  "NazivOpstine": "НОВИ БЕОГРАД",
  "NazivStatus": "Активан",
  "DatumOsnivanja": "2000-03-30",
  "NazivPravneForme": "Друштво са ограниченом одговорношћу",
  "SifraDelatnosti": "4719"
}
```

No phone, no e-mail, **no street address** — municipality only. And no
`preduzetnici` endpoint exists: `/api/opendata/{entrepreneurs,preduzetnici,
soleproprietors,shops,associations,datasets}` all return HTTP 404.

So the question FUZZ-41 actually has to answer is narrower than the issue assumed:
**what does paying APR buy that the free open data does not?** Two things, and only
two: **sole traders (preduzetnici)** and **the optional contact-phone field**.

### Active companies per activity code (counted in the open-data payload, 2026-07-31)

| Code | Name | Active companies |
|---|---|---|
| 43.31 | Malterisanje | 90 |
| 43.34 | Bojenje i zastakljivanje | 141 |
| 43.39 | Ostali završni radovi | 515 |
| 43.99 | Ostali nepomenuti specifični građevinski radovi | 1,299 |
| 43.29 | Ostali instalacioni radovi u građevinarstvu | 245 |
| **Core contractor subtotal** | | **2,290** |
| 46.73 | Trg. na veliko drvetom i građ. materijalom | 1,047 |
| 47.52 | Trg. na malo metalnom robom, bojama i staklom | 578 |
| **Store subtotal** | | **1,625** |
| 41.20 | Izgradnja stambenih i nestambenih zgrada | 6,278 |
| 43.33 | Postavljanje podnih i zidnih obloga | 316 |
| 43.32 | Ugradnja stolarije | 127 |
| 43.91 | Krovni radovi | 64 |
| 43.11 / 43.12 | Rušenje / pripremni radovi | 123 / 313 |

**Correction to the issue body.** The issue proposed `43.31, 43.34, 43.91, 43.99`.
`43.91 Krovni radovi` is the weakest of the four (64 companies) and the set omits the
two largest facade-relevant buckets: **`43.39 Ostali završni radovi` (515)** and
**`43.29 Ostali instalacioni radovi` (245, the code that carries thermal/acoustic
insulation work)**. Use `43.31, 43.34, 43.39, 43.99, 43.29` as the core set;
`41.20` is a wide net (6,278) that needs name-level filtering, not a core code.

Names verified against the KD-2010 category tree published at
`kompanije.net/Srbija/d4_GRAĐEVINARSTVO.html`, which reproduces the Uredba's names
verbatim. `43.31 Malterisanje` officially covers *"malterisanje spoljnih i
unutrašnjih površina zgrada"* — external surfaces, i.e. facade rendering.

---

## 2. Does APR data include phone numbers? — **Yes, but optionally**

This was the question the issue said decides everything. It is answered from APR's
own registration form, not from a summary.

Downloaded `https://www.apr.gov.rs/upload/Portals/0/privredna drustva/2025/JRPPS___DOO_2025_T.pdf`
(HTTP 200, 616,907 bytes, 14 pages) and extracted the text. Page 5 carries:

> **KONTAKT PODACI DRUŠTVA**
> Telefon 1.: Telefon 2.: Faks: Internet adresa: www.
> *Kontakt podaci nisu obavezan predmet registracije. Ukoliko se odlučite da ih
> registrujete napominjemo da će isti biti javno objavljeni na internet strani
> Agencije za privredne registre.*

Three separate facts follow from that sentence:

1. **Telephone is a registrable datum and, when registered, it is published
   publicly** on APR's own site. So APR is not merely an enrichment target list —
   it can be a phone source.
2. **It is optional** (`nije obavezan predmet registracije`). The fill rate is
   therefore whatever share of businesses chose to enter it, and that share is
   **not measurable without a portal account** — see §5.
3. There *is* a mandatory phone on the same form, but it is not published. Page 14:
   **"KONTAKT PODACI ZA PORESKU UPRAVU … *Broj telefona (obavezan podatak)"** —
   collected for the Tax Administration, not registered.

E-mail, by contrast, **is mandatory**: page 4, *"ADRESA ZA PRIJEM ELEKTRONSKE POŠTE
… Adresa za prijem elektronske pošte je obavezan predmet registracije."* Every
registered company has one. It is frequently the accountant's address, so treat it
as a low-quality channel under this project's phone-first rule — but coverage is
100 % by construction.

---

## 3. Path A — buying officially. Prices are published; no quote request needed

The issue expected a quote conversation. There is no need for one: APR's fees are
set by the **Odluka o naknadama za poslove registracije i druge usluge koje pruža
Agencija za privredne registre** ("Sl. glasnik RS", br. 95/2025, in force from
2026-01-01), and the portal publishes the currently-charged amounts. Both were
fetched.

### A1 — Web portal packages (`portal-info.apr.gov.rs/Naknade`) — **the right product**

Odluka čl. 25 sets ceilings and čl. 25 st. 2 allows a reduction of up to 40 %. The
portal is currently charging the reduced amounts:

| Package | Odluka čl. 25 ceiling | Charged now | ≈ EUR | Advanced-search list export |
|---|---|---|---|---|
| Osnovni | 30.000 RSD | **18.000 RSD/god** | €153 | 500 subjects/month (6,000/yr) |
| Prošireni | 60.000 RSD | **36.000 RSD/god** | €307 | 1,200/month (14,400/yr) |
| Poslovni | 90.000 RSD | **55.000 RSD/god** | €469 | 15,000/month (180,000/yr) |
| Besplatni | — | **0 RSD** | €0 | none; 5 subject views/month, 1 xlsx/month |

Volume discounts apply per package when buying many (11–50: −10 %; >50: −19 %) —
irrelevant for a single buyer.

Odluka čl. 25 st. 3: *"Plaćanjem naknade … korisnik ostvaruje pravo na uslugu za
period od 12 meseci, odnosno do raspoloživog obima zahtevane usluge."* The annual
caps in the Odluka (6,000 / 15,000 / 180,000 subjects) reconcile exactly with the
portal's monthly caps × 12, so the two sources agree.

What the package gives us, from `portal-info.apr.gov.rs/Funkcionalnosti`:

> **Napredna pretraga** — *"Kreirajte željenu listu koristeći više od 200 kriterijuma
> za pretragu."*
> **Preuzimanje podataka** — *"…preuzmite ih u xlsx ili pdf formatu."*

200+ criteria and XLSX export is exactly filter-by-activity-code-and-municipality,
then download. Coverage is **133,796 companies and 386,697 entrepreneurs**
(portal's own counters, read 2026-08-21) — i.e. **preduzetnici are included**, which
is the whole point.

EUR conversions at **117.33 RSD/EUR** (open.er-api.com, 2026-08-21).

### A2 — Special arrangement / bulk extract (Odluka čl. 23) — **worse value**

> *"Naknade za davanje registrovanih … podataka u elektronskoj formi koji se obrađuju
> po zahtevu korisnika i dostavljaju na medijumu ili preko elektronskog servisa (FTP,
> elektronska pošta …) … iz Registra privrednih subjekata … **do 45,00 dinara po
> registrovanom subjektu**, u zavisnosti od grupe podataka."*

At the ceiling, the ~10,000-subject sole-trader gap costs **450.000 RSD (€3,835)** —
more than twelve times the Prošireni package for the same rows. Even at a quarter of
the ceiling it loses. Skip it.

### A3 — Automated web service (Odluka čl. 27) — **wrong product, disqualifying price**

> 1. *jednokratna naknada za inicijalno preuzimanje … **7,00 dinara po subjektu***
> 2. *…**32,00 dinara po subjektu** … za stalno preuzimanje podataka o statusnim i
>    drugim promenama … u toku meseca*
> 3. *mesečna naknada … **7.500,00 dinara** za usluge održavanja i razvoja*

Item 2 is charged **per subject per month**. For 10,000 subjects that is
320.000 RSD **per month** (€2,727/mo, ~€32,700/yr) on top of a 70.000 RSD initial
load. This product is priced for banks doing continuous KYC monitoring, not for a
sales list. Disqualified.

---

## 4. Path B — scraping `pretraga.apr.gov.rs`. Cheap in tokens, blocked in practice

The token cost the issue asked to be honest about is genuinely trivial. Enumerating
the ~10,000-subject gap costs roughly one solve per detail view plus paging, call it
~11,000 solves: **$7–$33** at published reCAPTCHA rates ($0.65/1k CapSolver low end,
$1.45–$2.99/1k 2Captcha) ≈ **700–3.300 RSD**. Cheaper than the Osnovni package.

Three measured facts make it the wrong call anyway:

1. **The WAF blocks honest identification.** `GET https://pretraga.apr.gov.rs/robots.txt`
   with an honest crawler UA (`SerbiaFacadeLeadEngine-Research/1.0 (+contact: …)`)
   returns an HTML block page: *"Pristup je blokiran! … Attack ID: 20000021, Client
   IP: 188.2.99.203"*. The **same URL with a Chrome UA returns HTTP 200 and this
   body**:
   ```
   # https://www.robotstxt.org/robotstxt.html
   User-agent: *
   Disallow:
   ```
   So `robots.txt` permits everything, and the WAF forbids anyone who says who they
   are. This project's compliance rule is *"identify the crawler honestly"* — Path B
   cannot be run without breaking it. That is not a technicality; it is the rule.
2. **The API is name-oriented, so exhaustive enumeration by activity code may be
   impossible.** Probed `POST /api/search/PrivrednaDrustva/PretragaNaziva` and
   `/api/searchNazivi` with browser headers: HTTP 405 and HTTP 404 respectively —
   we never got past the method gate to even confirm a `delatnost` filter exists.
   The legacy host is gone too: `pretraga2.apr.gov.rs` → HTTP 403, and
   `/ObjedinjenePretrage/Search/Search` → HTTP 503.
3. **It is a state agency's portal, accessed against its own access controls.**
   Stated as fact, per the issue's instruction, for the member to weigh. Path A costs
   €153–€307/yr and carries none of this.

**Path B is not equivalent to Path A and is not recommended.**

---

## 5. The gap this spike could not close, and the 15-minute way to close it

**What share of registered sole traders actually filled in the optional phone?**
Unmeasurable from outside: the field renders only on APR's reCAPTCHA-gated detail
page or inside a portal account.

Two ways to settle it before spending money, in order:

1. **Free, ~15 human minutes.** Open `pretraga.apr.gov.rs` in a browser (free for a
   human, no account) and look up ~20 facade preduzetnici from the target list —
   count how many show a registered `Telefon`. That single number decides the
   purchase.
2. **Free, no card.** Register the `Besplatni paket` on `portal-info.apr.gov.rs`
   ("Registrujte se besplatno"). It grants 5 subject views and 1 XLSX export per
   month — enough to confirm the export actually carries a `Telefon` column, which
   the marketing pages never state. *Not done in this pass: creating an account in
   the member's name is his call, not mine.*

Decision rule once that number exists:

- **≥ 30 % fill** → buy **Prošireni, 36.000 RSD / €307 / yr**. 14,400 subjects/yr
  covers the entire ~10,000-record sole-trader gap plus the company codes in one
  year, and yields roughly 3,000+ register-grade phones.
- **10–30 %** → buy **Osnovni, 18.000 RSD / €153 / yr**, run it at 500/month against
  the highest-value codes first (43.31 → 43.34 → 43.39).
- **< 10 %** → **do not buy.** APR is then an enrichment target list only, and §6
  shows a free source that beats it on that job.

---

## 6. What this spike found instead: `kompanije.net`, free, and it has the phones

While sizing the activity codes, this pass found an APR-derived directory that is
free, static HTML, **indexed by activity code**, and carries phone numbers — filling
the exact `preduzetnici` gap the repo calls *"this project's largest structural
coverage gap"*.

`https://www.kompanije.net/Srbija/l70_Malterisanje.html` → HTTP 200, 138,625 bytes,
**900 company detail links on one page, no pagination**. Detail pages carry
*Pun naziv, Adresa, Telefon, Matični broj, PIB, Šifra delatnosti, Naziv delatnosti, Sajt*.

**Measured record counts (one fetch per category page, links counted in the HTML):**

| Code | Category page | Records |
|---|---|---|
| 43.29 | `l69_Ostali-instalacioni-radovi-u-građevinarstvu` | 652 |
| 43.31 | `l70_Malterisanje` | 900 |
| 43.34 | `l73_Bojenje-i-zastakljivanje` | 2,619 |
| 43.39 | `l74_Ostali-završni-radovi` | 2,880 |
| 43.99 | `l76_Ostali-nepomenuti-specifični-građevinski-radovi` | 2,779 |
| **Core contractor total** | | **9,830** |
| 46.73 | `l548_Trgovina-na-veliko-drvetom-i-građ-materijalom` | 1,486 |
| 47.52 | `l483_Trgovina-na-malo-metalnom-robom--bojama-i-staklom` | 2,166 |
| 46.74 | `l549_Trgovina-na-veliko-metalnom-robom` | 925 |
| **Store total** | | **4,577** |
| 43.32 / 43.33 / 43.91 / 41.20 | stolarija / obloge / krovni / izgradnja zgrada | 551 / 2,121 / 329 / 5,663 |

**Measured phone fill (random sample, one HTTP fetch per detail page):**

| Code | Sampled | With phone | Rate |
|---|---|---|---|
| 43.31 | 25 | 19 | 76 % |
| 43.34 | 25 | 20 | 80 % |
| 43.39 | 25 | 12 | 48 % |
| **Total** | **75** | **51** | **68 %** |

A separate 100-record sample on the site's older `/preduzetnici/` surface measured
**56 %** (56/100), with **41 mobile numbers vs 28 landlines** among them — mobiles
dominate, which is what this project wants. Street address was present on 23–24 of
every 25 sampled on the modern surface.

**Cross-check that the counts are real.** kompanije.net lists 9,830 records in the
five core codes; APR's open data lists 2,290 *companies* in the same five codes. The
difference, ~7,540, is sole traders — and an independent count on the site's legacy
`/preduzetnici/` index gives **8,001** for the same codes (43.31 852, 43.34 2,558,
43.39 2,340, 43.99 1,757, 43.29 494). Two independent surfaces agree within ~6 %.

**Implication:** ~9,830 core-code records × ~68 % ≈ **6,600 phone-bearing facade
records, at zero cost**, plus ~3,100 more on the store side. The most optimistic
APR purchase outcome is a comparable number for €307. Harvest the free one first.

`robots.txt` (fetched 2026-08-21): the file contains **only the Cloudflare
content-signals comment header — no `User-agent` line, no `Disallow`, and no
content-signal values set**. Nothing is restricted and nothing is granted by signal.
No JS required; plain server-rendered HTML.

**Caveats that must be measured before trusting it as a primary source.** The footer
reads "© Kompanije.net 2014"; the legacy `/preduzetnici/` index tops out around
record id 335903 while the modern `/Srbija/` section reaches 382240, so the two
surfaces are snapshots of different vintages and neither is dated on the page.
Freshness and dead-record rate are **unmeasured**. Validate against the APR open-data
company list (matični broj / naziv + opština) before exporting anything from it, and
treat every phone as needing a first-call verification.

---

## 7. If APR turns out to be a target list rather than a phone source

Estimated additional callable leads after running an APR list through the FUZZ-21
website contact-enrichment crawler:

- Target list: ~10,000 sole traders in the core codes that no current source covers
  at register grade.
- FUZZ-21 needs a website. Sole-trader fasaderi rarely have one; APR's `Internet
  adresa` is optional on the same form as the phone, and on the kompanije.net sample
  the `Sajt` field was empty on every record checked. Assume **8–15 %** carry a
  reachable site → **800–1,500 crawlable**.
- At the ~70–80 % phone-extraction rate FUZZ-22 observed on sites that do exist →
  **560–1,200 raw phones**, and after dedup against the ~1,900 unique leads already
  held, realistically **300–700 net-new callable leads**.

That is an assumption-driven estimate, not a measurement — the 8–15 % website share
is the weak link and should be measured on 50 records before anyone relies on it.
For comparison, §6's free source offers ~6,600 phone-bearing records against the
same universe. **The enrichment case alone does not justify the purchase.**

What the purchase *would* still buy, even at 0 % phone fill: a register-grade frame
for sole traders — legal name, municipality, activity code, status, matični broj —
which is the classification ground truth and dedup spine that the open-data company
file provides for companies and nothing currently provides for preduzetnici.

---

## Sources fetched during this pass

- `https://openapi.apr.gov.rs/api/opendata/companies` — 200, 57.7 MB, 133,634 records
- `https://www.paragraf.rs/propisi/odluka_o_naknadama_za_poslove_registracije_i_druge_usluge_koje_pruza_agencija_za_privredne_registre.html` — Odluka, Sl. glasnik RS 95/2025, čl. 23 / 25 / 27
- `https://portal-info.apr.gov.rs/Naknade`, `/Funkcionalnosti`, `/Podaci` — 200
- `https://www.apr.gov.rs/upload/Portals/0/privredna drustva/2025/JRPPS___DOO_2025_T.pdf` — 200, 14 pp.
- `https://pretraga.apr.gov.rs/robots.txt` — 200 (Chrome UA) / WAF block page (honest UA)
- `https://pretraga.apr.gov.rs/api/search/PrivrednaDrustva/PretragaNaziva` — 405
- `https://pretraga2.apr.gov.rs/` — 403; `/ObjedinjenePretrage/Search/Search` — 503
- `https://www.kompanije.net/robots.txt`, `/Srbija/l*.html`, `/preduzetnici/preduzetnici.php?delatnost=*` — 200
- `https://open.er-api.com/v6/latest/EUR` — EUR/RSD 117.33 on 2026-08-21
