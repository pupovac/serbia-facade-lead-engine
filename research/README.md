# `research/` — committed research artifacts

Findings that later work depends on, kept in the repository so an agent inherits
them from the code rather than from an issue thread that scrolled away.

## What belongs here

- Source surveys: what a directory/portal publishes, how it paginates, roughly
  how many relevant businesses it holds, its `robots.txt` terms.
- Measured yield numbers per source — the input to any "is a paid API worth it"
  decision.
- Query-term experiments: which Serbian terms actually return facade contractors
  and which return noise.
- Sample pages or response snapshots that document a format decision. Large
  fixtures used by tests belong next to the adapter, not here.

## Rules

- Markdown, English, dated, and signed with the issue key that produced it.
- Numbers, not adjectives. "412 listings across 21 pages" beats "a lot of data".
- Nothing here is loaded at runtime. It is documentation for humans and agents.
