import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JfdiConfig } from "./config.js";
import type { EventLog, StageName } from "./events.js";
import { formatGateFailure, runGate } from "./gate.js";
import { commitAllIfDirty, createWorktree, git, revParse, type Worktree } from "./git.js";
import type { Harness } from "./harness/index.js";
import { formatGateCommands, loadPrompt, type PromptName, renderPrompt } from "./prompts.js";
import { ensureJfdiGitignore } from "./scaffold.js";
import { appendToSection, ensureTicketNote, type Ticket } from "./tickets.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDir, readIfExists } from "./util/fsx.js";
import { type ReviewVerdict, readImplementationVerdict, readReviewVerdict } from "./verdicts.js";

export interface PipelineContext {
  repoRoot: string;
  /** Absolute path to .jfdi/ — versioned setup (config, prompts, sandbox) + worktrees. */
  jfdiDir: string;
  /** Absolute path to ~/.jfdi/projects/<project-key>/ — runs, events, state snapshot. */
  stateDir: string;
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
  /** Out-of-scope issues stages spotted; the caller proposes them as inbox cards. */
  observations: string[];
  testsAdded: string;
  rounds: number;
  commit: string;
}

export type PipelineOutcome =
  | { status: "passed"; worktree: Worktree; report: RunReport }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

/** One line of live session activity, trimmed to stay readable in the TUI. */
const MAX_ACTIVITY_CHARS = 120;
/** Blocked/escalation reasons carried on an event, trimmed for the same reason. */
const MAX_REASON_CHARS = 120;
/** Session output quoted back to the next round when a stage crashed outright. */
const MAX_SESSION_ERROR_CHARS = 2_000;
/** Session output quoted back when a stage ran but produced no valid verdict. */
const MAX_VERDICT_ERROR_CHARS = 1_000;

export function worktreesDir(jfdiDir: string): string {
  return path.join(jfdiDir, "worktrees");
}

export function runsDir(stateDir: string, ticketId: string): string {
  return path.join(stateDir, "runs", ticketId);
}

/** Next run-<k> directory under runs/<ticket>/ (history is kept across dispatches). */
async function nextRunDir(stateDir: string, ticketId: string): Promise<string> {
  const base = runsDir(stateDir, ticketId);
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
            text: `${stage}: ${line.slice(0, MAX_ACTIVITY_CHARS)}`,
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
      `### ${todayIsoDate()} — ${stage}`,
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

type ImplementationStep =
  | { kind: "done"; summary: string | undefined; decisions: string[]; observations: string[] }
  | { kind: "retry"; feedback: string }
  | { kind: "escalate"; question: string; recommendation: string };

async function runImplementationStage(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  roundDir: string,
  notePath: string,
  round: number,
  history: FeedbackItem[],
): Promise<ImplementationStep> {
  const verdictPath = path.join(roundDir, "implementation.verdict.json");
  const prompt = await stagePrompt(ctx, "implementation", {
    ...commonVars(ctx, ticket, worktree, verdictPath),
    FEEDBACK_SECTION: formatFeedbackSection(history, ticket.mode),
  });
  const outcome = await runStageSession(ctx, ticket, worktree, "implementation", prompt, roundDir);
  const verdict = await readImplementationVerdict(outcome.verdictPath);
  ctx.log.emit("stage_end", ticket.id, {
    stage: "implementation",
    verdict: verdict?.status ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
  });
  if (!verdict) {
    return {
      kind: "retry",
      feedback: outcome.ok
        ? "The previous implementation session ended without writing a valid verdict file. Re-verify the work is complete, committed, and gate-passing, then write the verdict file as instructed."
        : `The previous implementation session failed: ${outcome.resultText.slice(0, MAX_SESSION_ERROR_CHARS)}`,
    };
  }
  const decisions = await recordDecisions(notePath, "implementation", round, verdict.decisions);
  if (verdict.status === "escalate") {
    return {
      kind: "escalate",
      question: verdict.question ?? "Escalated without a stated question.",
      recommendation: verdict.recommendation ?? "(no recommendation given)",
    };
  }
  return {
    kind: "done",
    summary: verdict.summary,
    decisions,
    observations: verdict.observations ?? [],
  };
}

type CodeReviewStep =
  | { kind: "pass"; decisions: string[]; observations: string[] }
  | { kind: "retry"; feedback: string };

async function runCodeReviewStage(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  roundDir: string,
  notePath: string,
  round: number,
): Promise<CodeReviewStep> {
  const verdictPath = path.join(roundDir, "code-review.verdict.json");
  const prompt = await stagePrompt(
    ctx,
    "code-review",
    commonVars(ctx, ticket, worktree, verdictPath),
  );
  const outcome = await runStageSession(ctx, ticket, worktree, "code-review", prompt, roundDir);
  // Reviewers are read-only; discard any stray modifications.
  await git(worktree.path, "checkout", "--", ".");
  const verdict = await readReviewVerdict(outcome.verdictPath, { allowEscalate: false });
  ctx.log.emit("stage_end", ticket.id, {
    stage: "code-review",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
  });
  if (!verdict || verdict.verdict === "fail") {
    return {
      kind: "retry",
      feedback:
        verdict?.feedback ??
        (verdict
          ? "Code review failed without specific feedback."
          : `Code review session did not produce a valid verdict${outcome.ok ? "" : `: ${outcome.resultText.slice(0, MAX_VERDICT_ERROR_CHARS)}`}.`),
    };
  }
  const decisions = await recordDecisions(notePath, "code-review", round, verdict.decisions);
  return { kind: "pass", decisions, observations: verdict.observations ?? [] };
}

type RoundStep =
  | { kind: "retry"; source: FeedbackItem["source"]; feedback: string }
  | { kind: "blocked"; reason: string }
  | { kind: "passed"; testsAdded: string };

interface RoundResult {
  step: RoundStep;
  /** Decisions and observations earned before the round's outcome was known — kept either way. */
  decisions: string[];
  observations: string[];
  summary: string | undefined;
}

/** The mechanical gate, with its start/result events. Cheapest reviewer, runs first, always. */
async function runGateStage(ctx: PipelineContext, ticket: Ticket, worktree: Worktree) {
  ctx.log.emit("gate_start", ticket.id);
  const gate = await runGate(ctx.config.gate, worktree.path, (name) =>
    ctx.log.emit("session_activity", ticket.id, { text: `gate: ${name}` }),
  );
  const failedStep = gate.results.at(-1)?.name;
  ctx.log.emit("gate_result", ticket.id, {
    ok: gate.ok,
    ...(gate.ok ? {} : { step: failedStep }),
  });
  return gate;
}

/**
 * One round: Implementation → gate → Code Review → QA, stopping at the first
 * step that wants another round. Reviews are sequential — Code Review gates QA,
 * so a code-review failure never pays for a sandbox run.
 */
async function runRound(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  roundDir: string,
  notePath: string,
  round: number,
  history: FeedbackItem[],
): Promise<RoundResult> {
  const decisions: string[] = [];
  const observations: string[] = [];
  const soFar = { decisions, observations, summary: undefined };

  const implementation = await runImplementationStage(
    ctx,
    ticket,
    worktree,
    roundDir,
    notePath,
    round,
    history,
  );
  if (implementation.kind === "retry") {
    const { feedback } = implementation;
    return { ...soFar, step: { kind: "retry", source: "implementation", feedback } };
  }
  if (implementation.kind === "escalate") {
    const { question, recommendation } = implementation;
    await recordEscalation(ctx, ticket, notePath, "implementation", question, recommendation);
    ctx.log.emit("blocked", ticket.id, {
      reason: `escalated: ${question.slice(0, MAX_REASON_CHARS)}`,
    });
    return { ...soFar, step: { kind: "blocked", reason: question } };
  }
  decisions.push(...implementation.decisions);
  observations.push(...implementation.observations);
  const summary = implementation.summary;
  await commitAllIfDirty(worktree.path, `jfdi(${ticket.id}): checkpoint uncommitted work`);

  const gate = await runGateStage(ctx, ticket, worktree);
  if (!gate.ok)
    return {
      decisions,
      observations,
      summary,
      step: { kind: "retry", source: "gate", feedback: formatGateFailure(gate) },
    };

  const review = await runCodeReviewStage(ctx, ticket, worktree, roundDir, notePath, round);
  if (review.kind === "retry") {
    const { feedback } = review;
    return {
      decisions,
      observations,
      summary,
      step: { kind: "retry", source: "code-review", feedback },
    };
  }
  decisions.push(...review.decisions);
  observations.push(...review.observations);

  const qa = await runQaStage(ctx, ticket, worktree, roundDir, notePath, round);
  const qaStep = await judgeQa(ctx, ticket, notePath, qa);
  if (qaStep.kind === "passed") {
    decisions.push(...(qa.verdict?.decisions ?? []));
    observations.push(...(qa.verdict?.observations ?? []));
    await commitAllIfDirty(worktree.path, `jfdi(${ticket.id}): QA artifacts`);
  }
  return { decisions, observations, summary, step: qaStep };
}

/** Turn a QA outcome into the round's verdict, recording an escalation if that's what it is. */
async function judgeQa(
  ctx: PipelineContext,
  ticket: Ticket,
  notePath: string,
  qa: { verdict: ReviewVerdict | null; outcome: StageOutcome },
): Promise<RoundStep> {
  if (qa.verdict?.verdict === "escalate") {
    const question = qa.verdict.question ?? "QA escalated without a stated question.";
    const recommendation = qa.verdict.recommendation ?? "(no recommendation given)";
    await recordEscalation(ctx, ticket, notePath, "qa", question, recommendation);
    ctx.log.emit("blocked", ticket.id, {
      reason: `QA escalated: ${question.slice(0, MAX_REASON_CHARS)}`,
    });
    return { kind: "blocked", reason: question };
  }
  if (!qa.verdict || qa.verdict.verdict === "fail") {
    return {
      kind: "retry",
      source: "qa",
      feedback:
        qa.verdict?.feedback ??
        `QA session did not produce a valid verdict${qa.outcome.ok ? "" : `: ${qa.outcome.resultText.slice(0, MAX_VERDICT_ERROR_CHARS)}`}.`,
    };
  }
  return { kind: "passed", testsAdded: qa.verdict.testsAdded ?? "" };
}

/**
 * The per-ticket pipeline: Implementation → mechanical gate → Code Review → QA,
 * with feedback rounds. Reviews are sequential — Code Review gates QA — and both
 * sign-offs bind to a commit: any fix round re-enters at the gate and repeats both.
 */
export async function runPipeline(ctx: PipelineContext, ticket: Ticket): Promise<PipelineOutcome> {
  const target = ctx.config.integration.target_branch;
  await ensureJfdiGitignore(ctx.jfdiDir);
  const notePath = await ensureTicketNote(ticket, path.join(ctx.repoRoot, ctx.config.ticketsDir));
  const worktree = await createWorktree(ctx.repoRoot, worktreesDir(ctx.jfdiDir), ticket.id, target);
  const runDir = await nextRunDir(ctx.stateDir, ticket.id);
  ctx.log.emit("dispatch", ticket.id, { title: ticket.cardText, branch: worktree.branch });

  const history: FeedbackItem[] = [];
  const allDecisions: string[] = [];
  const allObservations: string[] = [];
  let summary = "";
  const maxRounds = ctx.config.pipeline.max_rounds;

  for (let round = 1; round <= maxRounds; round++) {
    ctx.log.emit("round_start", ticket.id, { round });
    const roundDir = path.join(runDir, `round-${round}`);
    await ensureDir(roundDir);

    const result = await runRound(ctx, ticket, worktree, roundDir, notePath, round, history);
    allDecisions.push(...result.decisions);
    allObservations.push(...result.observations);
    summary = result.summary ?? summary;

    if (result.step.kind === "retry") {
      history.push({ round, source: result.step.source, feedback: result.step.feedback });
      continue;
    }
    if (result.step.kind === "blocked") return { status: "blocked", reason: result.step.reason };

    const finalCommit = await revParse(worktree.path, "HEAD");
    return {
      status: "passed",
      worktree,
      report: {
        summary,
        decisions: allDecisions,
        observations: allObservations,
        testsAdded: result.step.testsAdded,
        rounds: round,
        commit: finalCommit,
      },
    };
  }

  return recordRoundsExhausted(ctx, ticket, notePath, history, maxRounds);
}

/** Rounds exhausted → Blocked, with the accumulated round history in the note. */
async function recordRoundsExhausted(
  ctx: PipelineContext,
  ticket: Ticket,
  notePath: string,
  history: FeedbackItem[],
  maxRounds: number,
): Promise<PipelineOutcome> {
  const historyMd = history
    .map((h) => `- **round ${h.round} (${h.source}):** ${h.feedback.split("\n")[0]}`)
    .join("\n");
  await appendToSection(
    notePath,
    "Questions",
    [
      `### ${todayIsoDate()} — retries exhausted`,
      "",
      `All ${maxRounds} rounds failed. Round history:`,
      "",
      historyMd,
      "",
      `_Full logs: ${runsDir(ctx.stateDir, ticket.id)}/. Adjust the ticket and move it back to "${ctx.config.board.columns.begin}" to retry._`,
    ].join("\n"),
  );
  ctx.log.emit("blocked", ticket.id, { reason: `retries exhausted after ${maxRounds} rounds` });
  return { status: "blocked", reason: `retries exhausted after ${maxRounds} rounds` };
}
