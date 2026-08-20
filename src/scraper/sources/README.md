# `src/scraper/sources` — source adapters

One directory per source. An adapter's whole job is: given a source's listing
and detail pages, produce raw records and let the shared code decide what they
mean.

```
sources/
  <source-id>/
    index.ts      the adapter — implements the SourceAdapter interface
    parse.ts      HTML/JSON → raw records (pure, testable without the network)
    parse.test.ts fixture-driven tests
    __fixtures__/ saved response snapshots the parser tests run against
    README.md     what this source is, its robots.txt terms, its rate limit
```

**Registering an adapter means existing.** `loadAdapters()` picks up any
directory here whose `index.ts` default-exports a `SourceAdapter`; there is no
list to append to, and adding a source touches no shared code.

Start from `example/` — the reference adapter — and follow
`docs/writing-an-adapter.md`.

## The adapter boundary

- An adapter returns **raw records**, validated with the zod schema at the
  boundary. Anything that fails validation is reported and archived in
  `raw_records`, not silently dropped.
- An adapter **does not** canonicalize phones, fold diacritics, resolve cities,
  deduplicate, classify, score or write to the database. It returns the raw
  value and the pipeline does the rest.
- An adapter **always** records where a value came from: source id and the exact
  source URL, for every record.
- A selector that matches nothing **raises** `StructureChangedError` via
  `ctx.expect`. It never yields zero leads quietly.
- Parsing is a pure function of the response body, so it is tested against saved
  fixtures rather than against the live site.

## Before adding a source

Check its `robots.txt` and terms, set a rate limit that is polite for that host,
and note both in the source's own README. Free sources first.
