# How the workflow runs your project

Everything below is what the workflow's agent sessions experience when they
work on this project. Every file you configure is a lever on their behavior —
and there is no other channel: nothing reaches those sessions except what
lands in the files described here.

## The pipeline

The workflow watches a Kanban board (`.jfdi/board.md`). When a card reaches
the begin column, the coordinator dispatches a **run**: an isolated git
worktree on its own branch, and a pipeline of fresh agent sessions —
**Implementation → mechanical gate → Code Review → QA** — with feedback
rounds bounded by per-reviewer rejection budgets (`pipeline.maxRejections`;
Code Review 2 and QA 1 by default, for a derived ceiling of 4 rounds). When both
reviews sign off,
**Integration** merges the branch into the target branch: globally
serialized, one merge at a time, landing a merge commit after re-running the
gate on the merged tree. Several runs proceed concurrently
(`maxConcurrent`), but integration never does.

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
about this project has to live in a file you configure.** The project's agent
instructions (read by every session), the stage prompts, the sandbox contract —
there is no other channel. Nothing you learn during setup reaches future
sessions unless it lands in one of those files. The agent instructions must
point ticket-writing agents to `.jfdi/ticket-format.md` before they create or
change a card or ticket.

## The gate

`config.json`'s `gate` is an array of named shell commands; **all must exit
zero.** The pipeline runs it — after every implementation session, after QA
(the tests QA added must pass), and again at integration on the merged tree.
Agents are told not to run it themselves.

A gate failure is cheap by design: it feeds straight back into the session
whose handoff made it red (up to 3 fix sessions) *without consuming a round*.
After Implementation, that means its own session. After QA adds tests, QA gets
the failed step and output and fixes only paths from its initial handoff; the
pipeline checks that path scope before preserving both existing sign-offs. A
wider QA change consumes the round. A gate still red on its fourth attempt
blocks directly. A review rejection costs a round and counts only against that
reviewer's budget; a pass is free. This asymmetry is the point: **the gate is
the workflow's cheapest reviewer**, and every standard you can encode
mechanically — lint rule, type check, format check, naming convention, test
suite — is one that review sessions never spend tokens or rounds on again.

Checks too big for a one-line command live in **`.jfdi/scripts/`** — drop a
script there and reference it from a gate entry (e.g.
`sh .jfdi/scripts/check-docs-sync.sh`). The directory is versioned like the
rest of the workflow configuration.

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
stage and round in the note's `## Comments` trail. Gate-fix commit messages
stay inside that stage's one comment; QA's status names the red step and fix
count.

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

`config.json` keys are exactly the camelCase keys shown below. Adapt the
values to the project, but preserve this structure and the kebab-case stage
identifiers. In particular, every gate entry has exactly `name` and `command`:

```json
{
  "board": {
    "path": ".jfdi/board.md",
    "columns": {
      "begin": "Ready",
      "inProgress": "In Progress",
      "done": "Done",
      "blocked": "Blocked",
      "readyToMerge": "Ready to Merge",
      "inbox": "Inbox"
    }
  },
  "ticketsDirectory": ".jfdi/tickets",
  "gate": [
    { "name": "build", "command": "pnpm build" },
    { "name": "test", "command": "pnpm test" },
    { "name": "lint", "command": "pnpm lint" }
  ],
  "pipeline": { "maxRejections": { "code-review": 2, "qa": 1 } },
  "integration": {
    "targetBranch": "main",
    "mode": "on-approval",
    "remote": { "fetchBefore": false, "pushAfter": false }
  },
  "permissions": { "mode": "auto" },
  "frontEnd": "terminal",
  "maxConcurrent": 2,
  "stages": {
    "implementation": { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
    "code-review": { "harness": "codex", "model": "gpt-5.6-sol", "effort": "high" },
    "qa": { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
    "integration": { "harness": "claude", "model": "claude-opus-4-8", "effort": "medium" },
    "commit-message": { "harness": "claude", "model": "claude-sonnet-5" }
  }
}
```

Older projects may contain the legacy spellings `cmd`, `ticketsDir`,
`target_branch`, `fetch_before`, `push_after`, and
`max_concurrent`. They remain readable, but whenever setup touches
`config.json`, normalize every legacy spelling to its canonical key above.
The removed `pipeline.maxRounds` and `pipeline.max_rounds` keys are not
readable; `jfdi update-config` removes them without inventing a rejection
mapping, after which the reviewer budgets can be configured explicitly.

- **`.jfdi/config.json`** — the gate; board path and column names;
  `ticketsDirectory`; `pipeline.maxRejections`; `integration.targetBranch` (never
  assume `main`), `integration.mode` (`on-approval` holds merges for a human,
  `auto` lands them), `integration.remote` (opt-in fetch-before/push-after);
  `permissions.mode` (`auto` = sandboxed autonomous, default; `bypass` =
  opt-in full access); `frontEnd` (`terminal` by default, or local `web`;
  `jfdi start --front-end` overrides it for one invocation);
  `maxConcurrent`; per-stage `stages` entries
  (harness, model, effort per stage plus the scribe).
  Setup does not require this file to be valid: when it cannot load, the setup
  command warns, runs its session with sandboxed `auto` permissions, and puts
  the load error in the opening message so you can repair the file. A config
  that still cannot load after the session fails the gate epilogue.
  The web front end's Settings panel is the only browser write surface. It
  stages the complete config until Save; Cancel discards, and Reload re-reads
  disk without applying. Save uses the normal whole-config validation, refuses
  when the file changed since load, writes atomically, and then applies values
  to the running coordinator. Capacity and gate changes take effect at the next
  dispatch or gate boundary. Each stage locks its agent selection when it first
  fires in a run, and `frontEnd` changes require a restart.
- **`.jfdi/prompts/*.md`** — the stage prompt templates, seeded as generic
  defaults at setup. Setup builds every one of them into this project's own
  prompt: each carries what its stage needs to know about *this* project —
  what Implementation should watch for, what Code Review should question,
  what QA should distrust and how to exercise it. Global conventions live in
  AGENTS.md; stage-specific knowledge lives in the stage's prompt. The
  on-disk copy is authoritative and user-tunable afterwards. Preserve every
  `{{VAR}}` placeholder and each verdict-schema block exactly as seeded: the
  pipeline substitutes the variables and parses the verdicts, and an unknown
  or dropped variable degrades silently.
- **`.jfdi/sandbox.md`** — the QA sandbox contract. Write it for a stranger
  with no context: exact build and launch commands, expected outputs, scratch
  space rules (always outside the repo), teardown. If QA can't drive the real
  artifact from this file alone, QA validates nothing.
- **`.jfdi/ticket-format.md`** — the shipped, project-local contract for
  creating cards and tickets. It defines ticket anatomy, user-facing acceptance
  criteria, safe board columns, and the ready-for-work checklist. Do not rewrite
  it during setup; make the project's agent instructions link to it as required
  reading before creating or changing a card or ticket.
- **`.jfdi/hooks/format.sh`** — post-edit format hook for Claude sessions:
  formats the one file the agent just edited, so sessions never burn turns on
  lint-fix loops. Must always exit 0; a formatter problem must never fail an
  agent's edit. Codex sessions skip it; its absence degrades gracefully.
- **`.jfdi/scripts/`** — gate helper scripts, as above.
- **The project's AGENTS.md (or established equivalent)** — the agent
  instructions file at the repo root, read by every session of every stage.
  This is where the coding guidelines get instantiated for this project's
  language: concrete lint rules (wired into the linter config, not just named),
  an abbreviation allowlist, a glossary with one name per concept. It must also
  require reading `.jfdi/ticket-format.md` before creating or changing a card
  or ticket. Rules a machine can check belong in the gate; agent-instructions
  prose is for what machines can't check.

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
