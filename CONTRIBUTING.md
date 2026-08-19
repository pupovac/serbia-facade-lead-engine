# Contributing

## Setup

```bash
npm install
cp .env.example .env.local
```

Node 20.9+ is required.

## Before you open a PR

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

All four must pass. CI runs the same four on every push and pull request.

## Definition of done

A code change is done when it:

- **typechecks** — `tsc --noEmit`, strict, no `any` and no `@ts-expect-error`
  without a comment saying why
- **lints** — `npm run lint` clean
- **has unit tests for pure logic** — normalization, dedup scoring,
  classification, lead scoring, validation. Test the messy real cases: Serbian
  phone formats, names with and without diacritics, businesses with two
  locations, near-duplicate company names.
- **opens a PR whose title carries the issue key** — e.g.
  `FUZZ-9: Bootstrap the TypeScript repository`
- **reports real numbers** in the issue comment when it changes data — leads by
  type, unique phones, leads with email/website, duplicates merged, cities
  covered. Numbers, never adjectives.

## Conventions

The architectural rules — layering, where normalization lives, the adapter
boundary, provenance, dedup and merge semantics, compliance — are in
[`docs/architecture.md`](docs/architecture.md). Read it before adding code; a PR
that violates it will be sent back regardless of whether it passes CI.

The short version:

- `src/lib` is pure shared domain code and depends on nothing above it.
- Adapters return validated raw records. They do not normalize, canonicalize,
  dedup, classify, score or write.
- Merge, never delete. Provenance is per field.
- Schema changes go through a Drizzle migration.
- No SQLite-only SQL where a portable form exists.
- No paid API without an explicit go-ahead in the issue.

## Code style

Prettier and ESLint are the arbiters — `npm run format` before committing.
Everything is ESM and TypeScript strict. Files are `kebab-case.ts`; a test sits
next to the code it tests as `<name>.test.ts`.

## Commits

English, imperative mood, and the issue key in the PR title. Conventional-commit
prefixes are welcome but not enforced.

## Directory ownership

Each top-level directory has a `README.md` stating what belongs in it. If your
change does not fit any of them, that is a signal the layering is about to be
broken — raise it in the issue rather than inventing a new home.
