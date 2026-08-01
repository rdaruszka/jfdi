# Add a category filter to penny list

Users with a few months of data can't see spending in one area without paging
through everything. `penny list` should take an optional `--category <name>`
flag that shows only matching entries.

## Acceptance criteria

- `penny list --category groceries` prints only entries whose category is
  `groceries`, in the same format and order as the unfiltered list.
- Matching is case-insensitive and exact (`--category Groceries` matches
  `groceries`; it does not match `grocery-run`).
- When no entries match, print `No entries.` and exit 0 — same as an empty
  ledger.
- `--category` without a value is a usage error: message on stderr, exit 1.
- Plain `penny list` behavior is unchanged.
