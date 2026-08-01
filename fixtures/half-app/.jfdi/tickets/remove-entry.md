# Add penny remove so entries can be deleted

Typos happen (`penny add 1250 groceries` instead of `12.50`) and today the only
fix is hand-editing the JSON file. Add `penny remove <id>` to delete an entry.

## Acceptance criteria

- `penny remove 2` deletes the entry with id 2 and prints a confirmation that
  includes the removed entry's details; exit 0.
- An id that doesn't exist, or an argument that isn't a positive integer, is an
  error: message on stderr, exit 1, ledger untouched.
- All remaining entries keep their existing ids — removal never renumbers
  anything.
- An id, once used, is never reused: after removing entry 2, no later
  `penny add` may ever create another entry with id 2.
- `list` and `total` reflect the removal.
