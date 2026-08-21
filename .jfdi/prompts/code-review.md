Review the changes on branch `{{BRANCH}}` — the diff against
`{{TARGET_BRANCH}}` — from a **pure code standpoint**: structure, clarity, naming,
conventions, maintainability, test quality. Functionality is NOT in scope here;
the change's behavior is validated separately.

## Ticket: {{TICKET_ID}}

{{SPEC}}

The ticket note (its full trail: stage phase comments with folded decisions,
coordinator narration, and open Questions) is at:
{{NOTE_PATH}}

## Change under review

{{GATE_RESULT}}

Commits on this branch:

{{COMMIT_LOG}}

Diffstat:

{{DIFF_STAT}}

{{DIFF_SECTION}}

## This project

The code under review is JFDI itself. `AGENTS.md` at the repo root is the
binding standard — its Hard invariants, Glossary, abbreviation allowlist, and
Code guidelines are each a question to answer about this diff, not background
prose. The docs under `docs/` win over AGENTS.md on any conflict.

## Rules

- Judge the code against the ticket, the codebase's existing conventions, and
  AGENTS.md — treat each guideline as a question to answer about the diff.
- Do not modify any files and do not commit — review only; you are not the author,
  and anything you leave behind is discarded before the next stage runs.
- Anything a linter/formatter already enforces is out of scope; don't relitigate it.
  Here that is a lot: biome enforces magic numbers, `any`, suppressed/focused
  tests, unused code, function length, cognitive complexity; sweep tests enforce
  banned abbreviations and dead exports. Spend your session on what they cannot see.
- Trust the gate result above — never re-run build/test/lint commands yourself.
- Fail only for issues that materially hurt the codebase; nitpicks belong in feedback
  as optional notes, not failure grounds.

## Checklist — answer each about this diff

- **Scope:** does every changed line trace to the ticket? Anything speculative —
  unrequested features, configurability, abstractions with one caller — fails.
- **Hard invariants (AGENTS.md):** does the diff keep renderer separation (UI
  renders `events.jsonl`/`state.json` only), the harness abstraction (no provider
  specifics in pipeline logic), serialized integration, atomic surgical board
  writes, pipeline-owned commits and note writes, and configurable target branch
  (never an assumed `main`)? A violation of any invariant fails outright.
- **Over-defense:** JFDI's inputs are largely LLM output. Data the next step
  strictly parses (a JSON verdict shape, an enum switched on) must be enforced;
  a format merely *asked* of an agent (a 72-char subject, a tone) is a steer —
  scrubbing, truncating, or coercing missed steers into shape is over-engineering
  and fails, same as a missing check on a strict contract.
- **Generated modules:** does the diff hand-edit `src/guidelines.ts`,
  `src/jfdi-operations.ts`, or `src/ticket-format.ts` instead of editing the
  `docs/` source and regenerating? That fails (and the drift test would catch it —
  but say so precisely).
- **Termination:** for each loop/recursion, what provably shrinks? An intentionally
  unbounded loop (coordinator, watchers) must yield every iteration AND check a
  reachable exit condition. Long-lived collections need an eviction story.
- **Resources:** every subprocess, watcher, timer, file handle acquired in the
  diff has a paired release on error paths too.
- **Assertions:** are trust boundaries (`board.md` parses, ticket notes, harness
  stream events, subprocess output, anything `JSON.parse`d) checked for what the
  downstream step needs? Flag assertions that merely restate what the type system
  proves.
- **Suppressions:** every `biome-ignore`/`@ts-expect-error` needs a real reason at
  the site — "function is long" is not a reason. Gaming a mechanical tripwire
  (splitting a function artificially to duck a length rule) is itself a failure.
- **Tests:** would each new test fail if the business logic broke? Tests mirroring
  the implementation (asserting methods were called) or tautologies don't count.
  Deterministic — no sleep-based waits, no uncontrolled time, ordering, or
  randomness. Scratch repos under the OS temp dir, never inside this repo; stub
  harnesses/CLIs, never a real provider; a scratch `JFDI_HOME` wherever
  JFDI-under-test runs. A flaky or leaky test is a failure in itself.
- **Dependencies:** does the diff add a package? A real justification must be
  logged; a dependency standing in for a few dozen lines of code fails.
- **Naming:** glossary terms used exactly, no synonyms coined (`ticket` never
  `issue`, `stage` never `phase` for sessions); quantities carry their dimension
  (`timeoutMs`, `sizeBytes`); booleans are positive predicates; abbreviations
  outside the AGENTS.md allowlist fail.
- **Hygiene:** commented-out code; TODOs that reference no ticket or observation;
  secrets or personal data in code, logs, error messages, or fixtures.
- **Docs:** does the diff contradict AGENTS.md, the glossary, or anything under
  `docs/`? Pipeline-behavior changes must update `docs/jfdi-operations.md` in the
  same diff. A doc the diff falsifies but doesn't update is a failure.
- **Decisions:** does the code match the assumptions folded into the
  implementer's phase comment in the ticket note?

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
  "verdict": "pass" | "fail",
  "feedback": "when failing: specific, actionable items for the author",
  "decisions": ["judgment call you made", ...],
  "observations": ["out-of-scope issue worth its own ticket (not failure grounds)", ...]
}
