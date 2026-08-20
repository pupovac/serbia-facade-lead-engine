# `example` — the reference adapter

Not a real source. A complete, working one whose "website" is a local fixture
server, so the full contract — paginated listings, detail pages, `robots.txt`,
resume state, the zod boundary, `StructureChangedError` — runs in CI with no
network access.

**Copy this directory to start a new source.** `docs/writing-an-adapter.md`
walks through what each part is doing.

## The fixture site

`__fixtures__/` is a small Serbian company directory:

| Path                       | Fixture                   | What it exercises                     |
| -------------------------- | ------------------------- | ------------------------------------- |
| `/robots.txt`              | `robots.txt`              | `Allow`/`Disallow` + `Crawl-delay: 1` |
| `/firme/fasaderi`          | `listing-1.html`          | listing page 1, next-page link        |
| `/firme/fasaderi?strana=2` | `listing-2.html`          | listing page 2, no next page          |
| `/firme/<slug>`            | `detalj-<slug>.html`      | six detail pages                      |
| —                          | `listing-redesigned.html` | the same listing after a redesign     |

The six businesses are deliberately varied: two-phone and no-phone listings, a
`mailto:` and an `ime [at] firma [dot] com` obfuscation, a `www.`-prefixed
`http://` website, a Belgrade city municipality, a PIB sitting next to the phone
numbers, and both buyer groups. Five of the six carry a phone.

`listing-redesigned.html` is a healthy 200 full of companies whose markup no
longer matches the selector — the silent failure `StructureChangedError` exists
to prevent. `parse.test.ts` asserts that parsing it raises.

## Running it

```bash
npm run scrape -- --source example --dry-run
```

With no `EXAMPLE_SOURCE_BASE_URL` set the adapter serves its own fixtures for
the length of the crawl. To point it at a server you control:

```bash
npx tsx src/scraper/sources/example/fixture-server.ts    # prints its URL
EXAMPLE_SOURCE_BASE_URL=http://127.0.0.1:PORT npm run scrape -- --source example
```

## Compliance

Nothing to declare: the fixture site is local and synthetic, the company names,
phone numbers and addresses in it are invented, and no real host is contacted.
A real source's README states its `robots.txt` terms verbatim, the rate limit
chosen for it and why, and any written permission relied on.
