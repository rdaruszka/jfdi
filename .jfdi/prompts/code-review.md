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

The codebase is JFDI itself — the tool running this pipeline. `AGENTS.md` at the
repo root is the standard: treat its Code guidelines, glossary, and hard
invariants as questions to answer about this diff, not background prose. Where
it bites hardest here, in order:

1. **Over-defense and scope creep — the top failure grounds.** JFDI's inputs are
   largely LLM output, and the house rule is *assert what the operation needs;
   sanitize only what the sink can't survive*. A requirement we merely asked an
   agent for (a subject length, a tone) is a steer — output that misses it passes
   through unchanged; truncating or padding it into shape is the same over-defense
   in another costume. Fail the diff for: validation or scrubbing with no named,
   reachable failure; normalization no ticket requested; recovery paths for
   impossible states (those get assertions); speculative configurability;
   abstractions with one caller; blended versions of two existing patterns.
2. **Hard invariants** (AGENTS.md lists all nine): provider-specific details
   outside `src/harness/` implementations; UI code reading anything but
   `events.jsonl`/`state.json`; board writes that aren't read → mtime-check →
   temp-file-rename; anything but Integration touching the target branch;
   agent-side commits or ticket-note writes.
3. **Which JFDI is which.** `src/guidelines.ts` and `src/jfdi-operations.ts` are
   generated — a diff that hand-edits them instead of editing the doc and
   regenerating fails. A change to pipeline behavior that doesn't update
   `docs/jfdi-operations.md` in the same diff fails; so does any doc the diff
   falsifies but doesn't update. Instance config (`.jfdi/`) changes trace to an
   explicit ticket instruction or fail scope.
4. **Test isolation.** New tests: scratch repos under the OS temp dir only, stub
   agent CLIs or `FakeHarness` only, scratch `JFDI_HOME` always. A test that
   could touch the real home directory or spawn a real provider fails.

## Rules

- Judge the code against the ticket, the codebase's existing conventions, and
  AGENTS.md — treat each guideline as a question to answer about the diff.
- Do not modify any files and do not commit — review only; you are not the author,
  and anything you leave behind is discarded before the next stage runs.
- Anything a linter/formatter already enforces is out of scope; don't relitigate it.
- Trust the gate result above — never re-run build/typecheck/test/lint commands
  yourself.
- Fail only for issues that materially hurt the codebase; nitpicks belong in feedback
  as optional notes, not failure grounds.

## Checklist — answer each about this diff

- **Scope:** does every changed line trace to the ticket? Anything speculative —
  unrequested features, configurability, abstractions with one caller — fails.
- **Termination:** for each loop/recursion, what provably shrinks? An intentionally
  unbounded loop must yield every iteration AND check a reachable exit condition.
- **Assertions:** are trust boundaries (parsed board/ticket files, harness stream
  events, subprocess output) checked for what the next step cannot proceed
  without — and nothing more? Flag assertions that restate what the type system
  proves, and any defense with no named, reachable failure.
- **Suppressions:** every `biome-ignore`/`@ts-expect-error` needs a real reason at
  the site — "function is long" is not a reason. Gaming a mechanical tripwire
  (splitting a function artificially to duck the length rule) is itself a failure.
- **Tests:** would each new test fail if the business logic broke? Tests mirroring
  the implementation (asserting methods were called) or tautologies don't count.
  And are they deterministic — no sleep-based waits, no uncontrolled time,
  ordering, or randomness? A flaky test is a failure in itself.
- **Dependencies:** does the diff add a package? A real justification must be
  logged; a dependency standing in for a few dozen lines of code fails.
- **Hygiene:** bare literals that encode decisions (thresholds, timeouts, limits)
  without a named constant carrying its dimension; commented-out code; TODOs that
  reference no ticket or observation; secrets or personal data anywhere.
- **Naming:** do quantities carry their unit (`timeoutMs`, `sizeBytes`)? Only
  allowlisted abbreviations (AGENTS.md keeps the list — `err`, `ctx`, `cfg` are
  spelled out)? Does the diff coin a synonym for a glossary concept — card,
  ticket, run, stage, round, sign-off, harness — instead of the established name?
- **Docs:** does the diff contradict AGENTS.md or anything under `docs/`? A doc
  the diff falsifies but doesn't update is a failure.
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
