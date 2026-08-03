# JFDI — Just F'ing Do It

A CLI harness around coding-agent CLIs. Hand it a ticket; it runs implement → review → QA in an isolated git worktree, then merges. Point it at a Kanban board and it does that continuously, several tickets at a time.

**The documentation under [docs/](docs/README.md) is the source of truth** — [docs/architecture/overview.md](docs/architecture/overview.md) for the system design, the guide pages for behavior. This file summarizes conventions and invariants for working in this repo; when in doubt, the docs win, and a diff that changes behavior they describe updates them in the same diff.

## Which JFDI is which

Self-hosting makes three distinct things easy to conflate. Keep them apart:

1. **The JFDI project** — this codebase: the source that compiles into the tool. This is what AGENTS.md governs and what tickets change.
2. **JFDI the tool** — the compiled product: a coding tool that runs agent pipelines against a target project. Some files in this repo are *product content the tool ships to target projects* — `docs/coding-guidelines.md`, `docs/agent-enforcement.md`, `src/guidelines.ts`, the scaffold templates — not rules or config for this repo itself.
3. **`.jfdi/` — one tool instance's configuration.** This repo's `.jfdi/` configures a running instance of the JFDI tool whose target project happens to be the JFDI project (like Claude Code being used to build Claude Code). Its board and tickets track work on the project; its config and prompts steer that instance's runs.

The test: a file copied into target projects at init is **product content** (edit it to change what users get); a file steering this repo's own runs is **instance config** (edit `.jfdi/`); everything else is **project source** (edit it to change the tool). The project's own coding standards are this file's Code guidelines plus `biome.json`/`tsconfig.json` — never the shipped guideline docs.

## Toolchain

- **Runtime:** Node.js + TypeScript (strict mode)
- **Package manager:** pnpm
- **Tests:** vitest
- **Lint + format:** biome (single tool, single config)
- **TUI:** Ink (React-for-terminal)

The project's own mechanical gate — all must exit zero before any handoff:

```bash
pnpm build && pnpm test && pnpm lint
```

JFDI is self-hosting from milestone 1: JFDI's own tickets become its first board, so keep the gate fast and strict. Prefer encoding standards into biome/vitest/tsconfig over prose review comments.

## Architecture (one paragraph)

The **coordinator** watches `board.md` (Obsidian Kanban format), dispatches each ready card into its own **git worktree** on branch `jfdi/<ticket-id>`, and runs a per-ticket pipeline of fresh Claude Code or Codex sessions: **Implementation → mechanical gate → Code Review → QA**, with feedback rounds (cap: `pipeline.max_rounds`, default 3). **Integration** is coordinator-owned and globally serialized — one merge at a time, rebase onto the target branch, rerun the gate, merge. Every transition appends to the project's `events.jsonl` under `~/.jfdi/projects/<project-key>/`; `state.json` is a derived snapshot; the TUI is a pure renderer over that stream.

## Layout

```
docs/               — the documentation (docs/README.md is the index):
  getting-started.md, guide/     user docs
  architecture/, development.md  developer docs
docs/coding-guidelines.md  — the generic coding guidelines (authoritative source)
docs/agent-enforcement.md  — the enforcement design JFDI implements (reference)
src/                 — TypeScript source
src/guidelines.ts    — GENERATED from docs/coding-guidelines.md (`pnpm sync:guidelines`);
                       injected into the init prompt for target projects
fixtures/half-app/   — "penny": a half-finished CLI + 7-ticket board for test runs
                       (see fixtures/README.md; minted via src/fixture-project.ts)
fixtures/half-app.grading/ — per-ticket acceptance checks, kept out of the template
scripts/playground.mjs     — `pnpm playground`: mint a disposable half-app copy
.jfdi/               — JFDI's own setup once self-hosting begins:
  config.json          project config (docs/guide/configuration.md)
  board.md             Kanban board (Obsidian Kanban plugin format)
  tickets/             one markdown note per non-trivial ticket
  sandbox.md           QA sandbox contract
  prompts/             stage prompt templates
  worktrees/<ticket-id>/ — per-run isolated checkout (gitignored)

~/.jfdi/projects/<project-key>/  — run state, outside the project:
  runs/<ticket-id>/    per-run logs/reports
  events.jsonl         append-only event stream
  state.json           derived snapshot
```

`config.json`, `sandbox.md`, and the stage prompt files are versioned. `board.md` and `tickets/` are **not** — they are work-tracking artifacts external to the product (typically symlinked into an Obsidian vault; a JIRA-style service later via the ticket-source extension seam), mutated mid-run by human and coordinator alike. `worktrees/` is runtime state; `.jfdi/.gitignore` (owned by the scaffold) covers it and the two above. Run state lives in the home directory instead, under a `<project-key>` that dash-flattens the project root's absolute path the way Claude Code keys `~/.claude/projects/`; [src/state-dir.ts](src/state-dir.ts) is the only place that computes it, and `JFDI_HOME` overrides the base so tests never touch the real one.

## Hard invariants — do not violate

These are architectural requirements, not preferences (rationale in [docs/architecture/overview.md](docs/architecture/overview.md)):

1. **Renderer separation.** All UI (TUI now, web later) renders `events.jsonl`/`state.json` only. Pipeline/coordinator logic never talks to a UI directly, and no state exists only in the UI.
2. **Harness abstraction.** Pipeline logic never touches provider-specific details. Everything goes through the harness interface (`spawn(promptSpec, cwd) → event stream` — with session continuation via a spawn option — plus interactive launch and kill/cleanup); Claude Code and Codex are implementations. Provider-specific accelerations (e.g. the Claude PostToolUse format hook) live inside the matching harness implementation, and their absence elsewhere degrades gracefully.
3. **Serialized integration.** Exactly one integration at a time, pulled from the merge-ready queue in completion order. Nothing but Integration ever touches the target branch.
4. **Atomic board writes.** `board.md` is co-edited by Obsidian. Read → check mtime → write via temp-file rename → re-read/retry on mtime change. Edits are surgical (move one card line); never rewrite the file wholesale. Writes follow symlinks: the rename targets the link's real path — renaming onto the link itself would replace it with a private copy and silently split the board from the file the human edits.
5. **Sequential reviews, commit-bound sign-offs.** Code Review gates QA (a Code Review fail skips the sandbox run). Both sign-offs bind to a specific commit — any code change re-enters at the gate and repeats both reviews.
6. **Wikilink scope.** Card `[[wikilinks]]` resolve only against `.jfdi/tickets/`. Beyond its own state directory under `~/.jfdi/projects/`, the tool never reads or writes outside the project folder — except through symlinks the user placed inside `.jfdi/` (board/tickets linked into a vault): following a user-created link is user consent, and writes land on the link's target.
7. **Decide, log, proceed.** Agent prompts keep escalation a last resort; escalations must carry a recommended answer. Decisions land in the ticket note's `## Decisions`; the board is the question queue (Blocked column + `## Questions`).
8. **Target branch is configurable** (`integration.target_branch`) — never assume `main`.

## Glossary — one name per concept

Use these terms exactly; introduce no synonyms. The list grows only by editing this file.

- **board** — `.jfdi/board.md`, the Obsidian-Kanban file; its columns hold cards.
- **card** — one line on the board; a pointer to work.
- **ticket** — the markdown note in `.jfdi/tickets/` a card wikilinks to; carries `## Decisions` and `## Questions`.
- **run** — one ticket's trip through the pipeline; logs under the state directory's `runs/<ticket-id>/`.
- **state directory** — `~/.jfdi/projects/<project-key>/`, where one project's run state lives: `runs/`, `events.jsonl`, `state.json`.
- **stage** — one fresh agent session within a run: Implementation, Code Review, QA.
- **gate** — the mechanical check (`pnpm build && pnpm test && pnpm lint`); all must exit zero.
- **round** — one feedback cycle: fix → gate → reviews (cap: `pipeline.max_rounds`).
- **sign-off** — a review stage's approval, bound to a specific commit.
- **integration** — the coordinator-owned rebase → gate → merge step; globally serialized.
- **coordinator** — the long-running process that watches the board and dispatches runs.
- **harness** — the agent-session abstraction (`spawn(promptSpec, cwd) → event stream`, plus interactive launch); Claude Code and Codex are implementations.
- **worktree** — the isolated git checkout (branch `jfdi/<ticket-id>`) a run works in.
- **resume** — a re-dispatch that deliberately continues an interrupted run's partial work: the worktree is sanitized first, and the Implementation prompt carries what the branch already holds plus the previous run's unanswered feedback. (Run-level; distinct from **continuation**, which is session-level.)
- **continuation** — re-entering a stage's own previous agent session in a later round of the same run (`claude -p --resume` / `codex exec resume`) with a short brief, instead of starting a fresh session. Round 1 of every stage is always fresh; a forgotten session falls back to one fresh spawn.
- **crash orphan** — a card left in the in-progress column by a coordinator that died; the startup sweep moves it to Blocked.
- **observation** — an out-of-scope issue a stage reports in its verdict (`observations` array); never fixed inline.
- **inbox** — the board column where observations land as proposal cards. Agent-writable via the coordinator only, human-drained, never dispatched from: agents propose, humans promote.

## Code guidelines

The generic rules with rationale and check questions live in [docs/coding-guidelines.md](docs/coding-guidelines.md) (authoritative; [src/guidelines.ts](src/guidelines.ts) is generated from it via `pnpm sync:guidelines` and gate-checked for drift — the compiled copy feeds the init prompt for target projects). The enforcement design behind it all is [docs/agent-enforcement.md](docs/agent-enforcement.md). This section is the TypeScript instantiation JFDI holds itself to — keep it in step when a generic rule changes. Reviewers: treat each rule as a question to answer about the diff, not background prose. Every mechanical rule that biome/tsc can encode should be encoded there; prose is the fallback, not the preference.

**Code**

- Every loop and recursion has a termination measure — something that provably shrinks — or an explicit cap. Unbounded loops are legal only if they yield every iteration (`await`, sleep, backoff) **and** check a reachable exit condition each pass. Infinite-and-hot is a defect anywhere, coordinator included.
- Long-running processes (coordinator, TUI) bound their in-memory collections; anything that grows per-event needs an eviction story.
- Functions do one thing at one level of abstraction. Length is a smell, not a violation: past ~100 lines, restructure or justify with an annotated suppression. Splitting mechanically to duck the number is itself a violation.
- Assert what the type system can't prove: data crossing trust boundaries (`board.md`, ticket notes, anything `JSON.parse`d, harness stream events, subprocess output), cross-call invariants, and exhaustiveness (`never` checks). Impossible states get an assertion, not a recovery path. Asserting what types already guarantee is noise.
- Every acquired resource — subprocess, watcher, timer, file handle, lock — has a paired release that runs on error paths too (`finally` or explicit teardown). The happy path is not the only path.
- Every promise is awaited or explicitly handled — no fire-and-forget. No empty catch blocks; catch-and-continue requires the degradation to be deliberate and stated.
- Errors name the operation, the offending value/path, and the way forward ("failed" is not an error message). Test: could the reader act on it without opening the source?
- Zero warnings. `biome-ignore` and `@ts-expect-error` require a real reason at the site; `any` and bare `@ts-ignore` are banned. Suppression reasons are review targets — "function is long" is not a reason.
- No module-level mutable state. Don't mutate arguments or shared objects; return new values.
- Secrets and PII never appear in code, logs, error messages, or test fixtures. Redact at the boundary; fixtures use obvious placeholders.

**Naming**

- Quantities carry their dimension: `timeoutMs`, `delaySeconds`, `sizeBytes`; fraction vs. percent named explicitly. Convert once at the boundary and name the result — no unlabeled numbers in flight.
- No magic numbers: a literal that encodes a decision (threshold, timeout, limit, retry count) becomes a named constant, and the name carries the dimension. Exempt: `0`/`1`/`-1` in index/identity positions, and test expectations. The fix is a constant, not a config option.
- Single-letter names only as: one-expression lambda parameters, numeric loop indices `i`/`j`, `_` for discards. Everywhere else, whole words; name length scales with scope.
- No abbreviations except: `id`, `min`, `max`, `args`, `config`, `init`, standard acronyms (`JSON`, `URL`, `HTTP`, `API`, `CLI`, `TUI`, `QA`), and ecosystem-imposed identifiers (`cwd`, `env`, `argv`). This list grows only by editing this file. `err`, `ctx`, `cfg`, `req`, `res`, `tmp` are spelled out.
- Booleans are positive predicates (`isReady`, `hasMerged`, `shouldRetry`) — never bare nouns, never negated names.
- Collections plural, elements singular (`tickets` / `ticket`).
- One name per concept — see the Glossary. Introducing a synonym is a defect.

**Conduct**

- Decide, log, proceed: state assumptions and interpretation choices in the ticket's `## Decisions` *before* implementing. Never pick between plausible readings silently; escalate only when blocked, with a recommended answer.
- Simplicity first: minimum code that solves the ticket. No speculative features, abstractions for single-use code, unrequested configurability, or handling for impossible states (those get assertions). Review question: what here is not required by the ticket?
- Surgical changes: every changed line traces to the ticket. Clean up orphans your change created; don't touch pre-existing mess — flag it instead. Docs your change falsified are your mess: fix them in the same diff.
- Bug tickets start with a failing repro test; the fix makes it pass. Skipping the repro requires a logged reason in `## Decisions`.
- Never average conflicting patterns: pick one (more recent, better tested), log why, flag the loser. Convention beats taste — follow the codebase's style even where you disagree; surface disagreement, don't silently fork.
- Dependencies are decisions: prefer the Node stdlib, then dependencies already in package.json. Adding a package requires a logged justification in `## Decisions`; a new dependency for a few dozen lines' worth of code fails review.
- Tests verify intent: a test that couldn't fail if the business logic broke is wrong. No implementation-mirroring (asserting methods were called), no tautologies.
- Tests are deterministic and order-independent: wait on conditions, never sleep for durations; control time and randomness. A flaky test is a defect against the gate itself.
- No commented-out code (git remembers); a TODO must reference a ticket or an inbox observation — otherwise do it or delete it.
- Commit at each coherent working state; never hand off with uncommitted changes. Fix-round commits are new commits — no amend/squash while a review is in flight. Gate-green is required at handoff commits, not every intermediate one.
- Fail loud: completion claims must match actual gate output. Anything skipped, stubbed, or degraded is stated prominently in the report, not buried.

**Docs**

- Record what the code cannot say — intent, decisions, vocabulary, invariants. Never restate structure the repo can answer itself. If your diff falsifies this file, the glossary, or anything under `docs/`, update the doc in the same diff or flag it.

## Explicitly out of scope

No PO/orchestrator agent, no PRD building or auto-decomposition, no pre-implementation ticket review, no standalone question queue, no multi-project support, no web UI, no ticket dependency graph. Don't build toward these; just don't preclude the extension seams (ticket sources, merge targets, harnesses, renderers — see [docs/architecture/overview.md](docs/architecture/overview.md)).

## Build sequence

All four milestones are implemented and tested:

1. **Single-ticket pipeline** — `jfdi run` ([pipeline.ts](src/pipeline.ts), [integrate.ts](src/integrate.ts))
2. **Coordinator** — `jfdi start` ([coordinator.ts](src/coordinator.ts), TUI in [src/tui/App.tsx](src/tui/App.tsx)), plus `status`/`logs`/`merge`
3. **Convo mode** — `jfdi convo` ([commands/convo.ts](src/commands/convo.ts))
4. **Init** — `jfdi init` ([commands/init.ts](src/commands/init.ts), [scaffold.ts](src/scaffold.ts))

Self-hosting is live: this repo's own [.jfdi/](.jfdi/config.json) has the pnpm gate configured (`on-approval` mode), and [.jfdi/board.md](.jfdi/board.md) holds the backlog. Improvements to JFDI should flow through JFDI: add a card to the Ready column and `jfdi start` (or `jfdi run "<ticket>"`).

## Testing notes

- Self-hosting hazard: tests exercise a product that spawns agent sessions and creates worktrees. Test fixtures (scratch git repos) live **outside any parent git repo** (e.g. under the OS temp dir) — Claude Code walks up the tree looking for an enclosing repo, and that bit Iteration 1.
- Guard against nested/runaway session spawning in QA sandboxes; inner JFDI runs get their own scratch repo, their own `.jfdi/`, and a scratch `JFDI_HOME` — without the last one an inner run writes its `runs/`, `events.jsonl` and `state.json` into the real `~/.jfdi/projects/`.
- Unit tests belong to Implementation and ship with the code; acceptance/regression tests belong to QA, derive from the *ticket* (not the diff), and accumulate over time.
- For realistic end-to-end material, mint a copy of `fixtures/half-app` with `createProjectFixture()` ([src/fixture-project.ts](src/fixture-project.ts)) — never run JFDI against the template in place. The template's flaws (float bug, duplicated storage, `length + 1` ids) are load-bearing ticket targets; keep its own gate green when editing it (`fixtures/README.md` has the rules).
