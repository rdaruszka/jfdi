# Fixtures

## half-app — the penny playground

A deliberately half-finished product for exercising JFDI end-to-end: `penny`,
a tiny expense-ledger CLI with the same toolchain as JFDI itself (pnpm, strict
TypeScript, vitest, biome), a passing gate, and a seeded backlog of seven
tickets. Three commands work (`add`, `list`, `total`); the rest is tickets.

The template carries **no `.git`** — git can't version a nested repo. Every
consumer goes through `createProjectFixture()` ([src/fixture-project.ts](../src/fixture-project.ts)),
which copies the template to a destination **outside any parent git repo**,
creates the repo with a short realistic history, seeds the canonical stage
prompts, and promotes the chosen Backlog cards to Ready.

Consumers:

- **Manual runs** — `pnpm playground` (optionally `--tickets 1,7`,
  `--tickets remove-entry`, `--tickets none`, `--dest <dir>`, `--no-install`).
  Prints the path and the `jfdi start` / `jfdi run` invocations.
- **E2E tests** — [src/fixture-project.test.ts](../src/fixture-project.test.ts)
  drives a fixture copy through the real pipeline + integration with the fake
  harness. Set `JFDI_FIXTURE_E2E=1` to also run the fixture's real gate
  (needs network/pnpm store the first time).
- **Prompt refiner** — mint one fixture per prompt variant; identical starting
  bytes make runs comparable. Score with the grading checks below.

### The ticket taxonomy

Each card exercises one pipeline behavior — a regression on "escalation
quality" or "feedback convergence" shows up on a specific ticket, not as noise:

| # | Card ([[id]]) | Exercises |
|---|---------------|-----------|
| 1 | filter-by-category | Happy path: well-specified feature |
| 2 | filter-by-month | Overlaps #1's files → serialized integration, rebase-then-regate |
| 3 | fix-total-rounding | Bug fix from a repro; QA verifies against the ticket |
| 4 | extract-storage | Behavior-preserving refactor; tempts scope creep |
| 5 | budget-command | Deliberately underspecified → decide-log-proceed, Decisions |
| 6 | remove-entry | Trap criteria (id stability/reuse) → review & QA feedback rounds |
| 7 | (card-only, no note) | `--version`; the no-ticket-note path |

Tickets 2 and 6 make runs slower and noisier *on purpose*. For a quick
"is JFDI alive" smoke, use `--tickets 1` or `--tickets 7`.

### Grading (half-app.grading/)

Mechanical acceptance checks, kept **outside the template** so agents never
see them. Run against the repo a JFDI run merged into:

```
fixtures/half-app.grading/grade.sh <playground-dir>            # all checks
fixtures/half-app.grading/grade.sh <playground-dir> remove-entry version-flag
```

Check names = ticket ids (plus `version-flag` for the card-only ticket).
Every check must fail on the untouched baseline and pass after a faithful
implementation. What the checks *can't* judge — refactor quality (#4), design
sense (#5) — is exactly what Code Review exists for; #5's check does verify
that decisions were logged in the ticket note.

### Editing the template

Keep the baseline gate green (`pnpm build && pnpm test && pnpm lint` inside
`fixtures/half-app/`) and keep the seeded flaws intact — the float bug in
`total`, the duplicated storage code, the `entries.length + 1` id scheme.
They are load-bearing: tickets 3, 4, and 6 point at them. If you add a ticket,
add its grading check and a row to the taxonomy table.
