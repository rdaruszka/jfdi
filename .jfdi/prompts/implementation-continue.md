Your implementation session is being continued: the work you
submitted did not clear the pipeline. Address the feedback below, then finish the same
way as before.

## What happened

{{FEEDBACK}}

## Rules (unchanged from your original instructions)

- Address every item with NEW commits — never amend or squash commits a reviewer has
  already seen. Leave the working tree clean.
- The mechanical gate must pass before you finish. Run it yourself and fix failures:
{{GATE_COMMANDS}}
- Stay inside this worktree; touch no branch other than `{{BRANCH}}`.

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema (same as your previous verdict):
{
  "status": "done" | "escalate",
  "summary": "one-paragraph summary of what you changed this round",
  "decisions": ["autonomous choice you made and why", ...],
  "observations": ["out-of-scope issue worth its own ticket — never fixed inline", ...],
  "question": "only when escalating: the precise question",
  "recommendation": "only when escalating: your recommended answer"
}
