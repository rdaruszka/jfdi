Your code-review session is being continued: the branch has new
commits since the commit you last reviewed ({{LAST_SEEN_COMMIT}}).

{{PROVENANCE}}

## What changed since your last review

{{GATE_RESULT}}

New commits:

{{NEW_COMMITS}}

Files touched:

{{TOUCHED_FILES}}

## Your job now

Re-review the branch as it now stands — same standards, same checklist as before. Your
sign-off binds to the current HEAD ({{HEAD_COMMIT}}): judge the full diff against
`{{TARGET_BRANCH}}`, with attention on the new commits. Do not modify any files.

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema (same as your previous verdict):
{
  "verdict": "pass" | "fail",
  "feedback": "when failing: specific, actionable items for the author",
  "decisions": ["judgment call you made", ...],
  "observations": ["out-of-scope issue worth its own ticket (not failure grounds)", ...]
}
