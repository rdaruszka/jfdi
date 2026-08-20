# CLI Reference

```
jfdi — Just F'ing Do It

Usage:
  jfdi run <ticket>     Run one ticket through the full pipeline (card text,
                        [[wikilink]], or an inline description). Add --force to
                        run a ticket whose blocked-by tickets are not yet done.
  jfdi start            Watch the board and run pipelines continuously (live TUI)
  jfdi status [--json]  Snapshot of coordinator state
  jfdi logs <ticket>    Dump a ticket's raw session logs
  jfdi merge <ticket>   Approve a Ready-to-Merge ticket (on-approval mode)
  jfdi init [options]   Scaffold .jfdi/ and conversationally tune the setup

Init options:
  --bare                Scaffold only; do not launch an interactive session
  --harness <provider>  claude or codex (default: claude)
  --model <model>       Provider model (default: claude-fable-5)
  --effort <level>      Provider effort (default: provider default)
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
to Done (auto mode, merged), Ready to Merge (on-approval), or Blocked. It also
[pauses on a broken provider](pipeline.md#when-the-provider-goes-down) exactly
as the coordinator does, printing the reason and the resume time and taking `R`
on its terminal to retry now.

A ticket [blocked by another](board-and-tickets.md#blocked-by-gating) that is not
yet done is refused before the pipeline starts: the run exits non-zero naming the
unresolved blockers. `jfdi run --force <ticket>` prints them and runs anyway —
blocking means blocked on every path, so the override has to be spelled out.

| Exit code | Meaning |
|---|---|
| 0 | Pipeline passed (and merged, in auto mode) |
| 1 | Error (not a repo, bad config, unexpected failure) |
| 2 | Blocked — unresolved `blocked-by` tickets (run `--force` to override), escalation, exhausted rounds, or blocked integration; see the ticket note |

## `jfdi start`

Coordinator multi-mode: watches the board (file-watch with a 2-second polling
fallback), dispatches cards from the begin column top-first up to
`max_concurrent`, runs pipelines concurrently, owns the serialized integration
queue, and presents a live full-screen TUI. A begin-column card whose ticket is
[blocked by another](board-and-tickets.md#blocked-by-gating) not yet done is
skipped over — left in place, re-checked each scan, and dispatched once its
blockers reach Done.

The TUI shows the board name and target branch, active tickets with their
current stage and round and running cost/agent-time, tickets needing attention
(blocked / ready to merge / queued), the integration queue, settled tickets, and
a tail of recent events.
When the provider under the harness is down, a banner across the top names the
reason and when work resumes. Two keys: `q` quits (as do Ctrl-C / SIGTERM, exit
codes 130/143), and `R` retries a paused harness immediately. `jfdi start`
requires stdout to be a TTY and exits non-zero with an actionable error when it
is redirected; it does not provide a headless coordinator mode.

On startup the coordinator:

- requires the board to exist (run `jfdi init` first);
- ensures the Blocked, Ready to Merge, and Inbox columns exist;
- **continues cards left in In Progress** by an earlier coordinator, through the
  ordinary resume path — stopping and restarting JFDI needs no board edits from
  you (see [Stopping and restarting](board-and-tickets.md#stopping-and-restarting));
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
integration path the coordinator uses (merge → gate → land), then moves
the card to Done. Works alongside a running coordinator — the shared event
stream keeps both consistent.

Requires the `jfdi/<ticket-id>` branch to exist. If you already merged by hand
and deleted the branch, the coordinator's next scan will detect the landed work
and close the card itself.

| Exit code | Meaning |
|---|---|
| 0 | Merged (or branch was already contained in the target — closed without merging) |
| 1 | No such branch |
| 2 | Integration blocked — reason in the ticket note; worktree kept |

## `jfdi init [options]`

Sets up or revisits JFDI in the current repo, in three parts:

1. **Scaffold** (idempotent — existing files are never overwritten):
   `.jfdi/config.json` with defaults, the board with all six columns, the
   tickets directory, the ticket-format contract, a sandbox contract skeleton,
   the Claude settings + format-hook pair, `.jfdi/.gitignore`, and the eight
   generic stage prompt defaults. An existing `prompts/` directory is first
   retired to a timestamped, gitignored `.jfdi/prompts.backup-*/` the setup
   agent never reads, so the seeded set is always clean raw material.
2. **Conversational setup**: an interactive fresh-eyes session — isolated from
   the project's own agent instructions, carrying the operational brief and
   coding guidelines as its appended system prompt. An unloadable config does
   not prevent setup: init warns, uses sandboxed `auto` permissions, and puts
   the load error in the session's opening message. It explores the project's
   code first (never git history), then the workflow configuration,
   interviews you one question at a time, and writes nothing until you
   explicitly approve the complete plan. The approved setup gives the gate
   real build/test/lint commands, instantiates the coding guidelines in
   `AGENTS.md` (or established equivalent), links the ticket-format contract as
   required reading, fills the sandbox contract, and builds every stage prompt
   into its project-specific form. It never changes product code, and it
   ignores specific issues it notices there — at most they shape which
   checks and prompt rules it proposes. Rerun the same command to revisit a
   setup.
3. **Gate epilogue**: after the interactive CLI exits, JFDI reloads the config,
   runs the gate itself, and prints either `gate verified` or the failing step
   with a suggestion to rerun init. If the config still cannot load, that is
   reported as a failed verification with the same suggestion.

`--bare` stops after the idempotent scaffold; it still warns about an unloadable
config, but exits successfully. Link `.jfdi/ticket-format.md` from the project's
agent instructions yourself. The interactive session defaults to
Claude with `claude-fable-5`; `--harness`, `--model`, and `--effort` select it
directly and do not borrow a pipeline stage's selection. The provider's native
interactive CLI is the frontend, so exit with its usual `/exit` or Ctrl-C.

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
