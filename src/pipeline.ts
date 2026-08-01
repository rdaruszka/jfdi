import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JfdiConfig } from "./config.js";
import type { EventLog, StageName } from "./events.js";
import { formatGateFailure, runGate } from "./gate.js";
import { commitAllIfDirty, createWorktree, git, revParse, type Worktree } from "./git.js";
import type { Harness } from "./harness/index.js";
import { formatGateCommands, loadPrompt, type PromptName, renderPrompt } from "./prompts.js";
import { ensureJfdiStateScaffold } from "./scaffold.js";
import { appendToSection, ensureTicketNote, type Ticket } from "./tickets.js";
import { ensureDir, readIfExists } from "./util/fsx.js";
import { type ReviewVerdict, readImplementationVerdict, readReviewVerdict } from "./verdicts.js";

export interface PipelineContext {
  repoRoot: string;
  /** Absolute path to .jfdi/ */
  jfdiDir: string;
  config: JfdiConfig;
  harness: Harness;
  log: EventLog;
  /** Live sessions register here so a shutdown can kill stray subprocesses. */
  sessions?: Set<{ kill(): void }>;
}

export interface FeedbackItem {
  round: number;
  source: "implementation" | "gate" | "code-review" | "qa";
  feedback: string;
}

export interface RunReport {
  summary: string;
  decisions: string[];
  testsAdded: string;
  rounds: number;
  commit: string;
}

export type PipelineOutcome =
  | { status: "passed"; worktree: Worktree; report: RunReport }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export function worktreesDir(jfdiDir: string): string {
  return path.join(jfdiDir, "worktrees");
}

export function runsDir(jfdiDir: string, ticketId: string): string {
  return path.join(jfdiDir, "runs", ticketId);
}

/** Next run-<k> directory under runs/<ticket>/ (history is kept across dispatches). */
async function nextRunDir(jfdiDir: string, ticketId: string): Promise<string> {
  const base = runsDir(jfdiDir, ticketId);
  await ensureDir(base);
  const entries = await fs.readdir(base);
  const runs = entries.filter((e) => /^run-\d+$/.test(e)).length;
  const dir = path.join(base, `run-${runs + 1}`);
  await ensureDir(dir);
  return dir;
}

interface StageOutcome {
  ok: boolean;
  resultText: string;
  verdictPath: string;
}

async function runStageSession(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  prompt: string,
  roundDir: string,
): Promise<StageOutcome> {
  const verdictPath = path.join(roundDir, `${stage}.verdict.json`);
  const logPath = path.join(roundDir, `${stage}.log.jsonl`);
  ctx.log.emit("stage_start", ticket.id, { stage });
  const session = ctx.harness.spawn({ prompt }, { cwd: worktree.path, logPath });
  ctx.sessions?.add(session);
  try {
    for await (const evt of session.events) {
      if (evt.type === "tool") {
        ctx.log.emit("session_activity", ticket.id, {
          text: `${stage}: ${evt.name}${evt.detail ? ` ${evt.detail}` : ""}`,
        });
      } else if (evt.type === "text") {
        const line = evt.text.split("\n")[0] ?? "";
        if (line.trim())
          ctx.log.emit("session_activity", ticket.id, {
            text: `${stage}: ${line.slice(0, 120)}`,
          });
      }
    }
    const result = await session.done;
    return { ok: result.ok, resultText: result.text, verdictPath };
  } finally {
    ctx.sessions?.delete(session);
  }
}

async function stagePrompt(
  ctx: PipelineContext,
  name: PromptName,
  vars: Record<string, string>,
): Promise<string> {
  const template = await loadPrompt(ctx.jfdiDir, name);
  return renderPrompt(template, vars);
}

function commonVars(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  verdictPath: string,
): Record<string, string> {
  return {
    TICKET_ID: ticket.id,
    SPEC: ticket.spec,
    BRANCH: worktree.branch,
    TARGET_BRANCH: ctx.config.integration.target_branch,
    GATE_COMMANDS: formatGateCommands(ctx.config.gate),
    VERDICT_PATH: verdictPath,
  };
}

const FEEDBACK_SOURCE_LABELS: Record<string, string> = {
  implementation: "previous attempt",
  gate: "mechanical gate",
  "code-review": "code review",
  qa: "QA",
};

function formatFeedbackSection(history: FeedbackItem[], mode: "default" | "ask"): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push(
      "\n## Feedback on earlier attempts\n",
      "This task was attempted before and received the following feedback (oldest first). Address all of it:\n",
    );
    for (const item of history) {
      const label = FEEDBACK_SOURCE_LABELS[item.source] ?? item.source;
      parts.push(`### Round ${item.round} — ${label}\n\n${item.feedback}\n`);
    }
  }
  if (mode === "ask") {
    parts.push(
      "\n## Escalation override\n",
      "The human has asked for check-ins on this ticket (`mode: ask`): prefer escalating with a recommendation over guessing on any non-trivial choice.\n",
    );
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

async function recordDecisions(
  notePath: string,
  stage: string,
  round: number,
  decisions: string[] | undefined,
): Promise<string[]> {
  if (!decisions || decisions.length === 0) return [];
  const stamped = decisions.map((d) => `- (round ${round}, ${stage}) ${d}`);
  await appendToSection(notePath, "Decisions", stamped.join("\n"));
  return decisions;
}

async function recordEscalation(
  ctx: PipelineContext,
  ticket: Ticket,
  notePath: string,
  stage: string,
  question: string,
  recommendation: string,
): Promise<void> {
  const beginColumn = ctx.config.board.columns.begin;
  await appendToSection(
    notePath,
    "Questions",
    [
      `### ${new Date().toISOString().slice(0, 10)} — ${stage}`,
      "",
      `**Q:** ${question}`,
      "",
      `**Recommendation:** ${recommendation}`,
      "",
      `_Answer by editing this note, then move the card back to "${beginColumn}"._`,
    ].join("\n"),
  );
  ctx.log.emit("escalation", ticket.id, { stage, question, recommendation });
}

/** Run QA alone (used post-rebase on a complicated merge). */
export async function runQaStage(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  roundDir: string,
  notePath: string,
  round: number,
): Promise<{ verdict: ReviewVerdict | null; outcome: StageOutcome }> {
  const sandbox =
    (await readIfExists(path.join(ctx.jfdiDir, "sandbox.md"))) ??
    "(no sandbox contract found — exercise the artifact as best you can and say so in your feedback)";
  const verdictPath = path.join(roundDir, "qa.verdict.json");
  const prompt = await stagePrompt(ctx, "qa", {
    ...commonVars(ctx, ticket, worktree, verdictPath),
    SANDBOX: sandbox,
  });
  const outcome = await runStageSession(ctx, ticket, worktree, "qa", prompt, roundDir);
  const verdict = await readReviewVerdict(outcome.verdictPath, { allowEscalate: true });
  if (verdict) await recordDecisions(notePath, "qa", round, verdict.decisions);
  ctx.log.emit("stage_end", ticket.id, {
    stage: "qa",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
  });
  return { verdict, outcome };
}

/**
 * The per-ticket pipeline: Implementation → mechanical gate → Code Review → QA,
 * with feedback rounds. Reviews are sequential — Code Review gates QA — and both
 * sign-offs bind to a commit: any fix round re-enters at the gate and repeats both.
 */
export async function runPipeline(ctx: PipelineContext, ticket: Ticket): Promise<PipelineOutcome> {
  const target = ctx.config.integration.target_branch;
  await ensureJfdiStateScaffold(ctx.jfdiDir);
  const notePath = await ensureTicketNote(ticket, path.join(ctx.repoRoot, ctx.config.ticketsDir));
  const worktree = await createWorktree(ctx.repoRoot, worktreesDir(ctx.jfdiDir), ticket.id, target);
  const runDir = await nextRunDir(ctx.jfdiDir, ticket.id);
  ctx.log.emit("dispatch", ticket.id, { title: ticket.cardText, branch: worktree.branch });

  const history: FeedbackItem[] = [];
  const allDecisions: string[] = [];
  let summary = "";
  let testsAdded = "";
  const maxRounds = ctx.config.pipeline.max_rounds;

  for (let round = 1; round <= maxRounds; round++) {
    ctx.log.emit("round_start", ticket.id, { round });
    const roundDir = path.join(runDir, `round-${round}`);
    await ensureDir(roundDir);

    // --- Implementation ---
    const implVerdictPath = path.join(roundDir, "implementation.verdict.json");
    const implPrompt = await stagePrompt(ctx, "implementation", {
      ...commonVars(ctx, ticket, worktree, implVerdictPath),
      FEEDBACK_SECTION: formatFeedbackSection(history, ticket.mode),
    });
    const impl = await runStageSession(
      ctx,
      ticket,
      worktree,
      "implementation",
      implPrompt,
      roundDir,
    );
    const implVerdict = await readImplementationVerdict(impl.verdictPath);
    ctx.log.emit("stage_end", ticket.id, {
      stage: "implementation",
      verdict: implVerdict?.status ?? (impl.ok ? "invalid-verdict" : "session-failed"),
    });

    if (!implVerdict) {
      history.push({
        round,
        source: "implementation",
        feedback: impl.ok
          ? "The previous implementation session ended without writing a valid verdict file. Re-verify the work is complete, committed, and gate-passing, then write the verdict file as instructed."
          : `The previous implementation session failed: ${impl.resultText.slice(0, 2000)}`,
      });
      continue;
    }
    allDecisions.push(
      ...(await recordDecisions(notePath, "implementation", round, implVerdict.decisions)),
    );
    if (implVerdict.status === "escalate") {
      const question = implVerdict.question ?? "Escalated without a stated question.";
      const recommendation = implVerdict.recommendation ?? "(no recommendation given)";
      await recordEscalation(ctx, ticket, notePath, "implementation", question, recommendation);
      ctx.log.emit("blocked", ticket.id, { reason: `escalated: ${question.slice(0, 120)}` });
      return { status: "blocked", reason: question };
    }
    summary = implVerdict.summary ?? summary;
    await commitAllIfDirty(worktree.path, `jfdi(${ticket.id}): checkpoint uncommitted work`);

    // --- Mechanical gate: cheapest reviewer, runs first, always ---
    ctx.log.emit("gate_start", ticket.id);
    const gate = await runGate(ctx.config.gate, worktree.path, (name) =>
      ctx.log.emit("session_activity", ticket.id, { text: `gate: ${name}` }),
    );
    const failedStep = gate.results.at(-1)?.name;
    ctx.log.emit("gate_result", ticket.id, {
      ok: gate.ok,
      ...(gate.ok ? {} : { step: failedStep }),
    });
    if (!gate.ok) {
      history.push({ round, source: "gate", feedback: formatGateFailure(gate) });
      continue;
    }

    // --- Code Review (gates QA — a fail here skips the expensive sandbox run) ---
    const crVerdictPath = path.join(roundDir, "code-review.verdict.json");
    const crPrompt = await stagePrompt(ctx, "code-review", {
      ...commonVars(ctx, ticket, worktree, crVerdictPath),
    });
    const cr = await runStageSession(ctx, ticket, worktree, "code-review", crPrompt, roundDir);
    // Reviewers are read-only; discard any stray modifications.
    await git(worktree.path, "checkout", "--", ".");
    const crVerdict = await readReviewVerdict(cr.verdictPath, { allowEscalate: false });
    ctx.log.emit("stage_end", ticket.id, {
      stage: "code-review",
      verdict: crVerdict?.verdict ?? (cr.ok ? "invalid-verdict" : "session-failed"),
    });
    if (!crVerdict || crVerdict.verdict === "fail") {
      history.push({
        round,
        source: "code-review",
        feedback:
          crVerdict?.feedback ??
          (crVerdict
            ? "Code review failed without specific feedback."
            : `Code review session did not produce a valid verdict${cr.ok ? "" : `: ${cr.resultText.slice(0, 1000)}`}.`),
      });
      continue;
    }
    allDecisions.push(
      ...(await recordDecisions(notePath, "code-review", round, crVerdict.decisions)),
    );

    // --- Quality Assurance ---
    const qa = await runQaStage(ctx, ticket, worktree, roundDir, notePath, round);
    if (qa.verdict?.verdict === "escalate") {
      const question = qa.verdict.question ?? "QA escalated without a stated question.";
      const recommendation = qa.verdict.recommendation ?? "(no recommendation given)";
      await recordEscalation(ctx, ticket, notePath, "qa", question, recommendation);
      ctx.log.emit("blocked", ticket.id, { reason: `QA escalated: ${question.slice(0, 120)}` });
      return { status: "blocked", reason: question };
    }
    if (!qa.verdict || qa.verdict.verdict === "fail") {
      history.push({
        round,
        source: "qa",
        feedback:
          qa.verdict?.feedback ??
          `QA session did not produce a valid verdict${qa.outcome.ok ? "" : `: ${qa.outcome.resultText.slice(0, 1000)}`}.`,
      });
      continue;
    }
    testsAdded = qa.verdict.testsAdded ?? "";
    allDecisions.push(...(qa.verdict.decisions ?? []));
    await commitAllIfDirty(worktree.path, `jfdi(${ticket.id}): QA artifacts`);

    const finalCommit = await revParse(worktree.path, "HEAD");
    return {
      status: "passed",
      worktree,
      report: { summary, decisions: allDecisions, testsAdded, rounds: round, commit: finalCommit },
    };
  }

  // Rounds exhausted → Blocked with accumulated history in the note.
  const historyMd = history
    .map((h) => `- **round ${h.round} (${h.source}):** ${h.feedback.split("\n")[0]}`)
    .join("\n");
  await appendToSection(
    notePath,
    "Questions",
    [
      `### ${new Date().toISOString().slice(0, 10)} — retries exhausted`,
      "",
      `All ${maxRounds} rounds failed. Round history:`,
      "",
      historyMd,
      "",
      `_Full logs: .jfdi/runs/${ticket.id}/. Adjust the ticket and move it back to "${ctx.config.board.columns.begin}" to retry._`,
    ].join("\n"),
  );
  ctx.log.emit("blocked", ticket.id, { reason: `retries exhausted after ${maxRounds} rounds` });
  return { status: "blocked", reason: `retries exhausted after ${maxRounds} rounds` };
}
