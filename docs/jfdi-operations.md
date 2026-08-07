# How JFDI runs your project

You are configuring JFDI — an automated implement → review → QA → merge
pipeline — for the project in this repository. You are not building that
project: you are configuring the files under `.jfdi/`, and the project's
AGENTS.md, which will run and guide the agents that do. Everything below is
what those agent sessions experience; every file you touch is a lever on
their behavior.

## The pipeline

JFDI watches a Kanban board (`.jfdi/board.md`). When a card reaches the begin
column, the coordinator dispatches a **run**: an isolated git worktree on
branch `jfdi/<ticket-id>`, and a pipeline of fresh agent sessions —
**Implementation → mechanical gate → Code Review → QA** — with feedback
rounds (cap: `pipeline.max_rounds`, default 3). When both reviews sign off,
**Integration** merges the branch into the target branch: globally serialized,
one merge at a time, landing a merge commit after re-running the gate on the
merged tree. Several runs proceed concurrently (`max_concurrent`), but
integration never does.

## What each session sees — and doesn't

Every stage is a **fresh session with no memory** of the sessions before it.
What it knows is exactly what the pipeline hands it:

- **Implementation** gets the ticket slice — title, description, open
  questions, and prior decisions folded into the note's phase comments — plus
  rules. It never sees another stage's session.
- **Code Review** gets the diff against the target branch, the gate result,
  and the ticket note. It reviews code quality only; behavior is QA's job.
- **QA** gets the ticket and the **sandbox contract** (`.jfdi/sandbox.md`) —
  its *only* knowledge of how to build, launch, and drive this product. It
  derives checks from the ticket, not the diff, and encodes what it verified
  as regression tests.
- The **scribe** (commit-message session) gets the staged diff, the ticket,
  and the completing stage's summary. Read-only, single shot.

The consequence that shapes your whole job: **anything an agent must know
about this project has to live in a file you configure.** The project's
AGENTS.md (read by every session), the stage prompts, the sandbox contract —
there is no other channel. Nothing you say during init reaches future
sessions unless it lands in one of those files.

## The gate

`config.json`'s `gate` is an array of named shell commands; **all must exit
zero.** The pipeline runs it — after every implementation session, after QA
(the tests QA added must pass), and again at integration on the merged tree.
Agents are told not to run it themselves.

A gate failure is cheap by design: it feeds straight back into the same
implementation session (up to 10 fix sessions) *without consuming a round*.
A review failure costs a round. This asymmetry is the point: **the gate is
JFDI's cheapest reviewer**, and every standard you can encode mechanically —
lint rule, type check, format check, naming convention, test suite — is one
that review sessions never spend tokens or rounds on again.

Checks too big for a one-line command live in **`.jfdi/scripts/`** — drop a
script there and reference it from a gate entry (e.g.
`sh .jfdi/scripts/check-docs-sync.sh`). The directory is versioned like the
rest of the JFDI configuration.

Two properties matter when you fill it in: the gate must exit zero at setup
time (a gate that starts red teaches every agent that red is normal), and it
should stay fast — it runs after every code-producing session.

## Verdicts, decisions, observations

Each stage ends by writing a JSON **verdict** to a path its prompt names. The
verdict carries the stage's outcome plus two arrays with fixed roles:

- **`decisions`** — assumptions and judgment calls, logged *before* building
  on them. The pipeline folds them into the ticket note's phase comment, so
  later stages and humans see why choices were made. The working posture is
  **decide, log, proceed**; escalation is a last resort and must carry a
  recommended answer.
- **`observations`** — out-of-scope issues noticed in passing, one line each.
  They become proposal cards in the board's inbox column for a human to
  triage. Agents propose; humans promote. Nothing is ever fixed inline.

## Commits and the ticket note

**Agents never commit and never edit ticket notes.** The pipeline records
HEAD before each session, soft-resets anything the session committed, and
lands exactly one handoff commit per session that changed the worktree — with
a message written by the scribe. Everything a stage wants recorded arrives
through its verdict, which the pipeline folds into one phase comment per
stage and round in the note's `## Comments` trail.

Do not write project docs, prompts, or AGENTS.md text instructing agents to
commit, push, or run the gate — the pipeline owns all three, and contradicting
it just burns sessions on forbidden actions.

## Reviews and sign-offs

Code Review gates QA: a review fail skips the sandbox run. Both sign-offs
bind to a specific commit — any code change after a sign-off re-enters at the
gate and repeats both reviews. Later rounds of the same stage re-enter that
stage's own previous session (continuation) with a short brief, so review
context carries across rounds of one run.

The default configuration deliberately puts Code Review on a different
provider than Implementation: a reviewer that is not the author's own model
does not share the author's blind spots. Preserve that property unless the
human asks otherwise.

## The files you configure

- **`.jfdi/config.json`** — the gate; board path and column names;
  `ticketsDir`; `pipeline.max_rounds`; `integration.target_branch` (never
  assume `main`), `integration.mode` (`on-approval` holds merges for a human,
  `auto` lands them), `integration.remote` (opt-in fetch-before/push-after);
  `permissions.mode` (`auto` = sandboxed autonomous, default; `bypass` =
  opt-in full access); `max_concurrent`; per-stage `stages` entries
  (harness, model, effort per stage plus the scribe).
- **`.jfdi/prompts/*.md`** — the stage prompt templates. Seeded with
  defaults; the on-disk copy is authoritative and user-tunable. This is where
  durable per-project steering for a *stage* belongs. Preserve the `{{VAR}}`
  placeholders: an unknown or dropped variable degrades silently.
- **`.jfdi/sandbox.md`** — the QA sandbox contract. Write it for a stranger
  with no context: exact build and launch commands, expected outputs, scratch
  space rules (always outside the repo), teardown. If QA can't drive the real
  artifact from this file alone, QA validates nothing.
- **`.jfdi/hooks/format.sh`** — post-edit format hook for Claude sessions:
  formats the one file the agent just edited, so sessions never burn turns on
  lint-fix loops. Must always exit 0; a formatter problem must never fail an
  agent's edit. Codex sessions skip it; its absence degrades gracefully.
- **`.jfdi/scripts/`** — gate helper scripts, as above.
- **The project's AGENTS.md** — the agent instructions file at the repo root,
  read by every session of every stage (both Claude Code and Codex honor it).
  This is where the coding guidelines get instantiated for this project's
  language: concrete lint rules (wired into the linter config, not just
  named), an abbreviation allowlist, a glossary with one name per concept.
  Rules a machine can check belong in the gate; AGENTS.md prose is for what
  machines can't check.

## What a good setup optimizes

- **Machines check what machines can check.** Every recurring review nit
  should become a lint rule or gate script, not a prompt sentence.
- **The gate is green at handoff** — every command exits zero the moment you
  finish.
- **The sandbox contract is executable by a stranger.** Test it: could a
  fresh session with zero context drive the product from that file alone?
- **One name per concept.** The glossary you write into AGENTS.md is the
  vocabulary every future session and reviewer will hold the code to.
- **Column names match the human's workflow** — the begin column dispatches
  agent runs, so it should be a column the human consciously moves cards
  into, never a general dumping ground.
