# The Pipeline

This page explains what happens between "a ticket is dispatched" and "the work is
merged (or blocked)": the stages, the mechanical gate, feedback rounds, escalation,
and how an interrupted run resumes. It describes the system as built — the
authoritative behavior lives in [src/pipeline.ts](../../src/pipeline.ts).

For how tickets get *onto* the pipeline (boards, cards, the coordinator), see
[Board & Tickets](board-and-tickets.md) and [Integration & Merging](integration.md)
for what happens after it passes.

## Overview

Every ticket runs in its own **git worktree** on branch `jfdi/<ticket-id>`, created
from the integration target branch. Inside that worktree, up to `pipeline.max_rounds`
**rounds** run (default 3). Each round is:

```mermaid
flowchart TD
    IMPL[Implementation session] --> CHK[Pipeline commits<br/>the session's handoff]
    CHK -->|status: done| GATE{Mechanical gate}
    CHK -->|status: escalate| BLOCKED([Card → Blocked])
    GATE -->|fail| RETRY([Next round:<br/>feedback → Implementation])
    GATE -->|pass| CR[Code Review session]
    CR -->|fail| RETRY
    CR -->|pass| QA[QA session]
    QA --> QACOMMIT[Pipeline commits QA's tests,<br/>if it wrote any]
    QACOMMIT -->|fail| RETRY
    QACOMMIT -->|escalate| BLOCKED
    QACOMMIT -->|pass| GATE2{Gate again,<br/>if QA committed}
    GATE2 -->|fail| RETRY
    GATE2 -->|pass| PASSED([Pipeline passed →<br/>Integration])
```

Three properties are worth internalizing:

- **Every failure re-enters at Implementation.** There is no partial re-entry: a
  Code Review fail, a QA fail, or a gate fail all start the next round at the top.
  Both review sign-offs bind to a specific commit, so any code change invalidates
  both and the new commit repeats the gate and both reviews.
- **Code Review gates QA.** A round where Code Review fails never runs the sandbox —
  the cheap review screens the expensive one.
- **The gate is the cheapest reviewer and always runs first.** Reviews spend agent
  tokens only on what machines can't check.
- **The pipeline owns the commits.** No stage commits its own work; the pipeline
  commits once per session, and the sign-offs bind to *that* commit. See
  [Commits and the scribe](#commits-and-the-scribe).

## Stages

Each stage is one agent session — Claude Code or Codex, with whatever model and
effort that stage's [`stages` entry](configuration.md#stages) names — spawned
headless in the ticket's worktree with a stage-specific prompt. Stages need not
agree: the scaffolded default deliberately reviews on a different provider than
it implements on. The prompt templates live in `.jfdi/prompts/` and are yours to
edit — see [Prompts & Customization](prompts-and-customization.md).

| Stage | Job | Can escalate? |
|---|---|---|
| **Implementation** | Does the work, writes unit tests alongside the code, runs the gate itself before finishing. | Yes |
| **Code Review** | Judges the diff on structure, clarity, conventions, and maintainability — *not* functionality. | No — an attempted escalation is treated as an invalid verdict and costs a round |
| **QA** | Exercises the built artifact per the [sandbox contract](prompts-and-customization.md#the-sandbox-contract), validates behavior against the *ticket* (not the diff), and writes what it verified as automated regression tests. | Yes |

Integration is the fourth agent, but it is owned by the coordinator, not the ticket
pipeline — see [Integration & Merging](integration.md).

### What each stage sees

The pipeline does the mechanical work outside sessions so agents don't burn turns
collecting context:

- **Implementation** gets the ticket spec, the branch and target branch names, the
  gate command list, and — when relevant — a resume section (see
  [Resuming](#resuming-an-interrupted-run)) and the accumulated feedback from
  earlier attempts.
- **Code Review** gets the ticket note path, the passing gate summary (and is told
  to trust it, never re-run it), the commit log and diffstat against the target
  branch, and the full diff inline when it fits (up to 40,000 characters — larger
  diffs are read per-file inside the session).
- **QA** gets the ticket note path, the sandbox contract, the gate summary, the
  commit log and diffstat — deliberately **not** the diff. QA derives its checks
  from the ticket, adversarially, so it can catch what the implementation missed
  rather than confirming what it did.

### Verdicts

Every session must end by writing a single JSON verdict file at a path the prompt
names (`<state dir>/runs/<ticket-id>/run-<k>/round-<n>/<stage>.verdict.json`). The
pipeline reads outcomes *only* from this file:

```jsonc
// Implementation
{ "status": "done" | "escalate",
  "summary": "…", "decisions": ["…"], "observations": ["…"],
  "question": "only when escalating", "recommendation": "only when escalating" }

// Code Review
{ "verdict": "pass" | "fail",
  "feedback": "when failing: specific, actionable items",
  "decisions": ["…"], "observations": ["…"] }

// QA
{ "verdict": "pass" | "fail" | "escalate",
  "feedback": "when failing: what's wrong, with reproduction steps",
  "testsAdded": "summary of the tests it wrote",
  "decisions": ["…"], "observations": ["…"],
  "question": "…", "recommendation": "…" }
```

A missing or malformed verdict file is not fatal: the stage is treated as "did not
produce a valid verdict" and the round retries with that as feedback (a markdown
code fence around the JSON is tolerated). Two of the fields matter beyond
pass/fail:

- **`decisions`** — autonomous choices the agent made, each appended to the
  ticket note's `## Comments` trail as a
  [decision entry](board-and-tickets.md#ticket-notes) stamped with stage and
  round. This is the audit trail for the decide-log-proceed posture, and the one
  part of the trail later stages read back.
- **`observations`** — out-of-scope issues the agent noticed (pre-existing bugs,
  dead code, tooling gaps). Never fixed inline; after a passing run they become
  proposal cards in the board's **Inbox** column, deduplicated by text and tagged
  `*(from <ticket-id>)*`. Agents propose; humans promote.

## Commits and the scribe

**Agents never commit. The pipeline commits once per session.** Message quality
used to vary by provider, and a session that died before its own commit lost its
work silently. Both are gone: the pipeline records HEAD before each session and,
when the session ends, folds whatever it left into exactly one commit.

- **Enforcement is mechanical, not prompt-hope.** A session that commits anyway
  is `git reset --soft` back to the pre-session HEAD, so its commits become
  staged changes and the pipeline's single commit takes their place. Reviewers
  are reset harder still: a Code Review session never moves the branch.
- **Failed and interrupted sessions commit too** — every session end, success or
  not. The message carries a `WIP —` subject marker and the reason. This is what
  makes [resuming](#resuming-an-interrupted-run) reliable: sanitization discards
  uncommitted changes, so partial work has to live in a commit.
- **A session that changed nothing produces no commit.** A normal review, or a
  passing QA that wrote no tests, leaves the branch alone; its outcome reaches
  the ticket note as a comment instead.

The message is written by the **scribe**: a cheap, read-only, single-shot
session, selected by the [`stages["commit-message"]`](configuration.md#stages)
entry. The pipeline hands it the staged diff, the ticket, the stage's own
summary — the "why" the diff can't carry — and the round. It is not a stage: no
verdict, no round of its own, no sign-off.

The shape:

```
<ticket-id>: <imperative summary, ≤72 chars>

<body, written for a reader with zero context who was not in the session>

JFDI <Stage> <outcome> — <where the run actually went>
JFDI-Round: <n>/<max>
```

The scribe writes the subject and body only. The status line and the trailer are
appended by the pipeline, so they never depend on an agent getting a format
right: `git log --format='%(trailers:key=JFDI-Round)'` always answers.

What comes back is subprocess output on its way into permanent history, so the
pipeline enforces the rest of the shape rather than trusting it. A first line
longer than 72 characters is not a subject: it is kept as body text under a
plain subject the pipeline writes itself. A body long enough to be an echo of
the diff is cut with a visible marker. Control characters git or a terminal
would choke on are stripped from the assembled message — not just from the
scribe's answer, since the stage's summary and an interrupted session's quoted
reason are agent and subprocess text too — and anything that has to stay on one
line, the status line included, is flattened to one. A scribe that dies or
answers with nothing degrades to the stage's own summary — the commit is never
delayed for prose — and says so on the event stream.

### The comment trail

Every transition is also appended to the ticket note's `## Comments` section, so
`git log` and the note each tell the story on their own. For a commit, the entry
is the rendered message **verbatim** — one rendering, two surfaces. The trail
covers:

| Transition | Entry |
|---|---|
| dispatch | "JFDI run started — round 1, branch jfdi/&lt;id&gt;" |
| an implementation or fix session | the commit's message |
| a review verdict | "JFDI Code Review PASSED — moving to QA", or FAILED followed by the exact feedback the implementer received; the same for QA |
| rounds exhausted | "JFDI run exhausted its N rounds — moving to Blocked for human review", with the round history |
| integration | "JFDI Integration merged — landed on main as &lt;sha&gt;", or blocked with the reason |
| a decision | one entry per `decisions` item, in the [decision format](board-and-tickets.md#ticket-notes) |

Two deliberate absences: **no comment for a pause** — infrastructure holds are
not ticket history — and agents never write the note themselves. Every append is
pipeline-owned and atomic (read → mtime check → temp-file rename, following
symlinks to the real file), so a human editing the note in Obsidian mid-run
loses nothing.

## The mechanical gate

The gate is the ordered list of shell commands in `config.json`'s `gate` array
(build, test, lint — whatever must exit zero). Commands run sequentially in the
worktree via `/bin/sh -c`, stopping at the first failure; the failing command's
interleaved output (last 20,000 characters) becomes the feedback for the next
round.

The gate runs at five points:

1. After Implementation hands off and the pipeline commits it, before Code Review
   ("done" isn't done until it passes)
2. After the pipeline commits QA's tests, if it wrote any (QA's own tests must pass too)
3. During integration, after a clean merge, pre-land
4. During integration, after agent-driven conflict resolution
5. During integration, after re-QA on a complicated merge

An empty `gate` array always passes — `jfdi init` exists to make sure you never
run with one. Reviewers are shown the gate's passing summary and told not to
re-run it; QA runs only the tests it adds.

## Rounds and feedback

A **round** is one trip through the flowchart above. When any step fails, the
pipeline records a feedback item — `{run, round, source, feedback}` where source is
`gate`, `code-review`, `qa`, or `implementation` — and starts the next round.
When rounds are exhausted, the card moves to **Blocked** and the round history is
written into the ticket note's `## Questions` section with instructions for
retrying.

### Fresh sessions vs. continuations

Round 1 of every stage is always a **fresh** session — the independence of fresh
eyes is the point of the review stages. Later rounds of the *same run* **continue**
the stage's own previous session (`claude -p --resume` / `codex exec resume`) with
a short brief instead of paying a fresh session to re-derive context it already
had:

- A continued **Implementation** session gets just the failure: the gate output, or
  the reviewer's items, framed by who produced them.
- A continued **reviewer** gets the delta since its last look — new commits and
  touched files — plus *provenance*: a reviewer who passed last round is told the
  new commits answer QA's feedback (quoted), not its own sign-off, so it doesn't
  re-litigate what it already approved.
- A continued **QA** session is told its own previous feedback is the checklist:
  verify each reported failure is fixed and re-run enough earlier checks to catch
  regressions.

If the provider has forgotten the session, the stage falls back to exactly one
fresh session with the full prompt and accumulated feedback. Session memory is
per-run and in-memory only: a re-dispatch always starts every stage fresh.

## When the provider goes down

A session can also die for a reason that has nothing to do with the work: a
usage limit, an expired login, a 5xx. Treating that as feedback would be a
disaster — the next round spawns into the same wall, `max_rounds` burns in
seconds, and the coordinator moves on to drain the rest of the board the same
way. So it isn't feedback. The harness classifies it
([how](../architecture/harness.md#failure-classification)), and the tool stops.

**The run holds where it stands.** No round is consumed, no feedback is
invented, the card stays in **In Progress**, and the in-memory state — round
counter, feedback history, session memory — is untouched. When the pause lifts,
the same stage runs again: continuing its session if one was captured,
otherwise a fresh spawn with the same prompt.

**The pause is global.** One failure stops everything: no new dispatches, and
every in-flight pipeline holds at its next stage boundary. `jfdi run` uses the
identical code path and behaves identically. *Nothing lands in Blocked for an
infrastructure reason.*

What lifts it depends on the class:

| Class | What it is | What resumes it |
|---|---|---|
| **usage-limit** | quota exhausted | the stated reset time plus a minute's slack, automatically. No human needed. If the provider named no time we could read, the outage schedule below is used instead — a limit self-expires, so it never demands a keypress. |
| **outage** | 5xx, network, capacity | three stage-local retries first (5 s, 20 s, 60 s); still failing, it escalates to a global pause that re-probes on a stepped, capped backoff (1 min, 5 min, then every 15 min). Resumes by itself when the provider recovers. |
| **needs-human** | expired login, revoked key, out of credits | **nothing automatic.** The banner names the repair and waits. |

`R` retries immediately in every case — that is the only way out of a
needs-human pause, and a way to skip the wait in the others. In the TUI it is a
keypress; `jfdi run` takes the same key on its terminal, and prints the pause
reason and resume time as it goes. A session that reaches the provider resets
the backoff to its first step.

The pause is announced on the event stream as `harness_paused` /
`harness_resumed`, carrying `{kind, detail, resumesAt?}`, which is what the TUI
banner renders. It is deliberately **not** persisted: a pause is a fact about
the provider right now, not about the run. Stopping JFDI and starting it again
is not an event — see
[after a stop](board-and-tickets.md#stopping-and-restarting).

## Escalation and Blocked

The default posture is **decide, log, proceed**: at a decision fork the agent makes
the reasonable call, records it as a decision comment, and continues. Escalation is
prompted as a last resort for genuine hard blocks — contradictory requirements,
missing access, work impossible as specified — and must carry a recommended
answer, never a bare question.

When Implementation or QA escalates:

1. The question and recommendation are appended to the ticket note under
   `## Questions`, dated and stage-tagged, with a footer telling you how to resume.
2. The run ends; the card moves to **Blocked**. The worktree and branch are kept.
3. You answer by **editing the ticket note** and moving the card back to the
   begin column. Write the answer in the **description** or under
   `## Questions` — those are the parts of the note the next session reads (see
   [the slice](board-and-tickets.md#what-the-agents-actually-read)); an answer
   typed into `## Comments` or a section of your own never reaches it. The next
   dispatch resumes from the existing branch with the answer in context.

The safety net for wrong autonomous calls is layered: Code Review and QA judge the
work against the ticket, and the decision log surfaces in the final report before
merge — wrong calls get caught pre-merge without mid-flight interruptions.

Per-ticket override: put `mode: ask` in the ticket note's YAML frontmatter to
lower the escalation bar for tickets where you want check-ins. This reaches the
implementation prompt as an explicit "prefer escalating with a recommendation over
guessing" instruction.

## Resuming an interrupted run

Runs can die mid-pipeline — an escalation, exhausted rounds, a killed session, a
coordinator crash — leaving partial commits and possibly a dirty or mid-merge
worktree. Re-dispatching the card (moving it back to the begin column) reuses the
branch and resumes deliberately:

1. Any in-progress merge is aborted. If git cannot abort it (a stale
   `index.lock`, an unwritable file), the run stops there and the card is
   blocked — dispatching onto a half-merged tree would hand the agent conflict
   markers and commit them.
2. Any uncommitted changes are checkpoint-committed as
   `jfdi(<ticket-id>): recovered from interrupted run`, so the session starts from
   a clean, committed tree. In practice there is rarely anything left to
   recover: the pipeline already committed each session's work as that session
   ended, so what the branch holds is a `WIP —` commit with the reason on it.
3. The Implementation prompt carries a resume section: how many commits the branch
   already holds, a short log, what was recovered — with explicit instructions to
   continue the work, not start over.
4. Unanswered feedback from the previous run (persisted as `history.json` in the
   run directory, capped at the 10 most recent items) is carried into the prompt
   as well.

## Outcomes

A run ends in one of two states:

- **Passed** — every stage signed off on the final commit and the gate is green.
  What happens next depends on `integration.mode`: `auto` merges immediately;
  `on-approval` moves the card to **Ready to Merge** and writes the final report
  (summary, rounds, commit, QA tests added, autonomous decisions) into the ticket
  note for your review. See [Integration & Merging](integration.md).
- **Blocked** — an escalation, exhausted rounds, or a failed integration. The card
  moves to **Blocked**, the reason is in the ticket note, and the worktree is kept
  for inspection. `jfdi run` exits with code 2 in this case.

Either way, the complete paper trail is on disk: the ticket note holds the
human-readable record (`## Comments`, `## Questions`, `## Report`), and the state
directory holds the machine record — per-round verdicts and raw session logs under
`runs/<ticket-id>/run-<k>/`, viewable with `jfdi logs <ticket-id>`. See
[Events & State](../architecture/events-and-state.md) for the full layout.
