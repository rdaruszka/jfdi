# CLI Reference

```
jfdi — Just F'ing Do It

Usage:
  jfdi run <ticket>     Run one ticket through the full pipeline (card text,
                        [[wikilink]], or an inline description)
  jfdi start            Watch the board and run pipelines continuously (live TUI)
  jfdi status [--json]  Snapshot of coordinator state
  jfdi logs <ticket>    Dump a ticket's raw session logs
  jfdi merge <ticket>   Approve a Ready-to-Merge ticket (on-approval mode)
  jfdi convo            Interactive session scoped to the JFDI layer itself
  jfdi init [--bare]    Scaffold .jfdi/ and set up the mechanical gate
```

Run every command from inside the project's git repository (any subdirectory
works — JFDI resolves the repo root). Not being in a repo is an immediate error:
JFDI operates on the repo in the current directory, the same mental model as
running `claude` in a folder.

## `jfdi run <ticket>`

Single-ticket mode: one ticket through the full pipeline, streaming progress
inline. Everything after `run` is joined into one reference, so multi-word
descriptions don't need quotes.

The reference can be:

- **A wikilink** — `jfdi run "[[fix-total-rounding]]"` — resolves the ticket
  note in `.jfdi/tickets/`.
- **Card text** — the same text as a board card resolves to the same ticket id.
- **An inline description** — `jfdi run add a --version flag` — no board or note
  required; the description is the entire spec.

No board is required, but when the board holds a matching card, the run moves it
through the same columns the coordinator would: to In Progress at dispatch, then
to Done (auto mode, merged), Ready to Merge (on-approval), or Blocked.

| Exit code | Meaning |
|---|---|
| 0 | Pipeline passed (and merged, in auto mode) |
| 1 | Error (not a repo, bad config, unexpected failure) |
| 2 | Blocked — escalation, exhausted rounds, or blocked integration; see the ticket note |

## `jfdi start`

Coordinator multi-mode: watches the board (file-watch with a 2-second polling
fallback), dispatches cards from the begin column top-first up to
`max_concurrent`, runs pipelines concurrently, owns the serialized integration
queue, and presents a live full-screen TUI.

The TUI shows the board name and target branch, active tickets with their
current stage and round, tickets needing attention (blocked / ready to merge /
queued), the integration queue, settled tickets, and a tail of recent events.
One key: `q` quits (as do Ctrl-C / SIGTERM, exit codes 130/143). When stdout is
not a TTY, `jfdi start` falls back to plain line-by-line streaming.

On startup the coordinator:

- requires the board to exist (run `jfdi init` first);
- ensures the Blocked, Ready to Merge, and Inbox columns exist;
- sweeps **crash orphans** — cards stranded in In Progress by a dead coordinator
  move to Blocked, their branches intact, ready for re-dispatch;
- picks up cards added while it runs, live.

Other JFDI processes (a `jfdi merge` in a second terminal) append to the same
event stream; a live coordinator folds their events in without a restart.

## `jfdi status [--json]`

Prints the current state snapshot: every tracked ticket with status, stage,
round, and last activity, plus the integration queue. `--json` emits the raw
snapshot for scripts. Reads derived state only — safe to run any time, no
coordinator needed.

## `jfdi logs <ticket-id>`

Dumps the raw harness session logs (JSONL) for a ticket's **latest** run, plus
any integration session, with a header per file. Takes the derived ticket id
(the slug printed by `jfdi run`, also the branch suffix), not free card text.
Exit 1 if the ticket has no recorded runs.

## `jfdi merge <ticket-id>`

Approves a Ready-to-Merge ticket in `on-approval` mode: runs the identical
integration path the coordinator uses (rebase → gate → fast-forward), then moves
the card to Done. Works alongside a running coordinator — the shared event
stream keeps both consistent.

Requires the `jfdi/<ticket-id>` branch to exist. If you already merged by hand
and deleted the branch, the coordinator's sweep will detect the landed work and
close the card itself.

| Exit code | Meaning |
|---|---|
| 0 | Merged (or branch was already contained in the target — closed without merging) |
| 1 | No such branch |
| 2 | Integration blocked — reason in the ticket note; worktree kept |

## `jfdi convo`

Launches an interactive harness session scoped to the JFDI layer itself — gate
config, sandbox contract, board config, stage prompts — not your product code.
See [Prompts & Customization](prompts-and-customization.md#jfdi-convo).

## `jfdi init [--bare]`

Bootstraps JFDI in the current repo, in two parts:

1. **Scaffold** (idempotent — existing files are never overwritten):
   `.jfdi/config.json` with defaults, the board with all six columns, the
   tickets directory, the nine prompt files, a sandbox contract skeleton, the
   Claude settings + format-hook pair, and `.jfdi/.gitignore`.
2. **Agent-assisted setup**: an interactive session inspects the repo, fills the
   gate with real build/test/lint commands that exit zero *right now* (tightening
   or installing tooling as needed), instantiates the shipped coding guidelines
   into the repo's `CLAUDE.md`, writes a real sandbox contract, and wires the
   format hook.

`--bare` skips the agent step and leaves you to fill in the gate and sandbox by
hand — useful in scripts and sandboxes.

## Exit code conventions

JFDI reproduces shell conventions so wrappers can read it like any other
command:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Failure (errors, usage errors, unknown commands) |
| 2 | Blocked — the distinctive "needs a human" code from `run` and `merge` |
| 127 | The harness executable (`claude` / `codex`) was not found or not executable |
| 130 / 143 | Killed by SIGINT / SIGTERM (`jfdi start`) |

There is no `--version` flag and no global options; command flags are only the
ones listed above.
