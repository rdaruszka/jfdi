# Enforcement for Agent-Maintained Codebases

Companion to [coding-guidelines.md](coding-guidelines.md). That document says what the rules are; this one says how to make them hold in a system where agents write, review, and merge the code — a JFDI-style pipeline or anything shaped like one. **JFDI is an implementation of this design**: if the code and this document disagree, one of them is wrong, and the discrepancy is a bug to surface, not drift to accept.

## The premise

With agents as primary maintainers, every session starts amnesiac. Nothing holds by culture, habit, or "everyone knows" — a rule holds only if some mechanism re-applies it every single run. Hence the meta-rule stamped on every guideline:

> **Every rule names its enforcement tier. A rule with no enforcement route is a wish, and with agents, wishes have a half-life of zero.**

## The three tiers

**Tier 1 — Mechanical.** The linter, compiler, and test runner, run as a gate that must exit zero before any handoff. Binary, cheap, ungameable-ish, and it costs no attention. Everything that *can* live here *should* — prefer encoding a standard into lint/type/test config over writing it in prose. Prose gets skimmed; the gate does not.

**Tier 2 — Review.** A reviewing agent answering *check questions* about the diff. Judgment rules live here — altitude, assertion placement, termination measures, scope tracing.

**Tier 3 — Prompt-time.** The implementing agent gets the guidelines before writing a line. Prevention, not detection: a rule that only exists at review time costs a full feedback round every time it fires; the same rule applied at write time is free.

One artifact can serve tiers 2 and 3 simultaneously: put the guidelines in the always-loaded project context (AGENTS.md), and every stage — implementer and reviewer alike — has them. But see "Background context gets skimmed," below.

## Tier 1 mechanics

**The tripwire + suppression channel.** Some rules want a mechanical *signal* without a mechanical *verdict* — function length is the canonical case. The pattern:

1. Lint warns past a generous threshold (~100 lines).
2. The zero-warnings rule means the gate now fails.
3. The only legal path over the threshold is an annotated suppression with a stated reason.
4. The review agent audits suppression reasons as a checklist item; a junk reason is a review failure.

This has exactly the right incentive shape for agents: the cheap path (silently exceed) is mechanically blocked, and the compliant path forces a visible, reviewable confession at the site of the exception. Without step 4 it collapses — agents learn that any string after the colon passes the gate. Suppression justifications are load-bearing review targets, always.

**Lint rules worth reaching for** (names vary by ecosystem; verify availability in yours):

- Warnings-as-errors / gate must exit zero
- Unhandled-promise / floating-promise detection
- Empty catch block ban
- Focused-test and skipped-test bans (`.only` / `.skip` can't land)
- Naming-convention casing enforcement
- Minimum identifier length, with the guideline's exception list (`i`, `j`, `_`)
- Max function length as *warning* (the tripwire), never error
- Ban on unannotated ignore-pragmas (`any`-equivalents, bare `@ts-ignore`-equivalents)
- No-magic-numbers lint, with the guideline's exemptions (index/identity literals, test files)
- Secret scanning on diffs (credential patterns; add PII patterns where the domain handles personal data)

**Gauge honestly.** If a rule's mechanical encoding doesn't exist in your toolchain, tag the rule [R] and give the reviewer its check question. Don't claim gate coverage you don't have.

## Tier 2 mechanics

**Background context gets skimmed.** Guidelines sitting in AGENTS.md are ambient prose to a reviewer. The review stage prompt must contain an *active instruction*: "check the diff against the code guidelines; for each judgment rule, answer its check question." Content lives in one place; the prompt points at it and activates it as a task.

**Check questions, not vibes.** Every judgment rule must be phrased as a question with an answer, checkable against a diff:

- "For each loop or recursion: name what decreases, or name the yield + exit condition."
- "Identify anything in this diff not required by the ticket." (simplicity + scope in one question)
- "Trace each changed line to the request."
- "Would this test fail if the business logic broke?"
- "For each suppression: is the stated reason real?"
- "Does the diff add a dependency, and is the logged justification real?"
- "Does anything in the diff — code, logs, error messages, fixtures — emit or embed a credential or personal data?"
- "Does the diff use any concept-word not in the glossary?"
- "Does the diff contradict anything the docs assert?"
- "Does the diff match the assumptions stated in the decision log?"

A rule you cannot compile into such a question isn't enforceable at tier 2 — find a mechanical encoding or rewrite the rule.

**Beware gameable numbers.** Any hard numeric limit will be satisfied in the letter and violated in spirit (the function split into `doPart1`/`doPart2` with six parameters). State explicitly, in the guidelines, that gaming a tripwire is itself a violation, and give the reviewer that as a check.

## Translating interactive rules to autonomous pipelines

Most published agent-behavior rules ("Karpathy's rules" and descendants) assume a human in the loop. An autonomous pipeline removes the human but should build an async substitute for every conversational move — the rules then compile down instead of being dropped:

| Interactive move | Autonomous substitute |
|---|---|
| "Ask rather than guess" | Decide, log the decision + assumptions in the ticket's decision log, proceed. Escalation exists but is last-resort and must carry a recommended answer. |
| "Mention it, don't fix it" | Propose it through the inbox (below). |
| "Checkpoint with the user" | Commit cadence + the stage handoff report. |
| "Push back / surface tradeoffs" | Decision log entry presenting the options and the choice made. |

The decision log does double duty: the human sees every judgment call asynchronously, and the reviewer gains a spec to check the diff against — review becomes "does the code match what the implementer said they were doing," not "does this look right."

## Agents propose, humans promote

Nothing agent-initiated enters the prioritized work queue without a human touch. Concretely, a board column with this contract:

- **Agent-writable, human-drained.** Agents (via the coordinator — stage agents never touch the board directly) file cards for out-of-scope observations: dead code spotted, the losing side of a pattern conflict, tooling gaps. Cards leave the column only by human hand — promoted to the backlog or deleted.
- **Never dispatched.** The coordinator never starts work from this column. A card here is inert by definition.
- **Provenance required.** Each card says which run spotted it and one line of why, so triage weeks later has context. Dedup is the human's job at triage — cheap for a human, unreliable for agents.

This is what keeps "surgical changes" honest: the rule can demand agents *not* fix adjacent mess only because there's somewhere legitimate for the observation to go.

## Commits and handoffs

- The harness commits, not the agent. A stage session leaves its work in the worktree and the pipeline commits it at session end — success, failure or crash. Asking agents to commit produced messages whose quality varied by provider, and a session that died before its own commit lost its work silently; both are properties of the harness to fix, not of the prompt. Enforcement is mechanical: HEAD is recorded before the session and any commit it made is reset back into the index, so one commit per session is a fact, not a request.
- The message is written by a dedicated cheap session — a scribe — from the staged diff, the ticket, and the completing stage's own summary (the "why" a diff cannot carry). The harness appends the routing and round metadata itself, so what a machine has to parse never depends on an agent's formatting.
- Fix-round commits append; never amend or squash while a review is in flight. Reviewers diff exactly what changed since their commit-bound sign-off. (Append-only history during a run, for the same reason the event log is append-only.)
- Gate-green is required at *handoff*, not at every intermediate state — per-commit gating taxes the cadence to death.
- A handoff report must be actionable by a session with zero shared context: what was done, what's verified (against actual gate output), what remains, what was decided. A stage isn't done until its report would let a stranger continue. "Done with caveats" states the caveats in the report, prominently.

## The merge tripwire

The final integration step gets a **tripwire, not a veto**. By merge time the commit carries commit-bound sign-offs; a discretionary "this feels bad" rejection would be re-review with less context. But the merger knows one thing reviewers couldn't: what happened when a target branch that moved was merged in. So:

- Merge clean + gate green on the merged state → land it. No discretion.
- The merge needed manual resolution, or the gate fails on the merged state → sign-offs are void (conflict resolution *is* a code change), back into the pipeline; repeated failure escalates to a human like any exhausted ticket.

What lands is a merge commit, never a rebase: sign-offs bind to a commit sha, so rewriting the branch would delete the very commits the review trail points at, and would land intermediate states the gate never ran against.

The merger judges the *integration*, never the *code*. Every refusal is a stated mechanical reason; the merger never quietly resolves a conflict and proceeds as if sign-offs still held.

## Documentation as a system component

Docs are the institutional memory of an amnesiac workforce, and they fail two different ways:

- **Always-loaded docs** (AGENTS.md, glossary) scale against *attention* — every token loads into every session, and past a size they get skimmed. Give them a budget; growth forces demotion to reference docs.
- **Reference docs** (spec, guides) scale against *staleness*. The rot rate is proportional to how much the doc restates the code: a file map changes every time anything moves (and agents grep fast enough that it's now negative-value); a glossary changes only when *concepts* change. Hence: docs record what the code cannot say — intent, decisions, vocabulary, invariants.

Staleness is fixed by binding updates to diffs, not to a separate task: if a change falsifies a doc, updating the doc is part of that change (implementer duty, reviewer check). Deferred doc maintenance is doc rot with extra steps. Residual drift gets a periodic curation ticket — consolidate, prune, demote — which in a self-hosted system is just a card on the board.

**The glossary** deserves special standing: a short list of the project's nouns with one-line meanings, plus the rule "use these exactly, introduce no synonyms." For humans a courtesy; for agents load-bearing, since every fresh session re-derives vocabulary and will happily coin a fourth synonym for the same thing.

## Test ownership

Unit tests belong to implementation and ship in the same diff as the code. Acceptance tests belong to QA and derive from the *ticket*, never the diff — that's "tests verify intent" made structural: a test suite generated from the change it's testing can only ever confirm the change. Acceptance tests accumulate across runs into a regression suite.
