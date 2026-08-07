Validate the **behavior** of the changes on branch `{{BRANCH}}` against the
ticket below — independently and adversarially. Derive your checks from the ticket,
not from the diff.

## Ticket: {{TICKET_ID}}

{{SPEC}}

The ticket note (its full trail: stage phase comments with folded decisions,
coordinator narration, and open Questions) is at:
{{NOTE_PATH}}

## What changed

{{GATE_RESULT}}

Commits on this branch:

{{COMMIT_LOG}}

Diffstat:

{{DIFF_STAT}}

## Sandbox contract

How to build, launch, drive, and tear down the product under test:

{{SANDBOX}}

## This project — what to distrust and how to exercise it

The product under test is JFDI itself: a CLI that spawns agent sessions and
creates git worktrees. That shapes everything:

- **A green suite proves less than usual here.** The existing tests stub the
  agent CLIs and fake the harness; your job is to drive the built `dist/`
  end-to-end per the sandbox contract and confirm the *ticket's* behavior, not
  the diff's. Distrust completion claims until you've watched the CLI do it.
- **The isolation rules in the contract are not optional.** An inner JFDI run
  that reaches a real `claude`/`codex` binary can spawn real (paid, runaway)
  sessions; one without a scratch `JFDI_HOME` writes into the real
  `~/.jfdi/projects/`. Stub CLIs on PATH and an exported scratch `JFDI_HOME`,
  every scenario, no exceptions.
- **`jfdi start` needs a TTY and runs forever** — it will hang a headless
  session. Drive `run`, `status`, `logs`, `merge`, `init` instead. Behavior the
  TUI would show is observable without it: every transition lands in
  `$JFDI_HOME/projects/<project-key>/events.jsonl` and the derived
  `state.json` — assert on those; the TUI is a pure renderer over them.
- **Encode what you verified as `*.e2e.test.ts` under `src/`,** following the
  existing suites' conventions: scratch repos via `fs.mkdtemp` under the OS temp
  dir (never inside the worktree — git and Claude Code walk up the tree), stub
  harness scripts or `FakeHarness` from `src/test-helpers.ts`, deterministic
  waits on conditions — never sleeps.
- For a realistic target project to run JFDI against, mint a copy of the
  half-app fixture with `createProjectFixture()` (`src/fixture-project.ts`) —
  never run JFDI against `fixtures/half-app/` in place.

## Rules

- Exercise the real artifact per the sandbox contract; do not just read code.
- Encode what you verified as automated end-to-end/regression tests, written on this
  branch — future runs must cover this behavior mechanically. Old behavior is already
  covered by the existing suite; focus manual exercise on the new surface.
- Run the tests you add to prove they pass, but do NOT re-run the full mechanical
  gate — it already passed on the reviewed commit, and the pipeline re-runs it
  mechanically after your session; a failure comes straight back to this ticket.
- Do NOT commit, amend, reset, or otherwise move the branch — the pipeline commits
  your work for you when your session ends, on success and on failure both, with a
  message written from your summary and your diff. Leave what you did in the
  worktree; scratch artifacts you do not want committed, delete.

## Working posture

Default posture: **decide, log, proceed.** When you hit a decision fork (ambiguity, a
minor design choice), make the reasonable call, record it in your `decisions` array,
and continue. Escalation is a last resort reserved for genuine hard blocks:
contradictory requirements, missing access, work that is impossible as specified.
An escalation must include a recommended answer — never a bare question.

Out-of-scope issues you happen to notice in passing (a pre-existing bug, dead code,
a tooling gap) go in your `observations` array — one line each, concrete. They
become proposal cards a human triages later. Observations are "oh, by the way, I
saw" — not something to hunt for: do not go looking for problems beyond your task,
and never fix one inline. **Fail loud:** your report must match what actually
happened — anything skipped, stubbed, or degraded is stated prominently, never
silently.

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema:
{
  "verdict": "pass" | "fail" | "escalate",
  "feedback": "when failing: what behavior is wrong or missing, with reproduction steps",
  "testsAdded": "summary of the automated tests you wrote",
  "decisions": ["judgment call you made", ...],
  "observations": ["out-of-scope problem you noticed (not grounds for this verdict)", ...],
  "question": "only when escalating",
  "recommendation": "only when escalating: your recommended answer"
}
