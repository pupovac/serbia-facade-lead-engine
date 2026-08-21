# `app/` — Next.js review UI (App Router)

The human surface over the database: browse leads, inspect where each field came
from, correct a value, decide a merge, and trigger the XLSX export.

## The five views

| Route          | File                   | What it shows                                                |
| -------------- | ---------------------- | ------------------------------------------------------------ |
| `/`            | `page.tsx`             | Coverage, phone reach, per-source yield, growth, gaps        |
| `/leads`       | `leads/page.tsx`       | The list — search, filter, sort, paginate, all in SQL        |
| `/leads/<id>`  | `leads/[id]/page.tsx`  | One business: every claim, its provenance, its evidence      |
| `/merges`      | `merges/page.tsx`      | The `review`-band pairs, side by side, with merge and reject |
| `/suggestions` | `suggestions/page.tsx` | Medium-confidence enrichment findings awaiting a decision    |

Every page is a server component. The only client component in the tree is
`components/nav-link.tsx`, which needs `usePathname` to mark the current tab.
Writes go through `actions.ts` — server actions that read the form and call one
function in `src/lib/review/decisions.ts`.

## What belongs here

- Route segments, layouts and components for the review UI.
- `app/api/**/route.ts` — API routes, if the client ever genuinely needs one. It
  does not today: forms post to server actions and the list state lives in the
  URL.
- UI-only state and formatting (`app/lib/format.ts`): how a phone is displayed,
  what a Serbian label reads, how a date is rendered.

## What does not belong here

Domain logic, and any query at all. Normalization, dedup, classification,
scoring and the export writer live in `src/lib` and are imported. The read
models the UI needs — the filtered list, the dashboard aggregates, the queues —
live in `src/lib/review`, not in a page: there is no Drizzle query and no SQL
anywhere under `app/`, so the same reads are testable without a browser and
reusable by the export.

## Rules

- Database access is server-side only. `better-sqlite3` is a native module,
  listed in `serverExternalPackages`, and must never enter a client component's
  import graph.
- Reads go through `src/lib/review`; writes go through
  `src/lib/review/decisions.ts`. A server action that reimplemented a merge rule
  would be a second place for it to drift.
- A human decision is recorded as provenance, never as a silent overwrite. The
  UI writes as the `manual-review` source, and the value it replaced keeps its
  own.
- Filtering, sorting and pagination are server-side. A client-side slice of a
  truncated fetch is a defect: the dataset is tens of thousands of rows.
- Serbian for the labels a salesperson reads (`Naziv`, `Telefon`, `Grad`,
  `Opština`); English for code and comments.

## Running it

`npm run dev` needs nothing but a database file at `data/leads.sqlite` — see the
README. `app/lib/db.ts` opens it once per server process, migrates it, and fails
with an actionable message rather than serving an empty page.
