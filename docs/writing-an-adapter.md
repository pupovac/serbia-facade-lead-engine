# Writing an adapter

A source is one directory. Nothing outside it needs editing — not a registry
file, not a switch statement, not a shared parser. If a source you are adding
would need a change to shared code, the contract is wrong and that is worth
saying in the PR rather than working around.

This walks through building one end to end. The working example it describes is
`src/scraper/sources/example/`; copy that directory to start.

## What you are writing

```
src/scraper/sources/<source-id>/
  index.ts          the adapter — declares the source, discovers items, extracts records
  parse.ts          HTML/JSON → RawLead, a pure function of the response body
  parse.test.ts     fixture-driven tests
  __fixtures__/     saved response snapshots the parser tests run against
  README.md         what this source is, its robots.txt terms, its rate limit
```

The id is the registry slug from `research/sources-contractors.json` /
`research/sources-stores.json` — `portal-srbija`, `gradjevinarstvo-rs`. That
makes a `source_id` on any lead, phone or raw record greppable back to the
research that chose it, and it is what `sources.id` already holds.

## Before you write anything

1. **Read the registry entry.** `research/sources-*.json` records the pagination
   shape, whether the page needs JS, the verbatim `robots.txt` rule as of the
   research pass, and real sample URLs. Build against that entry.
2. **Re-check `robots.txt` yourself** and quote it in your `README.md`. It may
   have changed. A `Disallow` is the end of the conversation — never work around
   one, never scrape behind a login, never touch a CAPTCHA.
3. **Set a rate limit that is polite for that host.** Most of these are small
   Serbian sites. The default is one request per 1.5s per host; slower is always
   allowed, faster is not (see _Politeness_ below).
4. **Decide whether you truly need Playwright.** `cheerio` unless the content
   genuinely requires JS rendering, and justify the exception in the PR.

## The two phases

```ts
discover(ctx): AsyncIterable<DiscoveredItem>          // listing pages → item refs
extract(item, ctx): Promise<RawLeadInput[]>           // one item → raw records
```

They are separate because listing pages and detail pages fail at different
times and in different ways. Discovery can resume from a cursor without
re-extracting anything, and a run that dies halfway costs the cheaper half
twice rather than the whole crawl.

### `discover`

An async generator, so items are yielded as each listing page is parsed — a
source with 11,000 records never holds 11,000 items in memory.

```ts
async function* discover(ctx: CrawlContext): AsyncIterable<DiscoveredItem> {
  const resume = ctx.state.resume(SCOPE_KEY, ctx.scope, ctx.now());
  if (resume.skip) return; // crawled recently; nothing to find
  let pageUrl: string | null = resume.cursor ?? FIRST_PAGE;

  while (pageUrl !== null) {
    const { $, finalUrl } = await ctx.http.html(pageUrl);
    const listing = parseListing($, finalUrl, ctx.expect);

    for (const item of listing.items) {
      yield { url: item.url, scopeKey: SCOPE_KEY, hints: { ...item } };
    }

    pageUrl = listing.nextUrl;
    ctx.state.saveScope(SCOPE_KEY, {
      cursor: pageUrl,
      status: pageUrl === null ? 'done' : 'in_progress',
      at: ctx.now(),
    });
  }
}
```

Three things to copy:

- **Save the cursor after every page**, not at the end. A crawl that dies on
  page 40 should resume on page 40.
- **The cursor is yours.** A page number, a next-page URL, an API offset —
  nothing outside your adapter interprets it.
- **Call `ctx.state.resume`, never `getScope().cursor`.** A saved cursor resumes
  an _interrupted_ crawl; it says nothing useful about a finished one, because
  the point of re-walking a listing is the entries that were not on it last
  time — and those are on page one. `resume` returns `skip` for a listing
  crawled recently and a `null` cursor for one due a fresh walk. An adapter that
  treats a completed scope as "nothing left" reports zero items discovered,
  calls the run successful, and silently stops finding new businesses the moment
  its first crawl finishes.
- **A scope is whatever you paginate over.** One category here; a real source
  usually has one scope per (city × search term), keyed like
  `city:novi-sad|term:fasader`. `ctx.scope.municipalities` and
  `ctx.scope.queries` are what `--city` and `--query` resolved to; `src/lib/queries`
  generates the Serbian terms in both diacritic and ASCII-folded form.

### `extract`

```ts
async function extract(item: DiscoveredItem, ctx: CrawlContext) {
  const { $, finalUrl } = await ctx.http.html(item.url);
  return [parseDetail($, finalUrl, ctx.expect, item.hints)];
}
```

Usually one record; a listing block that holds several businesses returns
several. A source that publishes everything on the listing page can skip the
fetch entirely and build records straight from `item.hints`.

## What an adapter emits

A `RawLead`: **raw strings, exactly as published.**

```ts
{
  sourceUrl: 'https://primer.rs/firme/termo-fasade',  // the exact page, never the homepage
  name: 'Termo Fasade Novi Sad d.o.o.',
  phones: ['021/456-789', '064 123 4567'],            // not canonicalized
  city: 'Beograd — Voždovac',                          // not resolved
  website: 'http://www.termofasade.rs',                // not cleaned
  categories: ['Fasaderski radovi', 'termoizolacija'],
  text: article.text(),                                // the record block's visible text
  links: [...],                                        // the record block's anchors
}
```

An adapter **never** canonicalizes a phone, folds diacritics, resolves a city,
picks a website out of a link farm, deduplicates, classifies, scores or writes
to the database. Every one of those is `src/lib`, called by
`src/scraper/pipeline.ts`. An adapter that pre-cleans a value is
re-implementing a rule that already exists and will disagree with it.

`text` and `links` are worth filling in even when you have modelled the fields.
They are what lets the shared extractors find the `ime [at] firma [dot] rs`
nobody anticipated and the Facebook page nobody modelled. Scope them to the
record block, not the page: the directory's own footer phone number is not this
company's phone number.

If a source needs a normalization rule that does not exist yet, it goes in
`src/lib` with its own tests — that is a change to the Data Engineer's code, so
raise it rather than inlining it.

## Failing loudly: `ctx.expect`

**A selector that matches nothing must raise, not silently yield zero leads.**
A directory that redesigns its markup does not start returning errors; it starts
returning healthy 200s our selectors no longer match. Without this, a source
reports a successful run with zero leads for a month.

```ts
const cards = $('ul.lista-firmi li.firma-kartica').toArray();
ctx.expect(cards, 'ul.lista-firmi li.firma-kartica', pageUrl, 'one or more company cards');
```

`expect` raises `StructureChangedError` on `null`, `undefined`, `''` or `[]`,
carrying the source id, the URL and the selector.

Use it for **what the source guarantees**: the listing container, the name on a
detail page, the pagination block if every page has one. Do _not_ use it for
what a listing may legitimately lack — a phone, an email, an address. Getting
that line right is what makes the error mean something.

Save the post-redesign page as a fixture and assert on it, the way
`__fixtures__/listing-redesigned.html` does. When a real source changes, re-save
the fixture and fix the selector; never "fix" it by loosening the assertion.

## Politeness is the framework's job, not yours

Everything reaches the network through `ctx.http`, and it enforces:

- **`robots.txt`**, fetched once per origin per run and obeyed. A disallowed
  path throws before the request leaves. There is no override parameter.
  Unreadable (a 5xx, a timeout) is _not_ permission — the crawl refuses. A 404
  is, and means allow-all.
- **A per-host rate limit**, serialized rather than merely spaced, so
  concurrency cannot turn one request per second into eight at once. A
  `Crawl-delay` in `robots.txt` is honoured when it asks for more room.
- **An honest `User-Agent`** naming the crawler and a contact, on every request.
- **Exponential backoff with jitter** on 429 and 5xx, honouring `Retry-After`,
  with a retry cap. A 404 or a 403 is never retried.
- **A hard per-run request budget**, so a pagination bug stops at the fuse
  rather than on a small site's error budget.

An adapter may make its crawl **gentler** than the environment asks for and
never harsher:

```ts
config: { requestDelayMs: 4000, requestBudget: 500 }
```

`requestDelayMs` takes the larger of the two, `requestBudget` the smaller, and
`respectRobots: false` from an adapter is ignored outright — turning robots off
is a written-permission decision, recorded in the source's README, not an
adapter's.

Declare what the directory publishes about **itself** on every listing, so it
does not end up on every lead:

```ts
sourceOwnedEmails: ['kontakt@primer-oglasi.rs'],
sourceOwnedProfiles: ['https://www.facebook.com/primeroglasi'],
```

## Incremental runs

Two windows, on purpose, because they cost very different amounts:

| Window              | Default | Flag                 | What it governs                         |
| ------------------- | ------- | -------------------- | --------------------------------------- |
| `stalenessMs`       | 14 days | `--stale-days`       | re-scraping one **detail page**         |
| `rediscoverAfterMs` | 24 h    | `--rediscover-after` | re-walking a finished **listing scope** |

Re-walking a listing is a handful of requests and is the only way a newly listed
business is ever found, so it happens often. Re-scraping a detail page is one
request per record and the data barely moves, so it happens rarely. `--since`
overrides both with an absolute floor — what you reach for after a parser fix.

Together they are what turn the second crawl of an 11,000-record directory into
a few hundred requests.

Item staleness is keyed by `resumeKey(item)`, which defaults to the item URL. Override it
when the source decorates URLs with session or tracking parameters — otherwise
every page looks new on every run:

```ts
resumeKey: (item) => new URL(item.url).pathname,
```

## Testing

An adapter ships with a **fixture test**: a saved HTML snapshot in
`__fixtures__/` parsed to an expected record set, so parsing is verifiable
without hitting the network. Tests never reach the internet — that is a CI
constraint, not a preference.

```ts
const record = parseDetail(fixture('detalj-termo-fasade.html'), url, assert);
expect(record.phones).toEqual(['021/456-789', '064 123 4567']); // raw, not canonical
```

Assert on the raw strings. A test that expects `+38121456789` is testing
`src/lib/phone`, which has its own tests, and will start failing for reasons
that have nothing to do with your source.

Add `__fixtures__/*.html` to `.prettierignore` if you save real pages —
reformatting a snapshot changes what the test is testing, malformed markup
included.

## Running it

```bash
npm run scrape -- --list-sources
npm run scrape -- --source <id> --limit 20 --dry-run   # writes nothing
npm run scrape -- --source <id> --city novi-sad --limit 50
```

`--dry-run` performs discovery and extraction in full and never opens the
database. It is the right first run against a new source.

## Before the PR

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`,
  `npm run build`.
- The PR title starts with the issue key, and says why if you introduced a
  runtime dependency or reached for Playwright.
- The issue comment reports **real numbers from a real sample run**: how many
  records the adapter extracted, and how many carried a phone number.
