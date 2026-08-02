# JFDI — System Specification (Iteration 2)

> **JFDI** — *Just F'ing Do It.*
>
> A command-line harness around coding-agent CLIs. Hand it a ticket; it runs the ticket through an implement → review → QA loop in an isolated git worktree, then merges. Point it at a Kanban board and it does that continuously, several tickets at a time.

This spec is the build handoff document. It defines the full system; the build sequence at the end defines what to build first. Iteration 1 documents live in `Iteration 1/` and are historical context only — nothing in them is normative.

## 1. What JFDI Is

JFDI automates the supervision loop of AI-assisted development. The human writes tickets; JFDI dispatches agent sessions to implement them, reviews the work from two independent angles (code quality and functional behavior), and integrates finished work into the target branch — escalating to the human only at configured gates or on genuine hard blocks.

It is **CLI-first**: a harness *around* a coding-agent CLI, not a user interface. A terminal UI ships with the coordinator; a web front end is a future renderer over the same event stream, never a prerequisite.

### Lessons from Iteration 1 (design constraints)

Iteration 1 specified a PO agent, PRD builder, decomposition engine, question queue, SQLite backend, and Svelte dashboard — and died in the chat-UI/streaming plumbing before the execution loop existed. Iteration 2 therefore **explicitly excludes**:

- Any PO / orchestrating-intelligence agent
- PRD building and automated task decomposition (the human authors tickets)
- Pre-implementation ticket review
- A question queue as a first-class subsystem (the board serves this role)
- Multi-project management (single project, folder-scoped)
- Web UI in the core build
- A dependency graph between tickets

## 2. Project Scope and Layout

JFDI operates on **one project**: the git repository in the current working directory, the same mental model as running `claude` in a folder. The project's JFDI setup lives in a `.jfdi/` directory at the repo root:

```
.jfdi/
  config.json        — project configuration (§9)
  board.md           — the Kanban board (Obsidian Kanban plugin format)
  tickets/           — one markdown note per non-trivial ticket
  sandbox.md         — the QA sandbox contract (§6)
  prompts/           — the stage prompt templates
  worktrees/<ticket-id>/ — the isolated checkout each run builds in (§5)
```

Run state lives outside the project, in a per-project directory under the user's home:

```
~/.jfdi/projects/<project-key>/
  runs/<ticket-id>/  — per-run session logs, reports, decision records
  events.jsonl       — append-only coordinator event stream (§8)
  state.json         — current coordinator snapshot (derived, rebuildable from events)
```

`<project-key>` is the project root's absolute path with every path separator turned into `-` (`/Users/alice/dev/app` → `-Users-alice-dev-app`), the way Claude Code keys `~/.claude/projects/`; a `-` in a folder name is indistinguishable from a separator, an ambiguity accepted here as it is there. The key derives from the project root — the directory holding `.jfdi/` — so state written mid-run on behalf of a worktree still resolves to the project's own directory. `~/.jfdi/` itself is reserved for future user-global material; everything project-specific sits under `projects/`. Worktrees are the exception that stays in-project (`.jfdi/worktrees/`, gitignored), following Claude Code's `.claude/worktrees/` precedent.

`.jfdi/` is committed to the repo, with two exclusions. Worktrees are gitignored. So are `board.md` and `tickets/`: they are work-tracking artifacts external to the product — the same information that would live in JIRA or another ticket service (§12's ticket-source seam) — and they are mutated continuously by both the human and the coordinator mid-run, so versioning them would entangle work-tracking churn with product history. What *is* versioned is the project's JFDI setup: config.json, sandbox.md, and the stage prompts. Obsidian visibility is achieved by symlinking `.jfdi/` (or the board/tickets within it) into the vault, or the vault into it; writes follow such links — the atomic temp-file rename targets the link's real path, so the tool's edits land in the linked file and never replace the link with a private copy. Outside its own state directory under `~/.jfdi/projects/`, the tool never searches or writes beyond the project folder — following a symlink the user placed inside `.jfdi/` is user consent, and in particular, tickets and `[[wikilinks]]` resolve only against `.jfdi/tickets/`.

## 3. The Board and Tickets

### Board

`board.md` uses the **Obsidian Kanban plugin format** (`kanban-plugin: board` frontmatter, `## Column` headings, `- [ ] card` items) so it renders as a live board in Obsidian.

Column *names* are user-defined. Config maps board columns to the three roles JFDI cares about:

- **begin** — cards here are ready for dispatch (the explicit human "go" signal)
- **in-progress** — where the coordinator moves a card it has picked up
- **done** — where finished, merged cards land

The coordinator additionally manages three of its own well-known columns (created if absent, names configurable):

- **Blocked** — pipeline hit a hard block or exhausted retries; the card carries a pointer to the question/failure written into its ticket note
- **Ready to Merge** — used only when `integration.mode` is `on-approval` (§7)
- **Inbox** — agent proposals. Stages report out-of-scope issues they noticed (pre-existing bugs, dead code, tooling gaps) in their verdict's `observations`; the coordinator materializes each as a card here with provenance (`*(from <ticket-id>)*`), deduplicated by card text. The contract: agent-writable only via the coordinator, drained only by the human (promote to the begin column or delete), and **never dispatched from** — a card here is inert by definition. Agents propose; humans promote.

Cards the user places in any unmapped column are ignored.

### Cards and ticket notes

A card is **one line**. A card may contain a `[[wikilink]]`; if it does, the link is resolved **only against `.jfdi/tickets/`** — the tool never searches beyond that folder. When a ticket note exists, its body is the task spec handed to the Implementation agent; when it doesn't, the card line itself is the entire spec.

Ticket notes are plain markdown. During a run the pipeline appends structured sections to the note: `## Decisions` (autonomous choices made mid-implementation, §5), `## Questions` (on escalation), `## Report` (final summary at sign-off). The ticket note is the single human-readable record of what happened to that ticket.

### Write contention

Obsidian and the coordinator both write `board.md`. The coordinator must do atomic read-modify-write: read, check mtime, write via temp-file rename, and re-read/retry on mtime change. Coordinator edits are minimal and surgical (move one card line between columns); it never rewrites the file wholesale.

## 4. The Agent Pipeline

Four agents, run per ticket, each a fresh harness session (see §10) in the ticket's worktree:

| Agent                 | Role                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implementation**    | Does the work. Writes unit tests alongside the code. Must pass the mechanical gate before handing off.                                                                                                           |
| **Code Review**       | Reviews the diff from a pure code standpoint — structure, clarity, conventions, maintainability. Not functionality.                                                                                              |
| **Quality Assurance** | Exercises the built artifact in a sandbox per the sandbox contract (§6), validates behavior against the ticket, and encodes what it verified as automated end-to-end/regression tests committed with the ticket. |
| **Integration**       | Owned by the coordinator, not the ticket pipeline. Rebases the finished branch onto the target branch, resolves conflicts, reruns the mechanical gate, merges. Serialized — global critical section (§7).        |

### Worktrees

Every ticket runs in its own **git worktree** on its own branch (e.g. `jfdi/<ticket-id>`), created from the integration target branch at dispatch time and removed after merge (or kept on Blocked for inspection). Multiple tickets build concurrently in separate worktrees; nothing but Integration ever touches the target branch.

### Resuming an interrupted run

A run can die mid-pipeline (escalation, retries exhausted, a killed session, a coordinator crash), leaving partial commits and possibly a dirty or mid-rebase worktree. Re-dispatching the card reuses that branch and **resumes deliberately, not by luck**: before the first session, any in-progress rebase is aborted and any uncommitted state is checkpoint-committed ("recovered from interrupted run"), so the agent starts from a clean, committed tree. The Implementation prompt then carries a resume section — how many commits the branch already holds, a short log, and what was recovered — telling the agent to continue the work rather than start over, plus the previous run's unanswered round feedback (persisted as `history.json` under the run directory, so it survives the process that produced it).

### Mechanical gate

A configured list of shell commands (build, test, lint, format-check) that must all exit zero. It runs:

1. Before the Implementation agent may hand off ("done" isn't done until it passes)
2. As part of every review round on the new commit
3. By Integration after conflict resolution, pre-merge

The gate is the cheapest reviewer and runs first, always. Encoding standards into linter/formatter/test config — so reviews spend tokens only on what machines can't check — is a core system value; `jfdi init` and `jfdi convo` (§11) exist to build and evolve that layer.

### Review flow (sequential — token-optimized)

```
Implementation
  → mechanical gate (must pass)
  → Code Review
      fail → feedback to Implementation, next round
      pass → Quality Assurance
          fail → feedback to Implementation, next round
          pass → hand off to Integration queue
```

Reviews are sequential with Code Review gating QA: every round where Code Review fails skips the expensive sandbox run entirely. Both reviews' sign-offs bind to a specific commit — any code change invalidates both, so a fix round re-enters at the gate and repeats both reviews on the new commit.

**Feedback rounds:** review feedback goes to a fresh Implementation session with the branch state plus a summary of prior rounds (what was asked, what was tried). Retry cap is configurable (`pipeline.max_rounds`, default 3); on exhaustion the card moves to Blocked with the accumulated round history in the ticket note.

### Test ownership

- **Implementation** owns unit tests — written with the code, required by the gate.
- **Quality Assurance** owns the acceptance/regression suite — derived from the *ticket*, not the diff (independent, adversarial), and grown every ticket: what QA manually verified in the sandbox it commits as automated tests. The gate compounds in strength, and future QA runs get cheaper because old behavior is mechanically covered — QA manually exercises only the new surface.
- No dedicated test-writing agent, no forced TDD.

## 5. Autonomy and Escalation

Default posture: **decide, log, proceed.** When the Implementation agent hits a decision fork (ambiguity, minor design choice), it makes the reasonable call, records it under `## Decisions` in the ticket note, and continues. Agents are prompted that escalation is a last resort reserved for genuine hard blocks — contradictory requirements, missing access, work that is impossible as specified — and an escalation must include a recommended answer, never a bare question.

On escalation: the question and recommendation are written to the ticket note's `## Questions` section, the session ends, the card moves to **Blocked**. The human answers by editing the note and moving the card back to the begin column; a fresh session resumes from the existing branch with the answer in context. **The board is the question queue.**

The safety net for wrong autonomous calls is layered: Code Review and QA judge against the ticket, and the decision log surfaces in the final report at the merge gate — caught before merge, without mid-flight interruption.

Per-ticket override: `mode: ask` in the ticket note's frontmatter lowers the escalation bar for tasks where the human wants check-ins.

## 6. The Sandbox Contract

`.jfdi/sandbox.md` tells the QA agent how to exercise the product: how to build it, launch it, drive it, and tear it down. Without this contract QA cannot do its job; `jfdi init` creates it and `jfdi convo` refines it.

- **Terminal-driven sandboxes ship first** (CLIs, daemons, JFDI itself): invocation patterns, expected outputs, scratch-directory conventions.
- **Browser-driven sandboxes** (web apps, via Playwright or the harness's browser tooling) are the second sandbox type, needed when JFDI is pointed at the work webapp.

**Self-hosting note:** JFDI's first target is JFDI. The sandbox contract must therefore handle a product-under-test that itself spawns agent sessions and creates worktrees — QA runs must isolate the inner JFDI (scratch repos outside the outer worktree, a separate `.jfdi/`, a scratch `JFDI_HOME` so run state stays out of the real `~/.jfdi/projects/`, guard against runaway nested session spawning). Iteration 1 hit the related failure of Claude Code walking up the directory tree to find an enclosing repo; test fixtures live outside any parent git repo.

## 7. Integration

Integration is a **coordinator-owned global critical section**: any number of tickets build and review in parallel, but exactly one integration runs at a time, pulled from a merge-ready queue in completion order. This is the entire reason Integration is a separate agent — concurrent builds finish out of request order, and something must serialize the landing.

Per merge, the Integration agent:

1. Rebases the ticket branch onto `integration.target_branch` (default `main`, configurable — never assumed to be main)
2. Resolves conflicts itself
3. Reruns the mechanical gate
4. Judges its own resolution: if it touched real logic (not adjacent-line noise), it flags **complicated merge** and sends the card back to QA instead of proceeding
5. Merges into the target branch, moves the card to done, removes the worktree

`integration.mode`:

- **`auto`** — pipeline pass flows straight through Integration to done.
- **`on-approval`** — finished cards land in **Ready to Merge** with the final report (summary, decision log, review verdicts) appended to the ticket note. The human either tells JFDI to merge (`jfdi merge <ticket>` / moving the card) or merges by hand — the coordinator detects a branch already contained in the target and closes the card without double-merging.

Merge target is local git only in this iteration; the merge-target abstraction (§12) carries GitHub/Bitbucket PR flows later.

## 8. Coordinator, Concurrency, and State

### Modes

- **`jfdi run <ticket>`** — single-ticket mode. Runs one ticket (card reference or inline description) through the full pipeline, streaming progress inline like any CLI tool. No board required.
- **`jfdi start`** — multi-mode. Watches the board, dispatches cards from the begin column, runs pipelines concurrently, owns the Integration queue, and **always presents a live view**: a full-screen terminal UI showing the board state, each active ticket's pipeline stage, session activity, and the integration queue. The board is watched live (file-watch with polling fallback) so cards added while running are picked up.

### Concurrency

- `max_concurrent` pipelines (config). Dispatch order = board order, top of the begin column first.
- **Startup sweep.** A card sitting in the in-progress column when `jfdi start` runs was stranded there by a coordinator that died: nothing drives it and no scan looks at that column. Those cards move to **Blocked** with an event, so the human sees them; their branches keep their partial work and a re-dispatch resumes from it (§4).
- **No dependency graph.** Cards in the begin column are treated as independent; ordering is expressed by what the human chooses to ready, and serialized Integration plus the complicated-merge → re-QA valve absorb collisions.

### State and events

The coordinator appends every significant transition (dispatch, stage change, gate result, round, escalation, merge) to the project's `events.jsonl` and maintains `state.json` as the current snapshot — both under `~/.jfdi/projects/<project-key>/` (§2). **The TUI is a pure renderer over this stream.** The future web UI, and the future JIRA-watching daemon mode, are additional renderers/consumers of the same stream — this separation is a hard architectural requirement, not a nicety. Raw harness session output is captured per run under that directory's `runs/<ticket-id>/` and viewable via `jfdi logs <ticket>`.

## 9. Configuration (`.jfdi/config.json`)

```jsonc
{
  "board": {
    "path": ".jfdi/board.md",
    "columns": { "begin": "Ready", "inProgress": "In Progress", "done": "Done",
                  "blocked": "Blocked", "readyToMerge": "Ready to Merge",
                  "inbox": "Inbox" }
  },
  "ticketsDir": ".jfdi/tickets",
  "gate": [
    { "name": "build", "cmd": "npm run build" },
    { "name": "test",  "cmd": "npm test" },
    { "name": "lint",  "cmd": "npm run lint" }
  ],
  "pipeline": { "max_rounds": 3 },
  "integration": { "target_branch": "main", "mode": "on-approval" },
  "max_concurrent": 2,
  "harness": "claude"          // "claude" or "codex"
}
```

Exact schema is the builder's to refine; the settled decisions are: user-named columns mapped to roles, gate as an ordered command list, configurable target branch, `auto`/`on-approval` integration, concurrency cap, and a named harness.

## 10. Harness Abstraction

Agents run as headless Claude Code or OpenAI Codex subprocesses, spawned in the ticket's worktree with the stage's prompt and context. JFDI parses each provider's JSON event stream for progress, output, and completion. JFDI supplies the provider-specific arguments required for autonomous operation; they are not project configuration.

The runner sits behind a **harness interface** — roughly `spawn(promptSpec, cwd) → event stream`, plus interactive launch and kill/cleanup — with Claude Code and Codex implementations. Additional providers slot in behind the same interface. Pipeline logic never touches harness specifics.

Per-stage prompts (Implementation, Code Review, QA, Integration) are files under `.jfdi/` (seeded by `jfdi init`, tunable via `jfdi convo`), so agent behavior is user-adjustable without code changes.

## 11. CLI Surface

| Command | Purpose |
|---|---|
| `jfdi run <ticket>` | Single ticket through the full pipeline, inline streaming output |
| `jfdi start` | Coordinator multi-mode with live TUI |
| `jfdi status` | Snapshot of state.json for scripts/quick checks |
| `jfdi logs <ticket>` | Tail a ticket's raw session output |
| `jfdi merge <ticket>` | Approve a Ready-to-Merge card (on-approval mode) |
| `jfdi convo` | Interactive harness session scoped to the JFDI layer itself — its amended prompt directs it at gates, sandbox contract, board config, and agent prompts, not the product code |
| `jfdi init` | Agent-assisted setup: inspects the repo; scaffolds `.jfdi/` (config, board, tickets dir, prompts, sandbox contract); sets up or tightens linter/formatter/test-runner config so the mechanical gate has teeth |

## 12. Extension Seams (designed for, not built)

All future work slots behind interfaces that exist from day one:

- **Ticket sources** — markdown board now; JIRA later (daemon mode watching a filter and auto-grabbing qualifying tickets)
- **Merge targets** — local git now; GitHub / Bitbucket PR flows later
- **Harnesses** — Claude Code and Codex now; additional providers later
- **Renderers** — TUI now; web UI later, over the same event stream
- **Dependency checking** between cards — explicitly out now, possible later
- **User-impersonate + PM agents** — an agent attempting a defined user's job and filing feature tickets, paired with a PM agent to shape them. Idea parked from the original discussion; nothing in this iteration should preclude it (it is just another ticket source)

## 13. Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| Language | Node.js / TypeScript | Self-hosting exercises the node toolchain from ticket one; shares a language with the future web renderer |
| Agent runtime | Provider subprocess with JSON event output | Inherits the selected agent CLI's toolchain; JFDI stays a thin orchestrator |
| TUI | Ink (or equivalent React-for-terminal) | Same component model as the future web UI |
| State | Flat files (`events.jsonl`, `state.json`) | Rebuildable, greppable, no DB dependency |
| VCS | git worktrees, local only | Isolation for concurrent builds; no forge dependency |

## 14. Build Sequence

Each milestone is independently usable; the loop exists before any UI beyond inline streaming.

1. **Single-ticket pipeline** — `jfdi run`: worktree creation, harness runner, mechanical gate, Implementation → Code Review → QA rounds, Integration merge, ticket-note reporting. Hand-authored config and prompts. *This milestone alone already replaces the manual supervision loop.*
2. **Coordinator** — `jfdi start`: board parsing and watching, column mapping, concurrent dispatch, serialized integration queue, `on-approval` flow, events/state stream, live TUI, `status`/`logs`/`merge`.
3. **Convo mode** — `jfdi convo` with the JFDI-layer prompt.
4. **Init** — agent-assisted `jfdi init` bootstrap (deliberately last: the pipeline only needs gates to exist, not to have authored them).

Self-hosting begins as early as milestone 1: JFDI's own remaining tickets become its first board.
