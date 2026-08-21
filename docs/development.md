# Development Guide

How to work on JFDI itself: toolchain, tests, fixtures, and the self-hosting
workflow. The architectural map is in
[architecture/overview.md](architecture/overview.md); repo conventions and
invariants for coding agents (and humans) are in [AGENTS.md](../AGENTS.md).

## Toolchain

- **Runtime:** Node.js 22+, TypeScript strict mode
- **Package manager:** pnpm
- **Tests:** vitest
- **Lint + format:** biome (single tool, single config)
- **Front ends:** Ink TUI and a read-only Node HTTP server

The project's own mechanical gate — all must exit zero before any handoff:

```bash
pnpm build && pnpm test && pnpm lint
```

Keep the gate fast and strict: JFDI is self-hosting, so every slow test taxes
every future run. Prefer encoding standards into biome/vitest/tsconfig over
prose review comments — that's the product's own philosophy applied to itself.

## Which JFDI is which

Self-hosting makes three distinct things easy to conflate:

1. **The JFDI project** — this codebase; what tickets change.
2. **JFDI the tool** — the compiled product. Some files in this repo are
   *product content shipped to target projects*, not rules for this repo:
   [docs/coding-guidelines.md](coding-guidelines.md),
   [docs/agent-enforcement.md](agent-enforcement.md),
   [src/guidelines.ts](../src/guidelines.ts), and the scaffold templates.
3. **`.jfdi/`** — one tool instance's configuration, whose target project
   happens to be JFDI itself (like Claude Code being used to build Claude
   Code).

The test: a file copied into target projects at init is **product content**
(edit it to change what users get); a file steering this repo's own runs is
**instance config** (edit `.jfdi/`); everything else is **project source**.
This repo's own coding standards are AGENTS.md plus `biome.json`/
`tsconfig.json` — never the shipped guideline docs.

The product-content modules `src/guidelines.ts`, `src/jfdi-operations.ts`, and
`src/ticket-format.ts` are compiled from their matching authoritative files
under `docs/` by `pnpm sync:guidelines`; drift tests fail the gate when a module
and its source differ. Edit the doc, then regenerate.

## Testing

```bash
pnpm test          # full suite
pnpm test:watch    # watch mode
```

Unit tests sit next to their modules (`*.test.ts`); end-to-end suites
(`*.e2e.test.ts`) drive the built behavior — card moves, merge detection, state
location, resume lifecycle — against scratch repos. Vitest's global setup runs
`pnpm build` once before workers start, so every end-to-end suite uses the same
fresh `dist/` while file parallelism remains enabled.

### The self-hosting hazards

Tests exercise a product that spawns agent sessions and creates git worktrees.
Two rules exist because their violations actually bit:

- **Scratch repos live outside any parent git repo** (under the OS temp dir).
  Both git and Claude Code walk up the directory tree looking for an enclosing
  repo; a fixture created inside this repo gets adopted by it.
- **Nested runs are fully isolated.** An inner JFDI run in a QA sandbox gets its
  own scratch repo, its own `.jfdi/`, stub agent CLIs on `PATH` (never a real
  provider), and a scratch `JFDI_HOME` — without that last one it writes
  `runs/`, `events.jsonl`, and `state.json` into your real
  `~/.jfdi/projects/`. This repo's own
  [.jfdi/sandbox.md](../.jfdi/sandbox.md) is the reference isolation recipe.

Agent sessions in tests are played by `FakeHarness`
([src/test-helpers.ts](../src/test-helpers.ts)) — an in-process handler that
performs real side effects (writes files, drops verdict files) and records every
call — or, for spawn-path coverage, by stub `claude`/`codex` scripts that replay
canned JSON lines. The scribe stands behind its own fake, seeded by
`makeFixture` ([src/test-helpers.ts](../src/test-helpers.ts)), so a test that
cares only about stages never has to answer a commit-message prompt; override it
with `context(handler, { scribeHandler })`.

### Test ownership (the product's rule, applied here)

Unit tests belong to Implementation and ship with the code. Acceptance and
regression tests belong to QA, derive from the *ticket* (not the diff), and
accumulate over time. Bug fixes start with a failing repro test.

## The fixture: half-app ("penny")

For realistic end-to-end material, `fixtures/half-app/` is a deliberately
half-finished expense-ledger CLI with JFDI's own toolchain, a green baseline
gate, and a seven-card backlog. Its flaws are load-bearing ticket targets —
a floating-point bug in `total`, copy-pasted storage across commands, an
id-reuse trap — and its tickets are chosen to exercise specific pipeline
behaviors: a well-specified happy path, two tickets that collide to force
serialized integration and a conflicted merge, a bug fix from a repro, a
behavior-preserving refactor that tempts scope creep, an underspecified design
ticket that forces decide-log-proceed, a trap ticket that forces review
feedback rounds, and a note-less card.

Rules for touching it are in [fixtures/README.md](../fixtures/README.md) — keep
its own gate green, keep the flaws.

**Never run JFDI against the template in place.** Mint a copy:

```bash
pnpm playground                      # fresh copy under the OS temp dir, all cards Ready
pnpm playground --tickets 1,7        # promote only some tickets (position, id, or substring)
pnpm playground --tickets none       # leave everything in Backlog
pnpm playground --dest <dir>         # explicit destination (must be empty)
pnpm playground --no-install         # skip pnpm install in the copy
```

The playground prints the copy's path and ready cards, then the exact commands
to run JFDI against it. Tests use the same factory,
`createProjectFixture()` in
[src/fixture-project.ts](../src/fixture-project.ts), which copies the template,
initializes a real git history (three commits, so merges have archaeology),
and promotes the requested cards.

`fixtures/half-app.grading/` holds per-ticket acceptance checks, kept out of
the template so agents can't read the answer key:

```bash
fixtures/half-app.grading/grade.sh <playground-dir>          # all checks
fixtures/half-app.grading/grade.sh <playground-dir> remove-entry
```

Every check fails on the untouched baseline and passes after a faithful
implementation. What the checks can't judge — refactor quality, design sense —
is exactly what Code Review exists for.

## Self-hosting workflow

Improvements to JFDI should flow through JFDI. This repo's `.jfdi/` has the
pnpm gate configured (`on-approval` mode) and its board holds the backlog
(board and tickets are gitignored work-tracking, typically symlinked into a
vault — fresh clones must relink or recreate them):

```bash
jfdi run "<ticket>"    # one ticket
jfdi start             # or work the board
```

The dogfooding is the point: every rough edge you hit as a JFDI user of JFDI is
a ticket.

## Releasing / installing a local build

The global install is a frozen tarball copy, never a link into the repo:

```bash
pnpm build && pnpm pack && npm i -g ./jfdi-0.0.1.tgz
```

Rebuild and reinstall to pick up changes — a running coordinator keeps using the
code it started with.
