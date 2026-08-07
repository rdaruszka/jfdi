# Coding Guidelines

Language-agnostic rules for codebases where agents are the primary maintainers. Drop this into a project's AGENTS.md verbatim, or hand it to an agent to instantiate for the local language (concrete lint rules, concrete allowlist, concrete glossary).

Every rule is tagged with its enforcement tier — a rule with no enforcement route is a wish:

- **[M]** mechanical — encoded in the linter/compiler/test runner; the gate catches it
- **[R]** review — a check question the reviewing agent answers about the diff
- **[P]** prompt-time — the implementing agent applies it while writing

JFDI wires these tiers in for you: the gate is tier M, the Code Review stage prompt asks the tier-R check questions, and every stage loads the project's AGENTS.md for tier P. The design rationale behind the tiers lives with JFDI (docs/agent-enforcement.md).

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

4. **Every acquired resource has a paired release.** [R]
   Subprocesses, watchers, timers, file handles, locks: released on every path — error paths included — via `finally`/`using`/`defer`-style constructs, not just the happy one.
   *Why:* the temporal twin of bounded memory; the happy path is not the only path, and agents habitually clean up only the one they walked.
   *Check:* for each acquisition in the diff, point to the release that runs when things go wrong.

5. **Altitude, not length.** [M tripwire + R]
   A function does one thing at one level of abstraction; its body reads as the steps of that one thing. Length is a smell, not a violation: set a generous mechanical tripwire (~100 lines, warning), and exceeding it requires an annotated suppression stating why the function is better whole. Splitting a function mechanically to duck the number is itself a violation.
   *Why:* hard limits make agents produce `doThingPart2(a, b, c, d, e, f)` — technically compliant, strictly worse.
   *Check:* does each function operate at one altitude? Is each length-suppression reason real ("function is long" is not a reason)?

## Errors, assertions, and the type checker

6. **Assert what the operation needs; sanitize only what the sink can't survive.** [P + R]
   At a boundary — parsed files, network/subprocess output, anything a human co-edits — assert what the *downstream operation* cannot proceed without: presence, a value in the range the operation requires (a count that can't be negative), cross-call invariants, exhaustiveness (`never` checks). Size any cleanup by what the *destination* cannot survive — a value the sink rejects (a NUL byte that `commit -m` refuses) or is harmed by (a terminal escape sequence in a log) earns sanitizing at that sink; a format you merely *requested* (a length, a punctuation rule) is a steer, not a law — when the output misses it the default is to pass it through unchanged, neither rejecting it nor coercing it into shape (truncating, padding, reformatting is itself unrequested defense — rule 23); reshape only when the *sink* structurally needs it, and then the sink is your reason, not the number you asked for. A stochastic source (an LLM) raises how *likely* you are to need that fallback — never how much you are entitled to reject. An assertion the type system already guarantees is noise (`assert(true)` in modern dress); scrubbing a value your own code just produced, or normalizing input the request never told you to touch, is defensive over-engineering (rule 23). Impossible states get an assertion, not a recovery path — one line that documents the impossibility beats a handler branch for a state that can't occur.
   *Check:* for each assertion, validation, or scrub in the diff, name the concrete, reachable failure it prevents. No named failure — or a sink that survives without it — fails the check; so does missing defense for a failure the sink *does* impose. Does any assertion merely restate a type?

7. **Every asynchronous result is handled.** [M]
   Awaited, or explicitly and visibly detached. No fire-and-forget.
   *Why:* the async-era version of "check your return values."

8. **No swallowed errors.** [M + R]
   Empty catch blocks are banned. Catch-log-and-continue is legal only when the degradation is deliberate and stated.
   *Check:* for each catch block, what happens next, and is that a decision or an accident?

9. **Errors name the operation, the offending value, and the way forward.** [R]
   "Failed" costs a debugging session; `config.json: integration.mode must be "auto" or "on-approval", got "yes"` costs nothing.
   *Why:* in an autonomous pipeline the error message *is* the interface between a failed run and whoever triages it — often another amnesiac session.
   *Check:* could a reader act on each new error message without opening the source?

10. **Zero warnings.** [M + R]
    The gate exits clean. Suppressions are legal only with a stated reason at the site — and suppression reasons are first-class review targets; a junk justification is a review failure.
    *Why:* without the justification rule, "zero warnings" degrades into "zero unsuppressed warnings."

11. **Don't hide code from the checker.** [M]
    No `any`-equivalents, no bare ignore-pragmas, no eval-adjacent tricks that blind static analysis. Escape hatches require the same stated-reason treatment as suppressions.

## Data

12. **Smallest scope; no module-level mutable state.** [M partial + R]
    Declare at the narrowest scope that works; export the narrowest surface. Module-level mutable state needs an explicit, stated reason to exist.

13. **Don't mutate what you didn't make.** [R]
    Treat arguments and shared objects as immutable; return new values or make ownership transfer explicit.
    *Why:* mutation-at-a-distance is the garbage-collected language's pointer aliasing bug.

14. **Secrets and PII stay out of code, logs, and history.** [P + R; M via scanners]
    No credentials, tokens, keys, or personal data hardcoded, logged, or committed — including in test fixtures and error messages (error messages get logged). Redact at the boundary; fixtures use obvious placeholders.
    *Why:* history is forever and logs travel. An agent that echoes an environment variable into a log has shipped a secret; one that copies production data into a fixture has shipped someone's PII.
    *Check:* does anything in the diff — code, log lines, error messages, fixtures — emit or embed a credential or personal data?

## Naming

15. **Quantities carry their dimension.** [R]
    `timeoutMs`, `delaySeconds`, `sizeBytes`, `balanceDollars` — and the sneaky one, fraction vs. percent (`0.15` vs `15`). Convert once, at the boundary, and name the result; no unlabeled numbers in flight.
    *Why:* Mars Climate Orbiter. `AltitudeMiles` doesn't crash into `AltitudeKm`.
    *Check:* does every dimensioned quantity's name state its unit?

16. **No magic numbers: a literal that encodes a decision gets a name.** [M where a lint exists + R]
    Thresholds, limits, timeouts, sizes, retry counts become named constants — and the name carries the dimension (rule 15). Exempt: `0`/`1`/`-1` in indexing and arithmetic-identity positions, and literals in tests, where the expected value is the point. The default fix is a named constant, *not* a config option — unrequested configurability is rule 23's problem.
    *Why:* an unexplained `3` is a decision hidden from review; the constant's name is where the why lives.
    *Check:* for each bare literal in the diff: index/identity, test expectation, or hidden decision?

17. **Name length scales with scope.** [R; M via min-identifier-length lint where available]
    Single-letter names are permitted only for: (a) a lambda parameter whose entire scope is one expression, (b) conventional numeric loop indices (`i`, `j`), (c) `_` for explicitly discarded values. Everywhere else, whole words.

18. **No abbreviations outside the allowlist.** [R]
    Allowlist: `id`, `min`, `max`, `args`, `config`, standard acronyms (`URL`, `JSON`, `HTTP`, `API`, `CLI`), and identifiers a framework imposes at its boundary. Everything else is spelled out — `error` not `err`, `context` not `ctx`, `request` not `req`. The list grows only by editing this document.
    *Why:* every abbreviation is clear to its author; an allowlist removes the judgment call entirely.

19. **Booleans are positive predicates.** [R]
    `isReady`, `hasMerged`, `shouldRetry`. Never a bare noun holding a boolean (`status`, `flag`), never a negated name (`notReady`, `disabled`) — `!notReady` is where 2 a.m. bugs live.

20. **Collections plural, elements singular.** [R]
    `vessels` / `vessel`; the element name is the singular of its collection. Dissolves most of the single-letter temptation for free.

21. **One name per concept.** [R]
    The project keeps a glossary; use its terms exactly and introduce no synonyms. Don't let `fetch`/`get`/`retrieve` or `ticket`/`card`/`issue` coexist for one thing.
    *Why:* every fresh agent session re-derives vocabulary; without a glossary, synonyms accrete every run.
    *Check:* does the diff use any concept-word not in the glossary?

## Conduct — how to work

22. **Decide, log, proceed.** [P + R]
    State assumptions and interpretation choices in the decision log *before* implementing. Never pick between plausible readings silently. Escalate only when genuinely blocked, and always with a recommended answer.
    *Why:* the log replaces the conversation — the human still sees every judgment call, just asynchronously.
    *Check:* does the diff match the stated assumptions?

23. **Simplicity first — including defensively.** [P + R]
    Minimum code that solves the stated problem. No speculative features, no abstractions for single-use code, no unrequested configurability, no handling for impossible scenarios (those get assertions — rule 6). Speculation wears defensive costumes too: an unrequested normalization, a scrub with no failure to point to, a validation the operation never needed. Unasked-for defense is scope creep like any feature — the minimum work that satisfies the request is the whole job.
    *Check:* identify anything in this diff not required by the request — a feature, an abstraction, *or* a line of defense with no named, reachable failure (rule 6). Anything found fails.

24. **Surgical changes.** [P + R]
    Every changed line traces to the request. Clean up orphans *your* change created (now-unused imports, variables, functions); don't touch pre-existing mess — flag it through the project's proposal channel instead. Exception: docs your change falsified are your mess (rule 32).
    *Why:* scope creep doesn't just risk breakage — it destroys the reviewer's ability to reason about the diff.
    *Check:* trace each changed line to the request.

25. **Prove the bug before fixing it.** [P + R]
    Bug fixes start with a failing test that reproduces the defect; the fix makes it pass. Skipping the repro (genuinely hard cases: races, rendering) requires a logged reason.
    *Why:* the failing test proves the diagnosis before any code changes; the passing test proves the fix; the regression test is free.

26. **Surface conflicts; never average them.** [P + R]
    When two existing patterns contradict, pick one (more recent, better tested), log why, and flag the loser for cleanup. Never blend them into a third pattern that matches nothing. Same rule at personal scale: convention beats taste — follow the codebase's style even where you disagree, and surface the disagreement rather than silently forking it.

27. **Dependencies are architectural decisions.** [P + R]
    Prefer the standard library, then dependencies already present. Adding a new one is a logged decision stating what it buys; pulling in a package for something expressible in a few dozen lines fails review.
    *Why:* a dependency is permanent maintenance surface, supply-chain exposure, and a license — costs that outlive the ten lines it saved.
    *Check:* does the diff add a dependency? Is the justification logged, and real?

28. **Tests verify intent, not implementation.** [R]
    *Check:* would this test fail if the business logic broke? Tests that mirror the implementation (mock everything, assert methods were called) and tautologies fail this question.

29. **Tests are deterministic and order-independent.** [R]
    Sleep-based synchronization is a race in costume — wait on conditions, not durations. Time and randomness are controlled (injected or seeded), and no test depends on another having run first. A flaky test is a defect against the gate itself, worse than a missing test.
    *Why:* the gate is the cheapest reviewer only while it is trusted; flakiness trains humans and agents alike to retry until green — fail-loud's evil twin.
    *Check:* does any test depend on timing, ordering, wall clock, or randomness it doesn't control?

30. **No commented-out code; no unowned TODOs.** [R]
    Delete dead code — version control remembers. A TODO must reference a ticket or a filed proposal; otherwise do it now or drop it.
    *Why:* a TODO with no owner is a wish (see the enforcement meta-rule), and commented-out code is dead code with worse ergonomics.
    *Check:* does the diff introduce commented-out code, or a TODO that points nowhere?

31. **Fail loud.** [M partial + R]
    "Completed" is false if anything was skipped silently; "tests pass" is false if any were skipped. Completion claims must match actual gate output. Anything skipped, stubbed, or degraded is stated prominently in the report, not buried. Mechanically: lint bans focused/skipped tests from landing.
    *Why:* in an interactive session a silent skip costs an afternoon; in an autonomous pipeline it corrupts the main branch.

## Documentation

32. **Record what the code cannot say.** [P + R]
    Docs carry intent, decisions, vocabulary, and invariants — never restatements of structure the repo can answer itself (any doc derivable from the code is a cache with no invalidation). If your change falsifies a doc — glossary, invariant, guide — updating it is part of your diff, not a separate task.
    *Check:* does the diff contradict anything the project's docs assert?
