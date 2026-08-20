# `data/` — datasets and the database file

Two different kinds of thing share this directory, and they are treated
differently by git.

## Committed — reference datasets

- Geo data: Serbian cities and `opštine`, with both spellings (`Čačak` /
  `Cacak`), used to drive location-scoped queries and to normalize the `city`
  and `municipality` fields.
- Settlement aliases (`serbia-settlements.json`): the villages, suburbs and city
  districts directories print instead of the municipality — `Kaluđerica`,
  `Petrovaradin`, `Zlatibor` — each pointing at a municipality id in the geo
  dataset. A curated seed list, not the full settlement register: a name it does
  not know resolves to nothing rather than to a guess.
- Query datasets: the contractor and store search terms, each in its diacritic
  and ASCII-folded form.

These are inputs to a run, they are reviewed like code, and they are versioned.
JSON or CSV, UTF-8, English keys and Serbian values.

## Gitignored — the database

`data/*.sqlite` is the system of record for a local checkout, and it is **not**
committed. It is rebuilt by running the scraper. Schema changes go through a
Drizzle migration in `src/lib/db`, never by hand-editing this file.

The XLSX export is a generated artifact too — nothing may live only in a
spreadsheet.
