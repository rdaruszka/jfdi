# Add a month filter to penny list

Spending questions are usually month-shaped ("what did July look like?").
`penny list` should take an optional `--month YYYY-MM` flag that shows only
entries from that calendar month.

## Acceptance criteria

- `penny list --month 2026-07` prints only entries whose date falls in July
  2026, in the same format and order as the unfiltered list.
- The value must be exactly `YYYY-MM`; anything else (`2026-7`, `July`,
  a full date) is a usage error: message on stderr, exit 1.
- When no entries match, print `No entries.` and exit 0.
- If a category filter exists on `list` by the time you build this, the two
  flags must compose: `--month 2026-07 --category groceries` shows entries
  matching both.
- Plain `penny list` behavior is unchanged.
