# penny total prints absurd floating-point totals

Bug report from a user:

```
$ penny add 0.10 snacks --date 2026-07-01
$ penny add 0.20 snacks --date 2026-07-02
$ penny total
Total: 0.30000000000000004
```

Money should never look like that.

## Acceptance criteria

- `penny total` always prints the sum with exactly two decimal places:
  the repro above prints `Total: 0.30`, an empty ledger prints `Total: 0.00`.
- Totals are correct to the cent for typical ledgers (two-decimal amounts) —
  no lingering float artifacts at any magnitude.
- `penny list` output is unchanged.
- Existing `penny.json` files keep working as-is — do not change the stored
  data format or require any migration.
