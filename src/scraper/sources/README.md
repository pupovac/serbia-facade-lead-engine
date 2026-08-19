# `src/scraper/sources` — source adapters

One directory per source. An adapter's whole job is: given a query and a page of
that source, produce raw records and let the shared code decide what they mean.

```
sources/
  <source-id>/
    index.ts      the adapter — implements the SourceAdapter interface
    parse.ts      HTML/JSON → raw records (pure, testable without the network)
    parse.test.ts fixture-driven tests
    fixtures/     saved response snapshots the parser tests run against
    README.md     what this source is, its robots.txt terms, its rate limit
```

## The adapter boundary

- An adapter returns **raw records**, validated with the zod schema from
  `src/lib` at the boundary. Anything that fails validation is reported, not
  silently dropped.
- An adapter **does not** canonicalize phones, fold diacritics, deduplicate,
  classify or score. It calls the helpers in `src/lib` or returns the raw value
  and lets the pipeline do it.
- An adapter **always** records where a value came from: source id and the exact
  source URL, for every record.
- Parsing is a pure function of the response body, so it is tested against saved
  fixtures rather than against the live site.

## Before adding a source

Check its `robots.txt` and terms, set a rate limit that is polite for that host,
and note both in the source's own README. Free sources first.
