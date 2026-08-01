// GENERATED from docs/coding-guidelines.md — do not edit by hand.
// Edit the doc, then run: pnpm sync:guidelines
// (src/guidelines.test.ts fails the gate if the two drift.)

/**
 * The generic, language-agnostic coding guidelines JFDI ships with, compiled in
 * so the installed CLI carries them. Injected into the init prompt so the init
 * agent can instantiate them for a target repo (into its CLAUDE.md and lint
 * config). JFDI's own TypeScript instantiation lives in this repo's CLAUDE.md —
 * keep it in step when a rule changes.
 */
export const CODING_GUIDELINES = `# Coding Guidelines

Language-agnostic rules for codebases where agents are the primary maintainers. Drop this into a project's CLAUDE.md verbatim, or hand it to an agent to instantiate for the local language (concrete lint rules, concrete allowlist, concrete glossary).

Every rule is tagged with its enforcement tier — a rule with no enforcement route is a wish:

- **[M]** mechanical — encoded in the linter/compiler/test runner; the gate catches it
- **[R]** review — a check question the reviewing agent answers about the diff
- **[P]** prompt-time — the implementing agent applies it while writing

JFDI wires these tiers in for you: the gate is tier M, the Code Review stage prompt asks the tier-R check questions, and every stage loads the project's CLAUDE.md for tier P. The design rationale behind the tiers lives with JFDI (docs/agent-enforcement.md).

## Structure and control flow

1. **Every self-repeating construct has a termination measure.** [R]
   For each loop and each recursive call chain, something provably shrinks toward an exit — or an explicit iteration/depth cap exists.
   *Why:* gotos died; runaway repetition didn't.
   *Check:* for each loop or recursion in the diff, name what decreases each pass.

2. **No hot infinite loops — anywhere.** [R]
   A loop either has a provable bound, or it yields every iteration (sleep/await/backoff) **and** checks a reachable exit condition each pass. An exit buried in a branch that can't fire in practice doesn't count.
   *Why:* daemon loops are legitimate; infinite-and-hot is a defect regardless of where it lives.
   *Check:* for each unbounded loop, name its yield and its exit condition.

3. **Long-lived processes bound their memory.** [R]
   Any collection in a long-running process needs an eviction story. Append-only growth per event/request/tick is a leak with a delay.
   *Why:* the modern descendant of "no dynamic allocation" — predictable resource use where uptime is open-ended.
   *Check:* does anything here grow without bound over the process lifetime?

4. **Altitude, not length.** [M tripwire + R]
   A function does one thing at one level of abstraction; its body reads as the steps of that one thing. Length is a smell, not a violation: set a generous mechanical tripwire (~100 lines, warning), and exceeding it requires an annotated suppression stating why the function is better whole. Splitting a function mechanically to duck the number is itself a violation.
   *Why:* hard limits make agents produce \`doThingPart2(a, b, c, d, e, f)\` — technically compliant, strictly worse.
   *Check:* does each function operate at one altitude? Is each length-suppression reason real ("function is long" is not a reason)?

## Errors, assertions, and the type checker

5. **Assert what the checker cannot prove.** [P + R]
   High assertion density at trust boundaries: parsed files, network/subprocess output, anything a human co-edits. Assert cross-call invariants and exhaustiveness. An assertion the type system already guarantees is noise (\`assert(true)\` in modern dress). Impossible states get an assertion, not a recovery path — one line that documents the impossibility beats a handler branch for a state that can't occur.
   *Check:* is every trust boundary in the diff asserted? Does any assertion merely restate a type?

6. **Every asynchronous result is handled.** [M]
   Awaited, or explicitly and visibly detached. No fire-and-forget.
   *Why:* the async-era version of "check your return values."

7. **No swallowed errors.** [M + R]
   Empty catch blocks are banned. Catch-log-and-continue is legal only when the degradation is deliberate and stated.
   *Check:* for each catch block, what happens next, and is that a decision or an accident?

8. **Zero warnings.** [M + R]
   The gate exits clean. Suppressions are legal only with a stated reason at the site — and suppression reasons are first-class review targets; a junk justification is a review failure.
   *Why:* without the justification rule, "zero warnings" degrades into "zero unsuppressed warnings."

9. **Don't hide code from the checker.** [M]
   No \`any\`-equivalents, no bare ignore-pragmas, no eval-adjacent tricks that blind static analysis. Escape hatches require the same stated-reason treatment as suppressions.

## Data

10. **Smallest scope; no module-level mutable state.** [M partial + R]
    Declare at the narrowest scope that works; export the narrowest surface. Module-level mutable state needs an explicit, stated reason to exist.

11. **Don't mutate what you didn't make.** [R]
    Treat arguments and shared objects as immutable; return new values or make ownership transfer explicit.
    *Why:* mutation-at-a-distance is the garbage-collected language's pointer aliasing bug.

## Naming

12. **Quantities carry their dimension.** [R]
    \`timeoutMs\`, \`delaySeconds\`, \`sizeBytes\`, \`balanceDollars\` — and the sneaky one, fraction vs. percent (\`0.15\` vs \`15\`). Convert once, at the boundary, and name the result; no unlabeled numbers in flight.
    *Why:* Mars Climate Orbiter. \`AltitudeMiles\` doesn't crash into \`AltitudeKm\`.
    *Check:* does every dimensioned quantity's name state its unit?

13. **Name length scales with scope.** [R; M via min-identifier-length lint where available]
    Single-letter names are permitted only for: (a) a lambda parameter whose entire scope is one expression, (b) conventional numeric loop indices (\`i\`, \`j\`), (c) \`_\` for explicitly discarded values. Everywhere else, whole words.

14. **No abbreviations outside the allowlist.** [R]
    Allowlist: \`id\`, \`min\`, \`max\`, \`args\`, \`config\`, standard acronyms (\`URL\`, \`JSON\`, \`HTTP\`, \`API\`, \`CLI\`), and identifiers a framework imposes at its boundary. Everything else is spelled out — \`error\` not \`err\`, \`context\` not \`ctx\`, \`request\` not \`req\`. The list grows only by editing this document.
    *Why:* every abbreviation is clear to its author; an allowlist removes the judgment call entirely.

15. **Booleans are positive predicates.** [R]
    \`isReady\`, \`hasMerged\`, \`shouldRetry\`. Never a bare noun holding a boolean (\`status\`, \`flag\`), never a negated name (\`notReady\`, \`disabled\`) — \`!notReady\` is where 2 a.m. bugs live.

16. **Collections plural, elements singular.** [R]
    \`vessels\` / \`vessel\`; the element name is the singular of its collection. Dissolves most of the single-letter temptation for free.

17. **One name per concept.** [R]
    The project keeps a glossary; use its terms exactly and introduce no synonyms. Don't let \`fetch\`/\`get\`/\`retrieve\` or \`ticket\`/\`card\`/\`issue\` coexist for one thing.
    *Why:* every fresh agent session re-derives vocabulary; without a glossary, synonyms accrete every run.
    *Check:* does the diff use any concept-word not in the glossary?

## Conduct — how to work

18. **Decide, log, proceed.** [P + R]
    State assumptions and interpretation choices in the decision log *before* implementing. Never pick between plausible readings silently. Escalate only when genuinely blocked, and always with a recommended answer.
    *Why:* the log replaces the conversation — the human still sees every judgment call, just asynchronously.
    *Check:* does the diff match the stated assumptions?

19. **Simplicity first.** [P + R]
    Minimum code that solves the stated problem. No speculative features, no abstractions for single-use code, no unrequested configurability, no handling for impossible scenarios (those get assertions — rule 5).
    *Check:* identify anything in this diff not required by the request. Anything found fails.

20. **Surgical changes.** [P + R]
    Every changed line traces to the request. Clean up orphans *your* change created (now-unused imports, variables, functions); don't touch pre-existing mess — flag it through the project's proposal channel instead. Exception: docs your change falsified are your mess (rule 26).
    *Why:* scope creep doesn't just risk breakage — it destroys the reviewer's ability to reason about the diff.
    *Check:* trace each changed line to the request.

21. **Prove the bug before fixing it.** [P + R]
    Bug fixes start with a failing test that reproduces the defect; the fix makes it pass. Skipping the repro (genuinely hard cases: races, rendering) requires a logged reason.
    *Why:* the failing test proves the diagnosis before any code changes; the passing test proves the fix; the regression test is free.

22. **Surface conflicts; never average them.** [P + R]
    When two existing patterns contradict, pick one (more recent, better tested), log why, and flag the loser for cleanup. Never blend them into a third pattern that matches nothing. Same rule at personal scale: convention beats taste — follow the codebase's style even where you disagree, and surface the disagreement rather than silently forking it.

23. **Tests verify intent, not implementation.** [R]
    *Check:* would this test fail if the business logic broke? Tests that mirror the implementation (mock everything, assert methods were called) and tautologies fail this question.

24. **Commit at coherent working states.** [P]
    Never hand off with uncommitted changes. Intermediate commits are recovery points — reset beats hand-unwinding. Fix-round commits are *new* commits; never amend or squash while a review is in flight, so reviewers can diff exactly what changed since their sign-off.

25. **Fail loud.** [M partial + R]
    "Completed" is false if anything was skipped silently; "tests pass" is false if any were skipped. Completion claims must match actual gate output. Anything skipped, stubbed, or degraded is stated prominently in the report, not buried. Mechanically: lint bans focused/skipped tests from landing.
    *Why:* in an interactive session a silent skip costs an afternoon; in an autonomous pipeline it corrupts the main branch.

## Documentation

26. **Record what the code cannot say.** [P + R]
    Docs carry intent, decisions, vocabulary, and invariants — never restatements of structure the repo can answer itself (any doc derivable from the code is a cache with no invalidation). If your change falsifies a doc — glossary, invariant, guide — updating it is part of your diff, not a separate task.
    *Check:* does the diff contradict anything the project's docs assert?
`;
