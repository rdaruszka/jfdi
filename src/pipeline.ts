import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JfdiConfig } from "./config.js";
import type { EventLog, StageName } from "./events.js";
import { formatGateFailure, formatGatePass, type GateResult, runGate } from "./gate.js";
import { commitAllIfDirty, createWorktree, git, revParse, type Worktree } from "./git.js";
import type {
  Harness,
  HarnessEvent,
  HarnessResult,
  PromptSpec,
  SpawnOptions,
} from "./harness/index.js";
import type { PauseController } from "./pause.js";
import { formatGateCommands, loadPrompt, type PromptName, renderPrompt } from "./prompts.js";
import {
  type FeedbackItem,
  formatResumeSection,
  loadFeedbackHistory,
  prepareResume,
  type ResumeState,
  saveFeedbackHistory,
} from "./resume.js";
import { ensureJfdiGitignore } from "./scaffold.js";
import {
  collectChangeContext,
  collectStageDelta,
  formatContinuationFeedback,
  formatQaProvenance,
  formatReviewProvenance,
} from "./stage-context.js";
import { appendToSection, ensureTicketNote, type Ticket } from "./tickets.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDir, fileExists, readIfExists } from "./util/fsx.js";
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
  /**
   * The tool-wide hold on agent sessions. Shared by every pipeline and by
   * dispatch, so one provider failure stops the whole tool rather than
   * draining ticket after ticket into Blocked.
   */
  pause: PauseController;
  /** Live sessions register here so a shutdown can kill stray subprocesses. */
  sessions?: Set<{ kill(): void }>;
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

interface RunDirs {
  /** This dispatch's run-<k> directory. */
  current: string;
  /** The previous dispatch's directory, or null if this is the ticket's first run. */
  previous: string | null;
  runNumber: number;
}

/** Next run-<k> directory under runs/<ticket>/ (history is kept across dispatches). */
async function nextRunDir(stateDir: string, ticketId: string): Promise<RunDirs> {
  const base = runsDir(stateDir, ticketId);
  await ensureDir(base);
  const entries = await fs.readdir(base);
  const runCount = entries.filter((e) => /^run-\d+$/.test(e)).length;
  const current = path.join(base, `run-${runCount + 1}`);
  await ensureDir(current);
  return {
    current,
    previous: runCount > 0 ? path.join(base, `run-${runCount}`) : null,
    runNumber: runCount + 1,
  };
}

/**
 * What the pipeline remembers about a stage's most recent session within one
 * run, so a later round can continue that conversation instead of paying for a
 * fresh session to re-derive the same context. In-memory only: a re-dispatched
 * run always starts its stages fresh.
 */
export interface StageSessionMemory {
  /** Absent when the provider never reported an id — the next round runs fresh. */
  sessionId?: string | undefined;
  /** The commit the stage last saw; continuation prompts brief the delta since it. */
  lastSeenCommit?: string | undefined;
}

type ContinuableStage = "implementation" | "code-review" | "qa";

export type SessionMemory = Partial<Record<ContinuableStage, StageSessionMemory>>;

interface StageOutcome {
  ok: boolean;
  resultText: string;
  verdictPath: string;
  sessionId?: string;
}

/** Session progress → TUI activity line; session/result events carry no narration. */
function narrateSessionActivity(
  context: PipelineContext,
  ticketId: string,
  stage: StageName,
  event: HarnessEvent,
): void {
  if (event.type === "tool") {
    context.log.emit("session_activity", ticketId, {
      text: `${stage}: ${event.name}${event.detail ? ` ${event.detail}` : ""}`,
    });
    return;
  }
  if (event.type === "text") {
    const line = event.text.split("\n")[0] ?? "";
    if (line.trim())
      context.log.emit("session_activity", ticketId, {
        text: `${stage}: ${line.slice(0, MAX_ACTIVITY_CHARS)}`,
      });
  }
}

/** One session, start to finish, with its events narrated as they arrive. */
async function runOneSession(
  context: PipelineContext,
  promptSpec: PromptSpec,
  options: SpawnOptions,
  onEvent: (event: HarnessEvent) => void,
): Promise<HarnessResult> {
  const session = context.harness.spawn(promptSpec, options);
  context.sessions?.add(session);
  try {
    for await (const event of session.events) onEvent(event);
    return await session.done;
  } finally {
    context.sessions?.delete(session);
  }
}

/**
 * One harness session, re-run for as long as the provider under it is down.
 * An infrastructure failure is not the agent being wrong about the work: it
 * never reaches the caller, never becomes feedback, and never costs a round.
 *
 * The loop is unbounded by nature — a usage limit lasts as long as it lasts —
 * but every pass yields to the pause controller, and both exits are reachable:
 * a session the provider actually answered, or a stopped controller.
 */
export async function runHeldSession(
  context: PipelineContext,
  ticketId: string,
  promptSpec: PromptSpec,
  options: SpawnOptions,
  onEvent: (event: HarnessEvent) => void,
): Promise<HarnessResult> {
  for (let attempt = 1; ; attempt++) {
    await context.pause.waitWhilePaused();
    const result = await runOneSession(context, promptSpec, options, onEvent);
    if (!result.failure) {
      context.pause.reportHealthy();
      return result;
    }
    context.log.emit("session_activity", ticketId, {
      text: `harness ${result.failure.kind}: ${result.failure.detail}`,
    });
    // Shutting down is the one way out that is not a working provider; the
    // caller then sees the failed session exactly as it did before this hold.
    if (!(await context.pause.holdAfterFailure(result.failure, attempt))) return result;
  }
}

async function runStageSession(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  prompt: string,
  roundDir: string,
  continueSessionId?: string,
): Promise<StageOutcome> {
  const verdictPath = path.join(roundDir, `${stage}.verdict.json`);
  const logPath = path.join(roundDir, `${stage}.log.jsonl`);
  context.log.emit("stage_start", ticket.id, {
    stage,
    ...(continueSessionId ? { isContinuation: true } : {}),
  });
  const result = await runHeldSession(
    context,
    ticket.id,
    { prompt },
    { cwd: worktree.path, logPath, ...(continueSessionId ? { continueSessionId } : {}) },
    (event) => narrateSessionActivity(context, ticket.id, stage, event),
  );
  return {
    ok: result.ok,
    resultText: result.text,
    verdictPath,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

interface ContinuationSpec {
  sessionId: string;
  prompt: string;
}

/**
 * Run a stage, continuing its previous session when one exists. A continuation
 * that dies without writing a verdict falls back to one fresh session with the
 * full prompt — providers forget sessions, and a forgotten session must cost a
 * fallback, never the round.
 */
async function runStageWithFallback(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  roundDir: string,
  freshPrompt: () => Promise<string>,
  continuation: ContinuationSpec | null,
): Promise<StageOutcome> {
  if (continuation) {
    const outcome = await runStageSession(
      context,
      ticket,
      worktree,
      stage,
      continuation.prompt,
      roundDir,
      continuation.sessionId,
    );
    if (outcome.ok || (await fileExists(outcome.verdictPath))) return outcome;
    context.log.emit("session_activity", ticket.id, {
      text: `${stage}: continuation failed; restarting fresh`,
    });
  }
  return runStageSession(context, ticket, worktree, stage, await freshPrompt(), roundDir);
}

async function stagePrompt(
  context: PipelineContext,
  name: PromptName,
  variables: Record<string, string>,
): Promise<string> {
  const template = await loadPrompt(context.jfdiDir, name);
  return renderPrompt(template, variables);
}

function commonVars(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  verdictPath: string,
): Record<string, string> {
  return {
    TICKET_ID: ticket.id,
    SPEC: ticket.spec,
    BRANCH: worktree.branch,
    TARGET_BRANCH: context.config.integration.target_branch,
    GATE_COMMANDS: formatGateCommands(context.config.gate),
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
      parts.push(`### Run ${item.run}, round ${item.round} — ${label}\n\n${item.feedback}\n`);
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
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  stage: string,
  question: string,
  recommendation: string,
): Promise<void> {
  const beginColumn = context.config.board.columns.begin;
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
  context.log.emit("escalation", ticket.id, { stage, question, recommendation });
}

export interface QaStageOptions {
  /** Rendered into the prompt's gate slot; empty means "say nothing about the gate". */
  gateSummary?: string | undefined;
  /** Continue this earlier QA session instead of starting fresh. */
  previousSession?: StageSessionMemory | undefined;
  /** Why the branch moved since that session — provenance for the continuation. */
  previousFailure?: FeedbackItem | undefined;
}

/** Run QA alone (used post-rebase on a complicated merge). */
export async function runQaStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  roundDir: string,
  notePath: string,
  round: number,
  options: QaStageOptions = {},
): Promise<{ verdict: ReviewVerdict | null; outcome: StageOutcome }> {
  const target = context.config.integration.target_branch;
  const verdictPath = path.join(roundDir, "qa.verdict.json");
  const vars = {
    ...commonVars(context, ticket, worktree, verdictPath),
    NOTE_PATH: notePath,
    GATE_RESULT: options.gateSummary ?? "",
  };
  const continuation = await buildQaContinuation(context, worktree, vars, options);
  const freshPrompt = async () => {
    const sandbox =
      (await readIfExists(path.join(context.jfdiDir, "sandbox.md"))) ??
      "(no sandbox contract found — exercise the artifact as best you can and say so in your feedback)";
    const change = await collectChangeContext(worktree.path, target);
    return stagePrompt(context, "qa", {
      ...vars,
      SANDBOX: sandbox,
      COMMIT_LOG: change.commitLog,
      DIFF_STAT: change.diffStat,
    });
  };
  const outcome = await runStageWithFallback(
    context,
    ticket,
    worktree,
    "qa",
    roundDir,
    freshPrompt,
    continuation,
  );
  const verdict = await readReviewVerdict(outcome.verdictPath, { isEscalateAllowed: true });
  if (verdict) await recordDecisions(notePath, "qa", round, verdict.decisions);
  context.log.emit("stage_end", ticket.id, {
    stage: "qa",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
  });
  return { verdict, outcome };
}

async function buildQaContinuation(
  context: PipelineContext,
  worktree: Worktree,
  vars: Record<string, string>,
  options: QaStageOptions,
): Promise<ContinuationSpec | null> {
  const { previousSession, previousFailure } = options;
  if (!previousSession?.sessionId || !previousSession.lastSeenCommit || !previousFailure)
    return null;
  const delta = await collectStageDelta(worktree.path, previousSession.lastSeenCommit);
  const headCommit = await revParse(worktree.path, "HEAD");
  return {
    sessionId: previousSession.sessionId,
    prompt: await stagePrompt(context, "qa-continue", {
      ...vars,
      LAST_SEEN_COMMIT: previousSession.lastSeenCommit,
      HEAD_COMMIT: headCommit,
      PROVENANCE: formatQaProvenance(previousFailure),
      NEW_COMMITS: delta.newCommits,
      TOUCHED_FILES: delta.touchedFiles,
    }),
  };
}

type ImplementationStep =
  | { kind: "done"; summary: string | undefined; decisions: string[]; observations: string[] }
  | { kind: "retry"; feedback: string }
  | { kind: "escalate"; question: string; recommendation: string };

interface ImplementationStageInput {
  roundDir: string;
  notePath: string;
  round: number;
  history: FeedbackItem[];
  resume: ResumeState | null;
  previousSession: StageSessionMemory | undefined;
}

async function runImplementationStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: ImplementationStageInput,
): Promise<{ step: ImplementationStep; sessionId: string | undefined }> {
  const { roundDir, notePath, round, history, resume } = input;
  const verdictPath = path.join(roundDir, "implementation.verdict.json");
  const vars = commonVars(context, ticket, worktree, verdictPath);
  const previousFailure = history.at(-1);
  const continuation =
    input.previousSession?.sessionId && previousFailure
      ? {
          sessionId: input.previousSession.sessionId,
          prompt: await stagePrompt(context, "implementation-continue", {
            ...vars,
            FEEDBACK: formatContinuationFeedback(previousFailure),
          }),
        }
      : null;
  const freshPrompt = () =>
    stagePrompt(context, "implementation", {
      ...vars,
      RESUME_SECTION: formatResumeSection(
        resume,
        worktree.branch,
        context.config.integration.target_branch,
      ),
      FEEDBACK_SECTION: formatFeedbackSection(history, ticket.mode),
    });
  const outcome = await runStageWithFallback(
    context,
    ticket,
    worktree,
    "implementation",
    roundDir,
    freshPrompt,
    continuation,
  );
  const sessionId = outcome.sessionId;
  const verdict = await readImplementationVerdict(outcome.verdictPath);
  context.log.emit("stage_end", ticket.id, {
    stage: "implementation",
    verdict: verdict?.status ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
  });
  if (!verdict) {
    return {
      sessionId,
      step: {
        kind: "retry",
        feedback: outcome.ok
          ? "The previous implementation session ended without writing a valid verdict file. Re-verify the work is complete, committed, and gate-passing, then write the verdict file as instructed."
          : `The previous implementation session failed: ${outcome.resultText.slice(0, MAX_SESSION_ERROR_CHARS)}`,
      },
    };
  }
  const decisions = await recordDecisions(notePath, "implementation", round, verdict.decisions);
  if (verdict.status === "escalate") {
    return {
      sessionId,
      step: {
        kind: "escalate",
        question: verdict.question ?? "Escalated without a stated question.",
        recommendation: verdict.recommendation ?? "(no recommendation given)",
      },
    };
  }
  return {
    sessionId,
    step: {
      kind: "done",
      summary: verdict.summary,
      decisions,
      observations: verdict.observations ?? [],
    },
  };
}

type CodeReviewStep =
  | { kind: "pass"; decisions: string[]; observations: string[] }
  | { kind: "retry"; feedback: string };

interface CodeReviewStageInput {
  roundDir: string;
  notePath: string;
  round: number;
  /** The gate result that admitted this commit to review, quoted into the prompt. */
  gate: GateResult;
  headCommit: string;
  previousSession: StageSessionMemory | undefined;
  previousFailure: FeedbackItem | undefined;
}

async function runCodeReviewStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: CodeReviewStageInput,
): Promise<{ step: CodeReviewStep; sessionId: string | undefined }> {
  const target = context.config.integration.target_branch;
  const verdictPath = path.join(input.roundDir, "code-review.verdict.json");
  const vars = {
    ...commonVars(context, ticket, worktree, verdictPath),
    NOTE_PATH: input.notePath,
    GATE_RESULT: formatGatePass(input.gate),
  };
  const { previousSession, previousFailure } = input;
  const continuation =
    previousSession?.sessionId && previousSession.lastSeenCommit && previousFailure
      ? {
          sessionId: previousSession.sessionId,
          prompt: await stagePrompt(context, "code-review-continue", {
            ...vars,
            LAST_SEEN_COMMIT: previousSession.lastSeenCommit,
            HEAD_COMMIT: input.headCommit,
            PROVENANCE: formatReviewProvenance(previousFailure),
            ...(await collectStageDelta(worktree.path, previousSession.lastSeenCommit).then(
              (delta) => ({ NEW_COMMITS: delta.newCommits, TOUCHED_FILES: delta.touchedFiles }),
            )),
          }),
        }
      : null;
  const freshPrompt = async () => {
    const change = await collectChangeContext(worktree.path, target);
    return stagePrompt(context, "code-review", {
      ...vars,
      COMMIT_LOG: change.commitLog,
      DIFF_STAT: change.diffStat,
      DIFF_SECTION: change.diffSection,
    });
  };
  const outcome = await runStageWithFallback(
    context,
    ticket,
    worktree,
    "code-review",
    input.roundDir,
    freshPrompt,
    continuation,
  );
  // Reviewers are read-only; discard any stray modifications.
  await git(worktree.path, "checkout", "--", ".");
  const verdict = await readReviewVerdict(outcome.verdictPath, { isEscalateAllowed: false });
  context.log.emit("stage_end", ticket.id, {
    stage: "code-review",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
  });
  if (!verdict || verdict.verdict === "fail") {
    return {
      sessionId: outcome.sessionId,
      step: {
        kind: "retry",
        feedback:
          verdict?.feedback ??
          (verdict
            ? "Code review failed without specific feedback."
            : `Code review session did not produce a valid verdict${outcome.ok ? "" : `: ${outcome.resultText.slice(0, MAX_VERDICT_ERROR_CHARS)}`}.`),
      },
    };
  }
  const decisions = await recordDecisions(
    input.notePath,
    "code-review",
    input.round,
    verdict.decisions,
  );
  return {
    sessionId: outcome.sessionId,
    step: { kind: "pass", decisions, observations: verdict.observations ?? [] },
  };
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
  /** Session memory for the next round: which conversations can be continued. */
  memory: SessionMemory;
}

/** The mechanical gate, with its start/result events. Cheapest reviewer, runs first, always. */
async function runGateStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
): Promise<GateResult> {
  context.log.emit("gate_start", ticket.id);
  const gate = await runGate(context.config.gate, worktree.path, (name) =>
    context.log.emit("session_activity", ticket.id, { text: `gate: ${name}` }),
  );
  const failedStep = gate.results.at(-1)?.name;
  context.log.emit("gate_result", ticket.id, {
    ok: gate.ok,
    ...(gate.ok ? {} : { step: failedStep }),
  });
  return gate;
}

interface RoundInput {
  roundDir: string;
  notePath: string;
  round: number;
  history: FeedbackItem[];
  resume: ResumeState | null;
  memory: SessionMemory;
}

/**
 * One round: Implementation → gate → Code Review → QA → gate again if QA
 * committed, stopping at the first step that wants another round. Reviews are
 * sequential — Code Review gates QA, so a code-review failure never pays for a
 * sandbox run. Stages that already ran this run are continued, not restarted.
 */
async function runRound(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: RoundInput,
): Promise<RoundResult> {
  const { roundDir, notePath, round, history, resume } = input;
  const memory: SessionMemory = { ...input.memory };
  const previousFailure = history.at(-1);
  const decisions: string[] = [];
  const observations: string[] = [];
  // Nothing has been collected until Implementation returns, so the two exits
  // below report empty rather than sharing the arrays the rest of the function
  // pushes into. Fresh arrays per call: no exit aliases another's.
  const nothingCollected = (): Pick<RoundResult, "decisions" | "observations" | "summary"> => ({
    decisions: [],
    observations: [],
    summary: undefined,
  });

  const implementation = await runImplementationStage(context, ticket, worktree, {
    roundDir,
    notePath,
    round,
    history,
    resume,
    previousSession: memory.implementation,
  });
  memory.implementation = { sessionId: implementation.sessionId };
  if (implementation.step.kind === "retry") {
    const { feedback } = implementation.step;
    return {
      ...nothingCollected(),
      memory,
      step: { kind: "retry", source: "implementation", feedback },
    };
  }
  if (implementation.step.kind === "escalate") {
    const { question, recommendation } = implementation.step;
    await recordEscalation(context, ticket, notePath, "implementation", question, recommendation);
    context.log.emit("blocked", ticket.id, {
      reason: `escalated: ${question.slice(0, MAX_REASON_CHARS)}`,
    });
    return { ...nothingCollected(), memory, step: { kind: "blocked", reason: question } };
  }
  decisions.push(...implementation.step.decisions);
  observations.push(...implementation.step.observations);
  const summary = implementation.step.summary;
  await commitAllIfDirty(worktree.path, `jfdi(${ticket.id}): checkpoint uncommitted work`);

  const gate = await runGateStage(context, ticket, worktree);
  if (!gate.ok)
    return {
      decisions,
      observations,
      summary,
      memory,
      step: { kind: "retry", source: "gate", feedback: formatGateFailure(gate) },
    };

  const headCommit = await revParse(worktree.path, "HEAD");
  const review = await runCodeReviewStage(context, ticket, worktree, {
    roundDir,
    notePath,
    round,
    gate,
    headCommit,
    previousSession: memory["code-review"],
    previousFailure,
  });
  memory["code-review"] = { sessionId: review.sessionId, lastSeenCommit: headCommit };
  if (review.step.kind === "retry") {
    const { feedback } = review.step;
    return {
      decisions,
      observations,
      summary,
      memory,
      step: { kind: "retry", source: "code-review", feedback },
    };
  }
  decisions.push(...review.step.decisions);
  observations.push(...review.step.observations);

  const qa = await runQaStage(context, ticket, worktree, roundDir, notePath, round, {
    gateSummary: formatGatePass(gate),
    previousSession: memory.qa,
    previousFailure,
  });
  const qaSeenCommit = await revParse(worktree.path, "HEAD");
  memory.qa = { sessionId: qa.outcome.sessionId, lastSeenCommit: qaSeenCommit };
  const qaStep = await judgeQa(context, ticket, notePath, qa);
  if (qaStep.kind !== "passed") return { decisions, observations, summary, memory, step: qaStep };

  decisions.push(...(qa.verdict?.decisions ?? []));
  observations.push(...(qa.verdict?.observations ?? []));
  await commitAllIfDirty(worktree.path, `jfdi(${ticket.id}): QA artifacts`);
  // QA's committed tests are code the reviewed gate never saw. Re-running the
  // gate here is the pipeline's job, not QA's — a session re-running a suite
  // the machine can run for free is wasted context.
  const qaHead = await revParse(worktree.path, "HEAD");
  if (qaHead !== headCommit) {
    memory.qa = { sessionId: qa.outcome.sessionId, lastSeenCommit: qaHead };
    const postQaGate = await runGateStage(context, ticket, worktree);
    if (!postQaGate.ok)
      return {
        decisions,
        observations,
        summary,
        memory,
        step: {
          kind: "retry",
          source: "gate",
          feedback: `The mechanical gate failed after QA committed its tests.\n\n${formatGateFailure(postQaGate)}`,
        },
      };
  }
  return { decisions, observations, summary, memory, step: qaStep };
}

/** Turn a QA outcome into the round's verdict, recording an escalation if that's what it is. */
async function judgeQa(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  qa: { verdict: ReviewVerdict | null; outcome: StageOutcome },
): Promise<RoundStep> {
  if (qa.verdict?.verdict === "escalate") {
    const question = qa.verdict.question ?? "QA escalated without a stated question.";
    const recommendation = qa.verdict.recommendation ?? "(no recommendation given)";
    await recordEscalation(context, ticket, notePath, "qa", question, recommendation);
    context.log.emit("blocked", ticket.id, {
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
 * Round 1 of every stage is a fresh session; later rounds continue the stage's
 * own session so it keeps its context instead of re-deriving it.
 */
export async function runPipeline(
  context: PipelineContext,
  ticket: Ticket,
): Promise<PipelineOutcome> {
  const target = context.config.integration.target_branch;
  await ensureJfdiGitignore(context.jfdiDir);
  const notePath = await ensureTicketNote(
    ticket,
    path.join(context.repoRoot, context.config.ticketsDir),
  );
  const worktree = await createWorktree(
    context.repoRoot,
    worktreesDir(context.jfdiDir),
    ticket.id,
    target,
  );
  const runDirs = await nextRunDir(context.stateDir, ticket.id);
  context.log.emit("dispatch", ticket.id, { title: ticket.cardText, branch: worktree.branch });

  // A re-dispatched ticket may carry partial work and a half-finished git
  // state from a run that died; sanitize both before any session sees them.
  const resume = await prepareResume(worktree.path, target, ticket.id);
  if (resume)
    context.log.emit("resumed", ticket.id, {
      commitCount: resume.commitCount,
      hasCheckpointedChanges: resume.hasCheckpointedChanges,
      hasAbortedRebase: resume.hasAbortedRebase,
    });

  // Why the previous run failed, recovered from disk; `history` is this run's own.
  const priorHistory = runDirs.previous ? await loadFeedbackHistory(runDirs.previous) : [];
  const history: FeedbackItem[] = [];
  const allDecisions: string[] = [];
  const allObservations: string[] = [];
  let summary = "";
  let memory: SessionMemory = {};
  const maxRounds = context.config.pipeline.max_rounds;

  for (let round = 1; round <= maxRounds; round++) {
    context.log.emit("round_start", ticket.id, { round });
    const roundDir = path.join(runDirs.current, `round-${round}`);
    await ensureDir(roundDir);

    const result = await runRound(context, ticket, worktree, {
      roundDir,
      notePath,
      round,
      history: [...priorHistory, ...history],
      // Only the first session of the run inherits an interrupted state; later
      // rounds work on top of commits this run made itself.
      resume: round === 1 ? resume : null,
      memory,
    });
    memory = result.memory;
    allDecisions.push(...result.decisions);
    allObservations.push(...result.observations);
    summary = result.summary ?? summary;

    if (result.step.kind === "retry") {
      history.push({
        run: runDirs.runNumber,
        round,
        source: result.step.source,
        feedback: result.step.feedback,
      });
      await saveFeedbackHistory(runDirs.current, history);
      continue;
    }
    if (result.step.kind === "blocked") {
      // A blocked run concluded nothing: the session saw the inherited feedback
      // but stopped on a question instead of answering it. So the *inherited*
      // items stay unanswered business too, and are carried forward — unlike a
      // retry, where the next round re-reads them from memory anyway.
      await saveFeedbackHistory(runDirs.current, [...priorHistory, ...history]);
      return { status: "blocked", reason: result.step.reason };
    }

    // The run finished: earlier rounds' feedback was addressed, so it is no
    // longer unfinished business for a later dispatch to inherit.
    await saveFeedbackHistory(runDirs.current, []);
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

  return recordRoundsExhausted(context, ticket, notePath, history, maxRounds);
}

/** Rounds exhausted → Blocked, with the accumulated round history in the note. */
async function recordRoundsExhausted(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  history: FeedbackItem[],
  maxRounds: number,
): Promise<PipelineOutcome> {
  const historyMarkdown = history
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
      historyMarkdown,
      "",
      `_Full logs: ${runsDir(context.stateDir, ticket.id)}/. Adjust the ticket and move it back to "${context.config.board.columns.begin}" to retry._`,
    ].join("\n"),
  );
  context.log.emit("blocked", ticket.id, { reason: `retries exhausted after ${maxRounds} rounds` });
  return { status: "blocked", reason: `retries exhausted after ${maxRounds} rounds` };
}
