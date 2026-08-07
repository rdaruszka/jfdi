# Prompts & Customization

Agent behavior is user-adjustable without code changes. Three levers, in order of
preference:

1. **The gate** — encode a standard into a lint rule or test and no agent ever
   needs to be told about it again. Always the first choice.
2. **The sandbox contract** — teach QA how to exercise *your* product.
3. **The prompts** — edit the stage prompt templates themselves.

Rerun `jfdi init` to evolve all three interactively. It surveys the current
setup first, so the same conversation works for a fresh scaffold and a mature
project.

## Stage prompts

Every prompt JFDI uses is a markdown file under `.jfdi/prompts/`, seeded on first
use and versioned with your repo. **The file on disk is authoritative**: JFDI
compiles in defaults, but if a file exists it is used verbatim, and a missing
file is written out before use — what ran is always on disk, never a silent
in-code fallback. Edit freely; delete a file to get the current default back.

Nine files:

| File | Used by |
|---|---|
| `implementation.md` | A fresh Implementation session (round 1, or fallback) |
| `implementation-continue.md` | Continuing the Implementation session in a later round |
| `code-review.md` | A fresh Code Review session |
| `code-review-continue.md` | Continuing Code Review in a later round |
| `qa.md` | A fresh QA session |
| `qa-continue.md` | Continuing QA in a later round |
| `integration.md` | The conflict-resolution session during integration |
| `commit-message.md` | The [scribe](pipeline.md#commits-and-the-scribe) — every commit message the pipeline writes |
| `init.md` | The conversational `jfdi init` setup prompt |

### Template variables

Templates use `{{UPPERCASE_PLACEHOLDERS}}`. Unknown placeholders render as empty
strings (they never leak literally into a prompt). Every pipeline stage gets the
common set:

| Variable | Content |
|---|---|
| `TICKET_ID` | The ticket id |
| `SPEC` | The ticket spec — the note's [defined slice](board-and-tickets.md#what-the-agents-actually-read) (title + description + open `## Questions` + decision blocks from phase comments), or the card line for a card with no note |
| `BRANCH` | `jfdi/<ticket-id>` |
| `TARGET_BRANCH` | `integration.target_branch` |
| `GATE_COMMANDS` | The configured gate commands, formatted as a list |
| `VERDICT_PATH` | The absolute path the session must write its JSON verdict to |

Stage-specific additions:

| Prompt | Extra variables |
|---|---|
| `implementation` | `RESUME_SECTION` (prior-work summary when resuming), `FEEDBACK_SECTION` (accumulated feedback from earlier attempts, plus the `mode: ask` override) |
| `implementation-continue` | `FEEDBACK` (the single failure being addressed, framed by its source) |
| `code-review` | `NOTE_PATH`, `GATE_RESULT`, `COMMIT_LOG`, `DIFF_STAT`, `DIFF_SECTION` (the full diff inline when it fits) |
| `code-review-continue` | `LAST_SEEN_COMMIT`, `HEAD_COMMIT`, `PROVENANCE`, `NEW_COMMITS`, `TOUCHED_FILES` |
| `qa` | `NOTE_PATH`, `GATE_RESULT`, `SANDBOX` (the sandbox contract), `COMMIT_LOG`, `DIFF_STAT` — deliberately no diff |
| `qa-continue` | `LAST_SEEN_COMMIT`, `HEAD_COMMIT`, `PROVENANCE`, `NEW_COMMITS`, `TOUCHED_FILES` |
| `integration` | (common set only) |
| `commit-message` | `TICKET_ID`, `SPEC`, `STAGE`, `ROUND`, `MAX_ROUNDS`, `STAGE_SUMMARY` (what the session reported it did), `STAGED_DIFF` (what is about to be committed), `RECENT_LOG` (the house style), `STATUS_LINE` (the line the pipeline appends) — and no `VERDICT_PATH`: the scribe answers with the message itself |
| `init` | `JFDI_OPERATIONS` (the operational brief compiled from [docs/jfdi-operations.md](../jfdi-operations.md)), `CODING_GUIDELINES` (the generic guidelines compiled from [docs/coding-guidelines.md](../coding-guidelines.md)) |

If you edit a prompt, keep two blocks intact unless you know what you're doing:
the **verdict instructions** (the pipeline reads outcomes only from the verdict
file the prompt names — remove that and the stage always "fails" with an invalid
verdict) and the verdict **schema** the stage's parser expects (see
[The Pipeline](pipeline.md#verdicts)).

`commit-message.md` is the exception to both: it names no verdict file, and its
whole answer *is* the message. Retune its voice freely — the message shape it
must not fight is the status line and the `JFDI-Round`/`JFDI-Duration`/`JFDI-Cost`
trailer block, which the pipeline appends under whatever the scribe wrote.

The shared posture block in the three fresh-stage prompts encodes the system's
values — decide-log-proceed, escalation as a last resort with a recommendation,
observations instead of inline scope creep, fail loud. Tuning that language tunes
the whole system's temperament.

## The sandbox contract

`.jfdi/sandbox.md` tells the QA agent how to exercise your product: how to build
it, launch it, drive it, and tear it down. Without it QA can only read code and
guess. It is inlined into every fresh QA prompt.

A good contract covers:

- **Build** — the exact commands to produce the artifact under test.
- **Launch & drive** — how to invoke it, with expected outputs and exit codes
  per command/flow. Concrete invocation patterns beat prose descriptions.
- **Scratch space** — where test data goes (an OS temp dir, never the repo), and
  any environment variables that redirect state.
- **Teardown** — what to remove, and what stray processes to check for.

Terminal-driven products (CLIs, daemons) are the first-class case.
Browser-driven products work through whatever browser tooling your harness
provides — describe the flow in the same build/launch/drive/teardown shape.

If your product itself spawns agents or creates git repos (JFDI's own contract is
the worked example — see [.jfdi/sandbox.md](../../.jfdi/sandbox.md)), the
contract must also isolate the inner thing: scratch repos outside any parent
repo, stub agent CLIs on `PATH`, a scratch `JFDI_HOME`, and guards against
runaway nested spawning.

`jfdi init` seeds a skeleton; refine it whenever QA misses something it should
have caught — that's usually a contract gap, not a prompt gap.

## The format hook

Claude Code sessions spawned by JFDI get `.jfdi/claude-settings.json` injected,
which wires a PostToolUse hook: after every file edit, `.jfdi/hooks/format.sh`
runs. Point that script at your formatter's single-file mode (the scaffolded
version is a no-op placeholder with an example) and sessions never burn turns on
lint-fix loops — the formatter fixes style before the agent even sees a gate
failure.

This is a provider-specific acceleration: Codex has no hook system, so its
sessions simply run without it — degraded, not broken. The settings file applies
only to JFDI-spawned sessions, never to your own `.claude/` setup.

## Conversational init

`jfdi init` launches the provider's native interactive CLI with `init.md` as its
first user message. The prompt requires a survey before questions, one question
at a time, a complete setup plan, and explicit approval before any write. Use it
both for first setup and later conversations such as "QA keeps missing X" or
"reviews keep nitpicking Y." Its first instinct is a mechanical rule rather
than more prompt prose: when tooling can enforce a standard, review tokens stop
being spent on it forever.

The scaffold always runs first and never overwrites existing files. A prompt,
sandbox contract, or config still at its recognizable seed is available to
fill; human-tuned content is proposed for change and remains untouched until
the plan is approved. The on-disk prompt remains authoritative, so projects
scaffolded by an older JFDI keep their existing `init.md` until they replace or
edit it.
