Your QA session is being continued: the branch has new commits since the
commit you last validated ({{LAST_SEEN_COMMIT}}).

{{PROVENANCE}}

## What changed since your last validation

{{GATE_RESULT}}

New commits:

{{NEW_COMMITS}}

Files touched:

{{TOUCHED_FILES}}

## Your job now

Re-validate the behavior against the ticket, per your original instructions and the
sandbox contract you already have. Commit any new or updated regression tests. Do NOT
re-run the full mechanical gate — the pipeline re-runs it after your session. Your
sign-off binds to the current HEAD ({{HEAD_COMMIT}}).

## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.

Schema (same as your previous verdict):
{
  "verdict": "pass" | "fail" | "escalate",
  "feedback": "when failing: what behavior is wrong or missing, with reproduction steps",
  "testsAdded": "summary of the automated tests you committed this round",
  "decisions": ["judgment call you made", ...],
  "observations": ["out-of-scope problem you noticed (not grounds for this verdict)", ...],
  "question": "only when escalating",
  "recommendation": "only when escalating: your recommended answer"
}
