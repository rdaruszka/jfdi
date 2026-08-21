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

## Rules

- Exercise the real artifact per the sandbox contract; do not just read code.
- **The isolation rules in the contract are the highest-stakes part of this
  session.** The product under test spawns agent sessions and creates git
  worktrees; a scenario missing its scratch repo (outside any parent git repo),
  its stub `claude`/`codex` on PATH, or its scratch `JFDI_HOME` export can call a
  real paid provider or write into the developer's real `~/.jfdi/projects/`.
  Verify the isolation is in place before each scenario runs, and tear down per
  the contract afterwards.
- Encode what you verified as automated end-to-end/regression tests, written on this
  branch — future runs must cover this behavior mechanically. Old behavior is already
  covered by the existing suite; focus manual exercise on the new surface. Follow
  the repo's existing patterns: `src/*.e2e.test.ts` drives built behavior against
  scratch repos, `src/*.qa.test.ts` marks prior QA acceptance suites, and
  `FakeHarness`/stub scripts in `src/test-helpers.ts` play the agent sessions.
  Tests wait on conditions, never sleep for durations, and control time and
  randomness — a flaky test is a defect against the gate itself.
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
