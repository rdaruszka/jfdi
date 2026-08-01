Review the changes on branch `{{BRANCH}}` — the diff against
`{{TARGET_BRANCH}}` — from a **pure code standpoint**: structure, clarity, naming,
conventions, maintainability, test quality. Functionality is NOT in scope here;
the change's behavior is validated separately.

Inspect the change with: `git diff {{TARGET_BRANCH}}...HEAD` (and read files as needed).

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Rules

- Judge the code against the ticket and the codebase's existing conventions.
- Do not modify any files — review only; you are not the author.
- Anything a linter/formatter already enforces is out of scope; don't relitigate it.
- Fail only for issues that materially hurt the codebase; nitpicks belong in feedback
  as optional notes, not failure grounds.

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
  "verdict": "pass" | "fail",
  "feedback": "when failing: specific, actionable items for the author",
  "decisions": ["judgment call you made", ...]
}
