# `app/` — Next.js review UI (App Router)

The human surface over the database: browse leads, inspect where each field came
from, correct a classification, and trigger the XLSX export.

## What belongs here

- Route segments, layouts and React components for the review UI.
- `app/api/**/route.ts` — the API routes the UI calls.
- UI-only state and formatting (how a phone is displayed, how a table is sorted).

## What does not belong here

Domain logic. Normalization, dedup, classification, scoring and the export
writer live in `src/lib` and are imported. A rule that the UI needs and the
scraper also needs must not be written twice — it goes to `src/lib`.

## Rules

- Database access is server-side only. `better-sqlite3` is a native module and
  is listed in `serverExternalPackages`; it must never end up in a client
  component's import graph.
- Reads go through the repository functions in `src/lib/db`, not raw SQL in a
  route handler.
- The UI writes through the same merge rules the scraper uses. A human decision
  is recorded as provenance, not as a silent overwrite.
- Serbian for the labels a salesperson reads (`Naziv`, `Telefon`, `Grad`,
  `Opština`); English for code and comments.
