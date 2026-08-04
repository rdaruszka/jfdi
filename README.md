# JFDI — Just F'ing Do It

A command-line harness around coding-agent CLIs. Hand it a ticket; it runs the
ticket through an **implement → review → QA** loop in an isolated git worktree,
then merges. Point it at a Kanban board and it does that continuously, several
tickets at a time.

You write tickets. JFDI supervises the agents — and only escalates to you when
a run genuinely needs a human.

```
board.md (Obsidian Kanban)              $ jfdi start  (live TUI)

## Ready
- [ ] Add a category filter    ──►      filter-by-category   running · qa
- [ ] Fix rounding in totals   ──►      fix-rounding         ready to merge

                                        integration queue: fix-rounding
```

## How it works

For each ticket, agents run as fresh headless **Claude Code** or **OpenAI
Codex** sessions in the ticket's own git worktree (branch `jfdi/<ticket-id>`):

1. **Implementation** — does the work, writes unit tests, and must pass the
   **mechanical gate** (your build/test/lint commands) before handing off
2. **Code Review** — judges the diff on structure and maintainability only
3. **Quality Assurance** — exercises the built artifact per your sandbox
   contract and writes what it verified as regression tests
4. **Integration** — coordinator-owned and strictly serialized: merges the
   target branch in, resolves conflicts, reruns the gate, then lands one merge
   commit per ticket — the signed-off commit stays reachable, and
   `git log --first-parent` reads one entry per ticket

Review failures loop back to the Implementation session with the feedback
(capped rounds; later rounds continue existing sessions instead of paying to
rebuild context). Both review sign-offs bind to a specific commit — any change
repeats the gate and both reviews.

**No agent commits.** The pipeline commits each session's handoff itself — on
success and on failure, so interrupted work survives — and a dedicated cheap
session, the *scribe*, writes the message from the diff, the ticket and the
session's own summary. That exact text is also appended to the ticket note, so
`git log` and the note each tell the whole story on their own.

Agents **decide, log, proceed**: routine judgment calls are made autonomously
and recorded in the ticket note for your review at the merge gate. Genuine hard
blocks move the card to **Blocked** with the question *and a recommended
answer* written into the ticket. The board is the question queue — answer in
the note, move the card back, and the run resumes from its existing branch.

The board itself is a plain markdown file in the Obsidian Kanban format: it
renders as a live drag-and-drop board in Obsidian, diffs cleanly, and is
co-edited safely by you and the coordinator at once. Out-of-scope issues agents
notice become proposal cards in an **Inbox** column — agents propose, you
promote.

## Installation

Requires Node 22+, git, and either the `claude` or `codex` CLI on your `PATH`.

```bash
pnpm install && pnpm build && pnpm pack && npm i -g ./jfdi-0.0.1.tgz
```

To upgrade, rebuild and reinstall the same way.

## Quick start

From the root of the project you want it to work on:

```bash
jfdi init      # scaffold .jfdi/ — an agent session then sets up your
               # mechanical gate, sandbox contract, and coding guidelines

jfdi run add a --version flag    # one ticket, no board needed

jfdi start     # watch the board, run continuously, live TUI
```

The full walkthrough is in
[docs/getting-started.md](docs/getting-started.md).

## Commands

```
jfdi run <ticket>     One ticket through the pipeline, streaming inline
jfdi start            Watch the board, run continuously (live TUI)
jfdi status [--json]  Coordinator state snapshot
jfdi logs <ticket>    A ticket's raw session logs
jfdi merge <ticket>   Approve a Ready-to-Merge ticket (on-approval mode)
jfdi convo            Tune the JFDI layer itself (gate, prompts, sandbox)
jfdi init [--bare]    Scaffold .jfdi/ and set up the mechanical gate
```

## Design in one paragraph

The **coordinator** watches the board and dispatches each ready card into its
own git worktree, up to `max_concurrent` pipelines at once; **integration** is
globally serialized so only one merge ever touches the target branch at a time.
Every transition appends to a per-project `events.jsonl`; state and UIs (the
TUI today, anything else tomorrow) are pure derivations of that stream. Agent
CLIs sit behind a **harness** interface, so pipeline logic never touches
provider specifics. The cheapest reviewer is the mechanical gate, and the
system's core value is moving standards *into* it: `jfdi init` and `jfdi convo`
exist to encode your conventions into lint/test/build config so agent review
tokens are spent only on what machines can't check.

## Documentation

**[docs/](docs/README.md)** — the full documentation index.

| | |
|---|---|
| [Getting Started](docs/getting-started.md) | Install → first ticket → continuous board |
| [Board & Tickets](docs/guide/board-and-tickets.md) | The Kanban board, cards, ticket notes, the Inbox |
| [The Pipeline](docs/guide/pipeline.md) | Stages, gate, rounds, escalation, resume |
| [Integration & Merging](docs/guide/integration.md) | Serialized merges, approval modes |
| [Configuration](docs/guide/configuration.md) | Every config field |
| [Prompts & Customization](docs/guide/prompts-and-customization.md) | Stage prompts, sandbox contract, `jfdi convo` |
| [CLI Reference](docs/guide/cli.md) | Commands, flags, exit codes |
| [Architecture](docs/architecture/overview.md) | Components, invariants, extension seams |
| [Development Guide](docs/development.md) | Working on JFDI itself |

## Status

JFDI is young and moving fast. All four milestones — single-ticket pipeline,
coordinator, convo mode, init — are implemented and tested, and JFDI is
**self-hosting**: improvements to JFDI flow through JFDI, from its own board.
Interfaces (config, prompts, events) may still change between versions.
