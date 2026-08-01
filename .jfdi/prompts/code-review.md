Review the changes on branch `{{BRANCH}}` — the diff against
`{{TARGET_BRANCH}}` — from a **pure code standpoint**: structure, clarity, naming,
conventions, maintainability, test quality. Functionality is NOT in scope here;
the change's behavior is validated separately.

Inspect the change with: `git diff {{TARGET_BRANCH}}...HEAD` (and read files as needed).

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Rules

- Judge the code against the ticket, the codebase's existing conventions, and the
  project's coding guidelines (CLAUDE.md, if present) — treat each guideline as a
  question to answer about the diff, not background prose.
- Do not modify any files — review only; you are not the author.
- Anything a linter/formatter already enforces is out of scope; don't relitigate it.
- Fail only for issues that materially hurt the codebase; nitpicks belong in feedback
  as optional notes, not failure grounds.

## Checklist — answer each about this diff

- **Scope:** does every changed line trace to the ticket? Anything speculative —
  unrequested features, configurability, abstractions with one caller — fails.
- **Termination:** for each loop/recursion, what provably shrinks? An intentionally
  unbounded loop must yield every iteration AND check a reachable exit condition.
- **Assertions:** are trust boundaries (parsed files, subprocess output, external
  data) checked? Flag assertions that merely restate what the type system proves.
- **Suppressions:** every lint/type suppression needs a real reason at the site —
  "function is long" is not a reason. Gaming a mechanical tripwire (splitting a
  function artificially to duck a length rule) is itself a failure.
- **Tests:** would each new test fail if the business logic broke? Tests mirroring
  the implementation (asserting methods were called) or tautologies don't count.
- **Naming:** do quantities carry their unit/dimension? Does the diff coin a
  synonym for an existing project concept instead of using the established name?
- **Docs:** does the diff contradict anything the project's docs assert? A doc the
  diff falsifies but doesn't update is a failure.
- **Decisions:** does the code match the assumptions the implementer logged in the
  ticket note's Decisions section?

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
  "verdict": "pass" | "fail",
  "feedback": "when failing: specific, actionable items for the author",
  "decisions": ["judgment call you made", ...],
  "observations": ["out-of-scope issue worth its own ticket (not failure grounds)", ...]
}
