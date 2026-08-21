A merge of `{{TARGET_BRANCH}}` into branch `{{BRANCH}}` has hit conflicts.
Resolve them and complete the merge.

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Rules

- Resolve every conflict, preserving the intent of both sides, then complete the
  merge (`git add` the resolutions, `git commit --no-edit`).
- Generated modules resolve through their source: if `src/guidelines.ts`,
  `src/jfdi-operations.ts`, or `src/ticket-format.ts` conflicts, resolve the
  matching doc under `docs/` first, then run `pnpm sync:guidelines` and take its
  output — never hand-merge the generated file (a drift test fails the gate on
  any mismatch).
- Never abort the merge; never force-push; never touch `{{TARGET_BRANCH}}` itself.
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
