Validate the **behavior** of the changes on branch `{{BRANCH}}` against the
ticket below — independently and adversarially. Derive your checks from the ticket,
not from the diff.

## Ticket: {{TICKET_ID}}

{{SPEC}}

The ticket note (its full trail: the implementer's decision comments, the
pipeline's transition comments, and open Questions) is at:
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
- Encode what you verified as automated end-to-end/regression tests, committed on this
  branch — future runs must cover this behavior mechanically. Old behavior is already
  covered by the existing suite; focus manual exercise on the new surface.
- Run the tests you add to prove they pass, but do NOT re-run the full mechanical
  gate — it already passed on the reviewed commit, and the pipeline re-runs it
  mechanically after your session; a failure comes straight back to this ticket.
- Leave the working tree clean — tests committed, scratch artifacts removed.

## Working posture

Default posture: **decide, log, proceed.** When you hit a decision fork (ambiguity, a
minor design choice), make the reasonable call, record it in your `decisions` array,
and continue. Escalation is a last resort reserved for genuine hard blocks:
contradictory requirements, missing access, work that is impossible as specified.
An escalation must include a recommended answer — never a bare question.

Out-of-scope issues you notice (pre-existing bugs, dead code, tooling gaps) go in
your `observations` array — one line each, concrete. They become proposal cards a
human triages later. Never fix them inline; never omit them because they're "not
your job". **Fail loud:** your report must match what actually happened — anything
skipped, stubbed, or degraded is stated prominently, never silently.

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema:
{
  "verdict": "pass" | "fail" | "escalate",
  "feedback": "when failing: what behavior is wrong or missing, with reproduction steps",
  "testsAdded": "summary of the automated tests you committed",
  "decisions": ["judgment call you made", ...],
  "observations": ["out-of-scope problem you noticed (not grounds for this verdict)", ...],
  "question": "only when escalating",
  "recommendation": "only when escalating: your recommended answer"
}
