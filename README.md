# JFDI — Just Fucking Do It

A command-line harness around the Claude Code harness. Hand it a ticket; it runs
the ticket through an **implement → review → QA** loop in an isolated git
worktree, then merges. Point it at a Kanban board and it does that continuously,
several tickets at a time.

The full design lives in [docs/jfdi-spec.md](docs/jfdi-spec.md).

## How it works

For each ticket, four agents run as fresh `claude -p` sessions in the ticket's
own git worktree (branch `jfdi/<ticket-id>`):

1. **Implementation** — does the work, writes unit tests, must pass the
   mechanical gate (your build/test/lint commands) before handing off
2. **Code Review** — judges the diff on structure and maintainability only
3. **Quality Assurance** — exercises the built artifact per the sandbox
   contract and commits what it verified as regression tests
4. **Integration** — coordinator-owned and strictly serialized: rebases onto
   the target branch, resolves conflicts, reruns the gate, merges

Review failures loop back to a fresh Implementation session with the feedback
(capped rounds). Agents decide-log-proceed; genuine hard blocks move the card to
**Blocked** with the question *and a recommended answer* written into the ticket
note. The board is the question queue.

## Usage

```
jfdi init             # scaffold .jfdi/ and set up the mechanical gate
jfdi run <ticket>     # one ticket through the pipeline, streaming inline
jfdi start            # watch the board, run continuously, live TUI
jfdi status [--json]  # coordinator state snapshot
jfdi logs <ticket>    # raw session logs
jfdi merge <ticket>   # approve a Ready-to-Merge ticket (on-approval mode)
jfdi convo            # tune the JFDI layer itself (gate, prompts, sandbox)
```

The board (`.jfdi/board.md`) uses the Obsidian Kanban plugin format, so it
renders as a live board in Obsidian. Column names are yours; map them to roles
in `.jfdi/config.json`. Cards are one line; link a fuller spec with a
`[[wikilink]]` into `.jfdi/tickets/`.

## Development

```
pnpm install
pnpm build && pnpm test && pnpm lint   # the mechanical gate
```

JFDI is self-hosted: this repo has its own `.jfdi/` and its backlog flows
through its own pipeline.
