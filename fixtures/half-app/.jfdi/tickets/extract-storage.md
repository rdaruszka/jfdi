# Extract shared JSON storage into one module

Every command file carries its own copy of `dataFile()` / `loadEntries()` (and
`add` also has `saveEntries()`). Three copies already drifted once during a bug
fix and will drift again. Consolidate storage into a single module that all
commands use.

## Acceptance criteria

- One storage module owns reading and writing the ledger file (including the
  `PENNY_FILE` / `penny.json` resolution and the missing-file → empty-ledger
  case). No command file touches `node:fs` directly anymore.
- **Zero behavior change.** Every command's output, exit codes, and the on-disk
  JSON format are byte-for-byte identical to before.
- The existing test suite passes unmodified (tests may be *added*, not
  changed).
- No new dependencies.
- This is a refactor ticket: do not slip in features, formatting sweeps of
  untouched files, or unrelated cleanups.
