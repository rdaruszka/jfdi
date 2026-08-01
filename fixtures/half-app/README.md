# penny

A tiny expense ledger for the terminal. Entries live in a plain JSON file so
your data is always yours.

## Usage

```
penny add <amount> <category> [description...] [--date YYYY-MM-DD]
penny list
penny total
```

Examples:

```
$ penny add 12.50 groceries oat milk and bread
Added #1  2026-08-01      12.50  groceries  oat milk and bread

$ penny list
#1  2026-08-01      12.50  groceries  oat milk and bread

$ penny total
Total: 12.5
```

Entries are stored in `penny.json` in the current directory. Set the
`PENNY_FILE` environment variable to use a different file.

## Development

Node >= 22, pnpm. TypeScript strict mode, vitest for tests, biome for
lint + format. All three must pass before merging:

```
pnpm build && pnpm test && pnpm lint
```

Layout: `src/cli.ts` parses argv and dispatches; each command lives in
`src/commands/` and returns its output as a string (the CLI prints, commands
don't). Shared entry types and validation live in `src/entry.ts`. Command
functions read the data file location from `PENNY_FILE` themselves, which is
also how the tests isolate their fixtures.
