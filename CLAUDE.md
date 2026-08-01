# JFDI — Just F'ing Do It

A CLI harness around the Claude Code harness. Hand it a ticket; it runs implement → review → QA in an isolated git worktree, then merges. Point it at a Kanban board and it does that continuously, several tickets at a time.

**The spec is the source of truth: [docs/jfdi-spec.md](docs/jfdi-spec.md) (Iteration 2).** This file summarizes conventions and invariants for working in this repo; when in doubt, the spec wins. Anything under `Iteration 1/` is historical, not normative.

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

The **coordinator** watches `board.md` (Obsidian Kanban format), dispatches each ready card into its own **git worktree** on branch `jfdi/<ticket-id>`, and runs a per-ticket pipeline of fresh `claude -p` sessions: **Implementation → mechanical gate → Code Review → QA**, with feedback rounds (cap: `pipeline.max_rounds`, default 3). **Integration** is coordinator-owned and globally serialized — one merge at a time, rebase onto the target branch, rerun the gate, merge. Every transition appends to `.jfdi/events.jsonl`; `state.json` is a derived snapshot; the TUI is a pure renderer over that stream.

## Layout

```
docs/jfdi-spec.md    — the spec (normative)
src/                 — TypeScript source
.jfdi/               — JFDI's own state once self-hosting begins:
  config.json          project config (§9)
  board.md             Kanban board (Obsidian Kanban plugin format)
  tickets/             one markdown note per non-trivial ticket
  sandbox.md           QA sandbox contract (§6)
  runs/<ticket-id>/    per-run logs/reports (gitignored)
  events.jsonl         append-only event stream (gitignored)
  state.json           derived snapshot (gitignored)
```

`board.md`, `tickets/`, `config.json`, `sandbox.md`, and the stage prompt files are versioned; `runs/`, `events.jsonl`, `state.json` are gitignored.

## Hard invariants — do not violate

These are architectural requirements from the spec, not preferences:

1. **Renderer separation.** All UI (TUI now, web later) renders `events.jsonl`/`state.json` only. Pipeline/coordinator logic never talks to a UI directly, and no state exists only in the UI.
2. **Harness abstraction.** Pipeline logic never touches `claude`-specific details. Everything goes through the harness interface (`spawn(promptSpec, cwd) → event stream`, plus kill/cleanup); `claude -p --output-format stream-json` is just the first implementation.
3. **Serialized integration.** Exactly one integration at a time, pulled from the merge-ready queue in completion order. Nothing but Integration ever touches the target branch.
4. **Atomic board writes.** `board.md` is co-edited by Obsidian. Read → check mtime → write via temp-file rename → re-read/retry on mtime change. Edits are surgical (move one card line); never rewrite the file wholesale.
5. **Sequential reviews, commit-bound sign-offs.** Code Review gates QA (a Code Review fail skips the sandbox run). Both sign-offs bind to a specific commit — any code change re-enters at the gate and repeats both reviews.
6. **Wikilink scope.** Card `[[wikilinks]]` resolve only against `.jfdi/tickets/`. The tool never reads or writes outside the project folder.
7. **Decide, log, proceed.** Agent prompts keep escalation a last resort; escalations must carry a recommended answer. Decisions land in the ticket note's `## Decisions`; the board is the question queue (Blocked column + `## Questions`).
8. **Target branch is configurable** (`integration.target_branch`) — never assume `main`.

## Explicitly out of scope (Iteration 2)

No PO/orchestrator agent, no PRD building or auto-decomposition, no pre-implementation ticket review, no standalone question queue, no multi-project support, no web UI, no ticket dependency graph. Don't build toward these; just don't preclude the extension seams in spec §12 (ticket sources, merge targets, harnesses, renderers).

## Build sequence (spec §14)

All four milestones are implemented and tested:

1. **Single-ticket pipeline** — `jfdi run` ([pipeline.ts](src/pipeline.ts), [integrate.ts](src/integrate.ts))
2. **Coordinator** — `jfdi start` ([coordinator.ts](src/coordinator.ts), TUI in [src/tui/App.tsx](src/tui/App.tsx)), plus `status`/`logs`/`merge`
3. **Convo mode** — `jfdi convo` ([commands/convo.ts](src/commands/convo.ts))
4. **Init** — `jfdi init` ([commands/init.ts](src/commands/init.ts), [scaffold.ts](src/scaffold.ts))

Self-hosting is live: this repo's own [.jfdi/](.jfdi/config.json) has the pnpm gate configured (`on-approval` mode), and [.jfdi/board.md](.jfdi/board.md) holds the backlog. Improvements to JFDI should flow through JFDI: add a card to the Ready column and `jfdi start` (or `jfdi run "<ticket>"`).

## Testing notes

- Self-hosting hazard: tests exercise a product that spawns agent sessions and creates worktrees. Test fixtures (scratch git repos) live **outside any parent git repo** (e.g. under the OS temp dir) — Claude Code walks up the tree looking for an enclosing repo, and that bit Iteration 1.
- Guard against nested/runaway session spawning in QA sandboxes; inner JFDI runs get their own scratch repo and `.jfdi/` state.
- Unit tests belong to Implementation and ship with the code; acceptance/regression tests belong to QA, derive from the *ticket* (not the diff), and accumulate over time.
