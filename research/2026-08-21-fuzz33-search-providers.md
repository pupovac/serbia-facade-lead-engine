# FUZZ-33 — is there a search provider we are allowed to use, and that answers?

FUZZ-21's `--path search` made **111 attempts and returned 0 candidates** in the
pilot. FUZZ-33 asks for a replacement if one can be found, and for the path to
be gated off if one cannot. This is the measurement behind the gate.

Every host below was probed on **2026-08-21** from the runtime that runs the
crawler, with the project's honest User-Agent
(`SerbiaFacadeLeadBot/0.1 (+https://github.com/pupovac/serbia-facade-lead-engine)`).
Two questions per host: does its `robots.txt` permit the result path, and does
the host answer at all.

## Result

| Provider                   | `robots.txt` verdict for its result path                           | Answers?                                                                       | Usable |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------ |
| `html.duckduckgo.com`      | `Allow: /` (unchanged)                                             | **no** — connection fails outright (curl exit 28 / HTTP 000)                   | no     |
| `lite.duckduckgo.com`      | `Allow: /` (unchanged)                                             | **no** — same                                                                  | no     |
| `stract.com`               | `Allow: /`, only `/api/` disallowed                                | **no** — `/search?q=…` is HTTP 404; the domain now serves an unrelated product | no     |
| `old-search.marginalia.nu` | `Disallow: /search`                                                | —                                                                              | no     |
| `www.mojeek.com`           | `Disallow: /search`                                                | —                                                                              | no     |
| `search.brave.com`         | `Disallow: /search`                                                | —                                                                              | no     |
| `www.ecosia.org`           | `Disallow: /search`                                                | —                                                                              | no     |
| `www.startpage.com`        | `Disallow: /do/`, `Disallow: /sp/`                                 | —                                                                              | no     |
| `yandex.com`               | `Disallow: /?` (its result path)                                   | —                                                                              | no     |
| `www.qwant.com`            | `Disallow: /?*q=*`                                                 | —                                                                              | no     |
| `searx.be`                 | `noindex, nofollow` + an anti-bot challenge on `robots.txt` itself | **no**                                                                         | no     |

**Stract was the one real candidate** — the only general search engine found
whose `robots.txt` permits its result path. It no longer runs a search engine:
`stract.com` now serves a product site (`/relationships`, `/signup`,
`/product/…` in its sitemap) and `/search?q=…` is a 404.

DuckDuckGo's two HTML endpoints, the ones FUZZ-21 was built against, have gone
from "answers, then challenges" in FUZZ-21's measurement to **not answering at
all** from this runtime.

So: **no permitted, responsive general search provider exists today.** Nothing
in the compliance rules can be relaxed to change that — `Disallow: /search` is
not a risk to weigh, it is a no, and the anti-bot challenges must not be solved.

## What was done

`--path search` is **off by default**; `DEFAULT_ENRICHMENT_PATH` is `own-site`.
Asking for `--path search` or `--path both` still runs it, and logs why it is
off first, so the next person to re-measure gets a pointer rather than a
surprise. Passing a `finder` to `runEnrichment` suppresses the warning: the
`CandidateFinder` interface is one method, so a permitted provider drops in
without touching the confidence rules.

`--path own-site` is unaffected and stays the default. It converted **447 of
600 requests** in the pilot; the gated path converted 0 of 111.

## What to try instead, when this is picked up again

Not another general search engine — the list above is close to exhaustive for
robots-permitted ones. The higher-yield direction is **a Serbian directory's own
search**, which is a permitted, on-topic index of exactly the businesses this
project wants:

- `portal-srbija.com` and `gradjevinarstvo.rs` are already crawled as sources
  and both expose a site search;
- a hit there is a directory listing rather than the business's own page, which
  is _lower_ confidence for ownership but _higher_ yield for a phone number —
  and the confidence gate in `src/scraper/enrich/confidence.ts` already handles
  exactly that distinction.

That is a new finder implementation plus a robots check per host, not a change
to the enrichment engine. It was out of scope for FUZZ-33, whose stated minimum
bar was the gate.

Do **not** build on ScrapeGraph: no credits are provisioned.
