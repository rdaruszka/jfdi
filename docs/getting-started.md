# Getting Started

This walkthrough takes you from a bare repo to a merged, agent-implemented
ticket, then to continuous board-driven operation.

## Prerequisites

- **Node 22+** and **git**
- The **`claude`** (Claude Code) and **`codex`** (OpenAI Codex) CLIs installed,
  authenticated, and on your `PATH` — JFDI is a harness *around* coding-agent
  CLIs, not an agent itself. Both, because the scaffolded config runs code
  review on a different provider than implementation; to work with only one,
  point every entry in [`stages`](guide/configuration.md#stages) at it
- A project that lives in a git repository

## Install

JFDI is installed from source as a packed tarball (deliberately a frozen copy,
not a link into the repo). Clone this repository, then from its root:

```bash
pnpm install && pnpm build && pnpm pack && npm i -g ./jfdi-0.0.1.tgz
```

To upgrade, pull, rebuild, and reinstall the same way. Verify with `jfdi help`.

## Initialize your project

From your project's repo root:

```bash
jfdi init
```

This scaffolds `.jfdi/` — config, board, tickets directory, ticket-format
contract, sandbox contract, and the generic stage prompt defaults — and then
launches a conversational agent session with fresh eyes: isolated from your
repo's existing agent instructions, so it evaluates them instead of obeying
them. It explores your project's code first, interviews you one question at a
time, presents a complete plan, and writes only after you approve it:

- fills `.jfdi/config.json`'s **gate** with real build/test/lint commands that
  all exit zero *right now*, setting up or tightening tooling as needed;
- instantiates the shipped coding guidelines into your repo's `AGENTS.md` (or
  established equivalent) and requires agents to read `.jfdi/ticket-format.md`
  before creating or changing cards or tickets;
- writes a **sandbox contract** (`.jfdi/sandbox.md`) so QA knows how to build,
  launch, and drive your product;
- builds every stage prompt in `.jfdi/prompts/` from the seeded generic
  defaults into its project-specific form;
- wires the per-file format hook.

After you exit the provider's interactive CLI, init reloads the config and runs
the gate itself, reporting the first failing step or `gate verified`. Rerun init
at any time for a fresh full-setup pass; an existing `prompts/` directory is
retired to a timestamped `.jfdi/prompts.backup-*/` (preserved for you, never
read by the agent) and reseeded with clean generic defaults for the session to
build on, and everything else is proposed before it is changed.

The gate matters more than anything else in the setup: it is the cheapest
reviewer, it runs before every review round, and "done" isn't done until it
passes. (Use `jfdi init --bare` to skip the agent and fill things in by hand.)

Two settings worth checking in `.jfdi/config.json` before your first run:

- `integration.target_branch` — defaults to `main`; set it if your default
  branch differs.
- `integration.mode` — `on-approval` (default) parks finished work in a Ready to
  Merge column for your sign-off; `auto` merges immediately.

The full reference is in [Configuration](guide/configuration.md).

## Run your first ticket

You don't need the board for a single ticket — hand `jfdi run` an inline
description:

```bash
jfdi run add a --version flag
```

You'll see the pipeline stream by: an **Implementation** session does the work
and writes unit tests, the **gate** runs, a fresh **Code Review** session judges
the diff, a fresh **QA** session exercises the built artifact per your sandbox
contract and writes regression tests, and — with a pass in `on-approval`
mode — you end at:

```
Pipeline passed. Approve with: jfdi merge add-a-version-flag-<hash>
```

Review the report in the ticket note under `.jfdi/tickets/`, then:

```bash
jfdi merge add-a-version-flag-<hash>
```

which merges your target branch into the ticket branch, reruns the gate, and
lands the result on the target as a single merge commit — so the commit the
reviews signed off on stays reachable, and `git log --first-parent` still reads
one entry per ticket.

If the run **blocks** instead (exit code 2), the reason — an escalated question
with a recommended answer, or the round-by-round feedback history — is in the
ticket note. Edit the note with your answer and re-run; the pipeline resumes
from the branch's existing work rather than starting over. See
[The Pipeline](guide/pipeline.md) for the full lifecycle.

## Go continuous: the board

For more than one ticket at a time, use the board. `.jfdi/board.md` is an
Obsidian-Kanban-format markdown file — plain text that renders as a live
drag-and-drop board in Obsidian (symlink it into your vault if you use one).

Add cards to the begin column (`Ready` by default), one line each, ideally
wikilinked to a fuller spec:

```markdown
## Ready

- [ ] Add a category filter to the list command [[filter-by-category]]
- [ ] Fix the rounding bug in totals [[fix-total-rounding]]
```

…with the specs as markdown notes in `.jfdi/tickets/filter-by-category.md` etc.
Then:

```bash
jfdi start
```

The coordinator watches the board live, dispatches cards top-first (up to
`max_concurrent` pipelines in parallel, each in its own git worktree), serializes
merges so the target branch only ever moves one integration at a time, and shows
everything in a full-screen TUI. Cards move across the board as work progresses;
finished work waits in Ready to Merge; anything needing you lands in Blocked
with its question in the ticket note. Answer, move the card back to the begin
column, and the run resumes.

From a second terminal, `jfdi status` snapshots the state and
`jfdi logs <ticket-id>` dumps a run's raw session logs.

## Where to go next

- [Board & Tickets](guide/board-and-tickets.md) — the board format, columns,
  wikilinks, ticket notes, and the agent-proposal Inbox
- [The Pipeline](guide/pipeline.md) — stages, rounds, verdicts, escalation,
  resume
- [Integration & Merging](guide/integration.md) — serialized merges, approval
  modes, hand-merge detection
- [Configuration](guide/configuration.md) — every config field
- [Prompts & Customization](guide/prompts-and-customization.md) — tuning agent
  behavior, the sandbox contract, conversational init
- [CLI Reference](guide/cli.md) — every command and exit code
