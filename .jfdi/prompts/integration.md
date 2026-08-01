A rebase of branch `{{BRANCH}}` onto `{{TARGET_BRANCH}}` has hit conflicts.
Resolve them and complete the rebase.

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Rules

- Resolve every conflict, preserving the intent of both sides, then continue the
  rebase to completion (`git add` the resolutions, `git rebase --continue`).
- Never abort the rebase; never force-push; never touch `{{TARGET_BRANCH}}` itself.
- Afterwards, judge your own resolution honestly: if you had to touch real logic
  (not adjacent-line noise), report "complicated" — the change will be re-validated.

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema:
{
  "resolution": "clean" | "complicated",
  "notes": "what conflicted and how you resolved it"
}
