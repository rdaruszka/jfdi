# QA Sandbox Contract — penny

The product under test is `penny`, a non-interactive CLI. Exercise the **built
artifact**, not the source.

## Build

```
pnpm install --prefer-offline   # if node_modules is missing
pnpm build                      # emits dist/
```

## Launch & drive

Invoke as `node <worktree>/dist/cli.js <command>`. The data file location comes
from the `PENNY_FILE` environment variable — **always set it to a file inside
your scratch directory**; never let it default to `penny.json` in the worktree.

Commands and expectations:

- `... --help` — usage text, exit 0
- `... add <amount> <category> [description...] [--date YYYY-MM-DD]` — appends
  an entry, prints `Added #<id> ...`, exit 0. Use `--date` for determinism.
- `... list` — one line per entry, or `No entries.`; exit 0
- `... total` — `Total: <sum>`, exit 0
- Bad input (unknown command, malformed amount/date) — message on stderr, exit 1

## Scratch space

All QA scratch work (data files, temp output) goes under the OS temp directory
(`mktemp -d`), never inside the worktree or the repository. One scratch
directory per scenario; a fresh `PENNY_FILE` per scenario keeps them independent.

## Teardown

`rm -rf` the scratch directory. penny spawns no processes and touches nothing
outside `PENNY_FILE`.
