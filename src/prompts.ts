import * as path from "node:path";
import { atomicWrite, fileExists, readIfExists } from "./util/fsx.js";

export type PromptName = "implementation" | "code-review" | "qa" | "integration" | "convo" | "init";

const COMMON_POSTURE = `## Working posture

Default posture: **decide, log, proceed.** When you hit a decision fork (ambiguity, a
minor design choice), make the reasonable call, record it in your \`decisions\` array,
and continue. Escalation is a last resort reserved for genuine hard blocks:
contradictory requirements, missing access, work that is impossible as specified.
An escalation must include a recommended answer — never a bare question.`;

const VERDICT_INSTRUCTIONS = `## Reporting your result (required)

When you are finished, write a single JSON object to the file at:

{{VERDICT_PATH}}

Your outcome is read only from this file — write it as your final action.
Its exact schema is described below. Do not wrap it in markdown.`;

const DEFAULT_PROMPTS: Record<PromptName, string> = {
  implementation: `Implement the ticket below completely. You are working in an isolated git
worktree on branch \`{{BRANCH}}\`.

## Ticket: {{TICKET_ID}}

{{SPEC}}
{{FEEDBACK_SECTION}}
## Rules

- Write unit tests alongside the code; they are part of "done".
- The mechanical gate must pass before you finish. Run it yourself and fix failures:
{{GATE_COMMANDS}}
- Commit your work with clear messages (git is already configured in this worktree).
  Leave the working tree clean — everything committed.
- Do not touch any branch other than \`{{BRANCH}}\`. Never push.
- Stay inside this worktree.

${COMMON_POSTURE}

${VERDICT_INSTRUCTIONS}

Schema:
{
  "status": "done" | "escalate",
  "summary": "one-paragraph summary of what you did",
  "decisions": ["autonomous choice you made and why", ...],
  "question": "only when escalating: the precise question",
  "recommendation": "only when escalating: your recommended answer"
}`,

  "code-review": `Review the changes on branch \`{{BRANCH}}\` — the diff against
\`{{TARGET_BRANCH}}\` — from a **pure code standpoint**: structure, clarity, naming,
conventions, maintainability, test quality. Functionality is NOT in scope here;
the change's behavior is validated separately.

Inspect the change with: \`git diff {{TARGET_BRANCH}}...HEAD\` (and read files as needed).

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Rules

- Judge the code against the ticket and the codebase's existing conventions.
- Do not modify any files — review only; you are not the author.
- Anything a linter/formatter already enforces is out of scope; don't relitigate it.
- Fail only for issues that materially hurt the codebase; nitpicks belong in feedback
  as optional notes, not failure grounds.

${COMMON_POSTURE}

${VERDICT_INSTRUCTIONS}

Schema:
{
  "verdict": "pass" | "fail",
  "feedback": "when failing: specific, actionable items for the author",
  "decisions": ["judgment call you made", ...]
}`,

  qa: `Validate the **behavior** of the changes on branch \`{{BRANCH}}\` against the
ticket below — independently and adversarially. Derive your checks from the ticket,
not from the diff.

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Sandbox contract

How to build, launch, drive, and tear down the product under test:

{{SANDBOX}}

## Rules

- Exercise the real artifact per the sandbox contract; do not just read code.
- Encode what you verified as automated end-to-end/regression tests, committed on this
  branch — future runs must cover this behavior mechanically. Old behavior is already
  covered by the existing suite; focus manual exercise on the new surface.
- Run the mechanical gate after committing tests; it must still pass:
{{GATE_COMMANDS}}
- Leave the working tree clean — tests committed, scratch artifacts removed.

${COMMON_POSTURE}

${VERDICT_INSTRUCTIONS}

Schema:
{
  "verdict": "pass" | "fail" | "escalate",
  "feedback": "when failing: what behavior is wrong or missing, with reproduction steps",
  "testsAdded": "summary of the automated tests you committed",
  "decisions": ["judgment call you made", ...],
  "question": "only when escalating",
  "recommendation": "only when escalating: your recommended answer"
}`,

  integration: `A rebase of branch \`{{BRANCH}}\` onto \`{{TARGET_BRANCH}}\` has hit conflicts.
Resolve them and complete the rebase.

## Ticket: {{TICKET_ID}}

{{SPEC}}

## Rules

- Resolve every conflict, preserving the intent of both sides, then continue the
  rebase to completion (\`git add\` the resolutions, \`git rebase --continue\`).
- Never abort the rebase; never force-push; never touch \`{{TARGET_BRANCH}}\` itself.
- Afterwards, judge your own resolution honestly: if you had to touch real logic
  (not adjacent-line noise), report "complicated" — the change will be re-validated.

${VERDICT_INSTRUCTIONS}

Schema:
{
  "resolution": "clean" | "complicated",
  "notes": "what conflicted and how you resolved it"
}`,

  convo: `You are working on the **JFDI layer** of this repository — not the product code.
Your scope: the mechanical gate (linter/formatter/test-runner config, so machines
check what machines can check), the sandbox contract (.jfdi/sandbox.md), board
configuration (.jfdi/config.json), and the per-stage agent prompts (.jfdi/prompts/).

A core JFDI value: encode standards into tooling so review tokens are spent only on
what machines can't check. When the human describes a recurring review nit, your
first instinct is a lint rule, not a prompt tweak.

Discuss, then edit these files as agreed. Do not modify product source code except
where the human explicitly asks (e.g. fixing violations a newly tightened gate
surfaces).`,

  init: `You are bootstrapping **JFDI** (an automated implement → review → QA → merge
pipeline) for this repository. A skeleton .jfdi/ directory has just been scaffolded
with defaults. Your job is to make it real:

1. Inspect the repo: language, package manager, build/test/lint tooling, how it runs.
2. Fill in .jfdi/config.json's "gate" with real commands (build, test, lint,
   format-check) that all exit zero right now. If the repo lacks a linter/formatter/
   test runner, set up sensible ones and fix any violations so the gate passes.
   The gate is JFDI's cheapest reviewer — give it teeth.
3. Write .jfdi/sandbox.md: how QA should build, launch, drive, and tear down this
   product (invocation patterns, expected outputs, scratch-dir conventions).
4. Adjust the board column names in config.json if the human wants different ones.
5. Verify: run every gate command; each must exit zero.

Report what you set up and anything the human should tune.`,
};

/** Render a template, replacing {{VAR}} placeholders. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => vars[name] ?? "");
}

export function promptsDir(jfdiDir: string): string {
  return path.join(jfdiDir, "prompts");
}

/** Seed any missing prompt files with defaults (user-tunable afterwards). */
export async function ensurePrompts(jfdiDir: string): Promise<void> {
  const dir = promptsDir(jfdiDir);
  for (const [name, content] of Object.entries(DEFAULT_PROMPTS)) {
    const file = path.join(dir, `${name}.md`);
    if (!(await fileExists(file))) await atomicWrite(file, `${content}\n`);
  }
}

/**
 * Load a stage prompt from .jfdi/prompts/<name>.md. The file is authoritative;
 * if it is missing it is seeded with the default first, so what ran is always
 * on disk — never a silent in-code fallback.
 */
export async function loadPrompt(jfdiDir: string, name: PromptName): Promise<string> {
  const file = path.join(promptsDir(jfdiDir), `${name}.md`);
  const existing = await readIfExists(file);
  if (existing !== null) return existing;
  const content = `${DEFAULT_PROMPTS[name]}\n`;
  await atomicWrite(file, content);
  return content;
}

export function formatGateCommands(gate: Array<{ name: string; cmd: string }>): string {
  if (gate.length === 0) return "  (no gate commands configured)";
  return gate.map((g) => `  - ${g.name}: \`${g.cmd}\``).join("\n");
}
