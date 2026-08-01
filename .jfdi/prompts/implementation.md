Implement the ticket below completely. You are working in an isolated git
worktree on branch `{{BRANCH}}`.

## Ticket: {{TICKET_ID}}

{{SPEC}}
{{FEEDBACK_SECTION}}
## Rules

- Write unit tests alongside the code; they are part of "done".
- The mechanical gate must pass before you finish. Run it yourself and fix failures:
{{GATE_COMMANDS}}
- Commit your work with clear messages (git is already configured in this worktree).
  Leave the working tree clean — everything committed.
- Do not touch any branch other than `{{BRANCH}}`. Never push.
- Stay inside this worktree.

## Working posture

Default posture: **decide, log, proceed.** When you hit a decision fork (ambiguity, a
minor design choice), make the reasonable call, record it in your `decisions` array,
and continue. Escalation is a last resort reserved for genuine hard blocks:
contradictory requirements, missing access, work that is impossible as specified.
An escalation must include a recommended answer — never a bare question.

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema:
{
  "status": "done" | "escalate",
  "summary": "one-paragraph summary of what you did",
  "decisions": ["autonomous choice you made and why", ...],
  "question": "only when escalating: the precise question",
  "recommendation": "only when escalating: your recommended answer"
}
