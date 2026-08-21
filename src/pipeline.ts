import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JfdiConfig, SessionConfig } from "./config.js";
import type { EventLog, StageName } from "./events.js";
import { formatGateFailure, formatGatePass, type GateResult, runGate } from "./gate.js";
import { createWorktree, git, hasStagedChanges, parseRevision, type Worktree } from "./git.js";
import type {
  HarnessEvent,
  Harness,
  HarnessResult,
  SessionHarnesses,
  SessionKind,
  SessionUsage,
  SpawnOptions,
} from "./harness/index.js";
import type { PauseController } from "./pause.js";
import { formatGateCommands, loadPrompt, type PromptName, renderPrompt } from "./prompts.js";
import {
  FeedbackHistoryError,
  type FeedbackItem,
  formatResumeSection,
  loadFeedbackHistory,
  prepareResume,
  type ResumeState,
  saveFeedbackHistory,
} from "./resume.js";
import { ensureJfdiGitignore } from "./scaffold.js";
import {
  assembleCommitMessage,
  assembleStageComment,
  collectCommitContext,
  type SessionHandoff,
  scribeVariables,
} from "./scribe.js";
import {
  collectChangeContext,
  collectStageDelta,
  formatContinuationFeedback,
  formatQaProvenance,
  formatReviewProvenance,
} from "./stage-context.js";
import { appendToSection, quoteAgentText } from "./ticket-note.js";
import { ensureTicketNote, type Ticket } from "./tickets.js";
import {
  BLOCKED_ROUTING,
  recordPhase,
  recordTransition,
  retryRouting,
  STAGE_LABELS,
  shortSha,
} from "./transitions.js";
import { resolveUsageModel, type UsageRegistry, type UsageRow } from "./usage.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDirectory, fileExists, readIfExists } from "./util/fsx.js";
import {
  agentVerdictPath,
  collectVerdict,
  type ReviewVerdict,
  readImplementationVerdict,
  readReviewVerdict,
  type VerdictReadResult,
} from "./verdicts.js";

type MeasuredHarnessResult = HarnessResult & { usage: SessionUsage };

export interface PipelineContext {
  projectRoot: string;
  /** Absolute path to .jfdi/ — versioned setup (config, prompts, sandbox) + worktrees. */
  jfdiDirectory: string;
  /** Absolute path to ~/.jfdi/projects/<project-key>/ — runs, events, state snapshot. */
  stateDirectory: string;
  config: JfdiConfig;
  /** One harness per `stages` entry, as the config selected them. */
  harnesses: SessionHarnesses;
  log: EventLog;
  /**
   * The tool-wide hold on agent sessions. Shared by every pipeline and by
   * dispatch, so one provider failure stops the whole tool rather than
   * draining ticket after ticket into Blocked.
   */
  pause: PauseController;
  /** Live sessions register here so a shutdown can kill stray subprocesses. */
  sessions?: Set<{ kill(): void }>;
  /**
   * Per-ticket cost/time tallies. Every session adds itself as it ends, so the
   * merge table and the running status totals both read from one place. Keyed by
   * ticket because one context serves the coordinator's concurrent runs.
   */
  usage: UsageRegistry;
  /**
   * Wall-clock source for session timing, injectable so tests pin durations with
   * a stepping clock instead of sleeping. Defaults to `Date.now`.
   */
  now?: () => number;
}

/** The context's clock, or the real one when none was injected. */
function nowMs(context: PipelineContext): number {
  return (context.now ?? Date.now)();
}

export interface RunReport {
  summary: string;
  decisions: string[];
  /** Out-of-scope issues stages spotted; the caller proposes them as inbox cards. */
  observations: string[];
  testsAdded: string;
  rounds: number;
  commit: string;
  /** Per-stage model/cost/time tally for this run's table. Scribe included; integration not yet. */
  usageRows: UsageRow[];
  /** Dispatch → merge-ready wall-clock, labeled `elapsed` beside agent time. */
  elapsedMs: number;
}

export type PipelineOutcome =
  | { status: "passed"; worktree: Worktree; report: RunReport }
  | { status: "blocked"; reason: string; observations: string[] }
  | { status: "failed"; reason: string; observations: string[] };

export function worktreesDirectory(jfdiDirectory: string): string {
  return path.join(jfdiDirectory, "worktrees");
}

export function runsDirectory(stateDirectory: string, ticketId: string): string {
  return path.join(stateDirectory, "runs", ticketId);
}

interface RunDirectories {
  /** This dispatch's run-<k> directory. */
  current: string;
  /** The previous dispatch's directory, or null if this is the ticket's first run. */
  previous: string | null;
  runNumber: number;
}

/** Next run-<k> directory under runs/<ticket>/ (history is kept across dispatches). */
async function nextRunDirectory(stateDirectory: string, ticketId: string): Promise<RunDirectories> {
  const base = runsDirectory(stateDirectory, ticketId);
  await ensureDirectory(base);
  const entries = await fs.readdir(base);
  const runNumbers = entries.flatMap((entry) => {
    const match = /^run-(\d+)$/.exec(entry);
    return match?.[1] ? [Number(match[1])] : [];
  });
  const latestRunNumber = Math.max(0, ...runNumbers);
  const nextRunNumber = latestRunNumber + 1;
  const current = path.join(base, `run-${nextRunNumber}`);
  return {
    current,
    previous: runNumbers.length > 0 ? path.join(base, `run-${latestRunNumber}`) : null,
    runNumber: nextRunNumber,
  };
}

/** The warning a malformed tool-owned history file leaves for the operator. */
function malformedFeedbackHistoryWarning(error: FeedbackHistoryError): string {
  return [
    `WARNING: Malformed feedback history at ${error.filePath} blocked this run: ${error.failure}.`,
    "",
    "Offending content:",
    "",
    "```json",
    error.offendingContent,
    "```",
    "",
    "Fix the file to resume with its feedback intact, or delete it to deliberately resume without history. Moving the card back before doing one of those will block it again.",
  ].join("\n");
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
  /** Harness and selection locked when this stage first fired in the run. */
  agent?: LockedStageAgent | undefined;
}

type ContinuableStage = "implementation" | "code-review" | "qa";

export type SessionMemory = Partial<Record<ContinuableStage, StageSessionMemory>>;

interface StageOutcome {
  ok: boolean;
  resultText: string;
  verdictPath: string;
  sessionId?: string;
  /**
   * HEAD before the stage's first session of this round — the reset target that
   * makes "agents never commit" true rather than hoped for.
   */
  preSessionHead: string;
  /** What this session cost and took — for its handoff commit's trailers. */
  usage: SessionUsage;
  /** The stage-local agent selection, retained through corrections and later rounds. */
  agent: LockedStageAgent;
}

export interface LockedStageAgent {
  harness: Harness;
  config: SessionConfig;
}

function currentStageAgent(context: PipelineContext, stage: StageName): LockedStageAgent {
  return { harness: context.harnesses[stage], config: context.config.stages[stage] };
}

/** Session progress → TUI activity line; session/result events carry no narration. */
function narrateSessionActivity(
  context: PipelineContext,
  ticketId: string,
  sessionKind: SessionKind,
  event: HarnessEvent,
): void {
  if (event.type === "tool") {
    context.log.emit("session_activity", ticketId, {
      text: `${sessionKind}: ${event.name}${event.detail ? ` ${event.detail}` : ""}`,
    });
    return;
  }
  if (event.type === "text") {
    const line = event.text.split("\n")[0] ?? "";
    if (line.trim())
      context.log.emit("session_activity", ticketId, {
        text: `${sessionKind}: ${line}`,
      });
  }
}

/**
 * One `stages` entry's configured agent selection, as `stage_start` records it.
 * Provider-confirmed models arrive later through session usage on `stage_end`.
 */
export function sessionSelectionFields(
  config: JfdiConfig,
  sessionKind: SessionKind,
): Record<string, string> {
  return selectionFields(config.stages[sessionKind]);
}

function selectionFields(selection: SessionConfig): Record<string, string> {
  return {
    harness: selection.harness,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  };
}

/**
 * The model/cost/time a `stage_end` carries: this session's own values, plus
 * the run's cumulative totals so a renderer can show a running per-ticket
 * figure from the stream alone. The cumulative is read after the session was
 * tallied, so it includes it. `runCostUsd` is null when any session was unpriced.
 */
function stageUsageFields(
  context: PipelineContext,
  ticketId: string,
  sessionKind: SessionKind,
  usage: SessionUsage,
  selection: SessionConfig = context.config.stages[sessionKind],
): Record<string, unknown> {
  const totals = context.usage.of(ticketId).totals();
  const model = resolveUsageModel(usage, selection.model);
  return {
    ...(model === null ? {} : { model: model.name, modelSource: model.source }),
    durationMs: usage.durationMs,
    costUsd: usage.costUsd,
    tokens: usage.inputTokens + usage.outputTokens,
    runAgentMs: totals.durationMs,
    runCostUsd: totals.costUsd,
    runTokens: totals.totalTokens,
  };
}

/**
 * Set a session's wall-clock on its usage, synthesizing a minimal usage when the
 * provider reported none (an early crash still cost real time). Duration is the
 * pipeline's own measure — never the provider's — so it is always present.
 */
function withDuration(result: HarnessResult, durationMs: number): MeasuredHarnessResult {
  const usage: SessionUsage = result.usage
    ? { ...result.usage, durationMs }
    : {
        durationMs,
        costUsd: null,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
  return { ...result, usage };
}

/** One session, start to finish, with its events narrated as they arrive. */
async function runOneSession(
  context: PipelineContext,
  harness: Harness,
  prompt: string,
  options: SpawnOptions,
  onEvent: (event: HarnessEvent) => void,
): Promise<MeasuredHarnessResult> {
  const session = harness.spawn(prompt, options);
  context.sessions?.add(session);
  const startedMs = nowMs(context);
  try {
    for await (const event of session.events) onEvent(event);
    return withDuration(await session.done, nowMs(context) - startedMs);
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
 *
 * A retry continues the dead session when the provider named one — whatever it
 * had already done is still worth having — and is otherwise the same spawn with
 * the same prompt. A provider that has forgotten the session leaves the caller's
 * existing fresh-session fallback to catch it.
 */
export async function runHeldSession(
  context: PipelineContext,
  ticketId: string,
  sessionKind: SessionKind,
  prompt: string,
  options: SpawnOptions,
  onEvent: (event: HarnessEvent) => void,
  lockedAgent?: LockedStageAgent,
): Promise<MeasuredHarnessResult> {
  const agent = lockedAgent ?? {
    harness: context.harnesses[sessionKind],
    config: context.config.stages[sessionKind],
  };
  let attemptOptions = options;
  // Provider-failure retries are one logical session: their wall-clock all
  // counts as agent time, but the tokens/cost come from the attempt that
  // actually answered (the last one), so only the returned result is tallied.
  let accumulatedMs = 0;
  for (let attempt = 1; ; attempt++) {
    await context.pause.waitWhilePaused();
    const result = await runOneSession(context, agent.harness, prompt, attemptOptions, onEvent);
    accumulatedMs += result.usage.durationMs;
    if (!result.failure) {
      context.pause.reportHealthy();
      return tallied(
        context,
        ticketId,
        sessionKind,
        withDuration(result, accumulatedMs),
        agent.config,
      );
    }
    if (result.sessionId) attemptOptions = { ...options, continueSessionId: result.sessionId };
    context.log.emit("session_activity", ticketId, {
      text: `harness ${result.failure.kind}: ${result.failure.detail}`,
    });
    // Shutting down is the one way out that is not a working provider; the
    // caller then sees the failed session exactly as it did before this hold.
    if (!(await context.pause.holdAfterFailure(result.failure, attempt)))
      return tallied(
        context,
        ticketId,
        sessionKind,
        withDuration(result, accumulatedMs),
        agent.config,
      );
  }
}

/** Add a finished session to the ticket's ledger, then return it unchanged. */
function tallied(
  context: PipelineContext,
  ticketId: string,
  sessionKind: SessionKind,
  result: MeasuredHarnessResult,
  selection: SessionConfig,
): MeasuredHarnessResult {
  context.usage.add(ticketId, sessionKind, result.usage, selection.model);
  return result;
}

async function runStageSession(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  prompt: string,
  roundDirectory: string,
  preSessionHead: string,
  agent: LockedStageAgent,
  continueSessionId?: string,
): Promise<StageOutcome> {
  const verdictPath = path.join(roundDirectory, `${stage}.verdict.json`);
  const logPath = path.join(roundDirectory, `${stage}.log.jsonl`);
  context.log.emit("stage_start", ticket.id, {
    stage,
    ...selectionFields(agent.config),
    ...(continueSessionId ? { isContinuation: true } : {}),
  });
  const result = await runHeldSession(
    context,
    ticket.id,
    stage,
    prompt,
    { cwd: worktree.path, logPath, ...(continueSessionId ? { continueSessionId } : {}) },
    (event) => narrateSessionActivity(context, ticket.id, stage, event),
    agent,
  );
  // The agent wrote its verdict inside the worktree (the only place sandboxed
  // permission modes allow); collect it before anything commits the tree.
  await collectVerdict(agentVerdictPath(worktree.path, stage), verdictPath);
  return {
    ok: result.ok,
    resultText: result.text,
    verdictPath,
    preSessionHead,
    usage: result.usage,
    agent,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

interface ContinuationSpecification {
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
  roundDirectory: string,
  freshPrompt: () => Promise<string>,
  continuation: ContinuationSpecification | null,
  lockedAgent?: LockedStageAgent,
): Promise<StageOutcome> {
  // One reset target for the whole stage: a fallback session inherits whatever
  // the continuation left, and both are folded into the same handoff commit.
  const preSessionHead = await parseRevision(worktree.path, "HEAD");
  if (continuation) {
    const agent = lockedAgent ?? currentStageAgent(context, stage);
    const outcome = await runStageSession(
      context,
      ticket,
      worktree,
      stage,
      continuation.prompt,
      roundDirectory,
      preSessionHead,
      agent,
      continuation.sessionId,
    );
    if (outcome.ok || (await fileExists(outcome.verdictPath))) return outcome;
    context.log.emit("session_activity", ticket.id, {
      text: `${stage}: continuation failed; restarting fresh`,
    });
  }
  const prompt = await freshPrompt();
  const agent = lockedAgent ?? currentStageAgent(context, stage);
  return runStageSession(
    context,
    ticket,
    worktree,
    stage,
    prompt,
    roundDirectory,
    preSessionHead,
    agent,
  );
}

interface StageVerdictResult<Verdict> {
  verdict: Verdict | null;
  outcome: StageOutcome;
  /** Present only when an existing verdict stayed invalid through both corrections. */
  invalidVerdictFailure?: string;
}

type StageVerdictReader<Verdict> = (
  verdictPath: string,
  reportedPath: string,
) => Promise<VerdictReadResult<Verdict>>;

/** One correction attempt, with a forgotten continuation falling back inside the attempt. */
async function runVerdictCorrectionAttempt(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  attemptDirectory: string,
  prompt: string,
  preSessionHead: string,
  sessionId: string | undefined,
  agent: LockedStageAgent,
): Promise<StageOutcome> {
  await ensureDirectory(attemptDirectory);
  if (sessionId) {
    const outcome = await runStageSession(
      context,
      ticket,
      worktree,
      stage,
      prompt,
      attemptDirectory,
      preSessionHead,
      agent,
      sessionId,
    );
    if (outcome.ok || (await fileExists(outcome.verdictPath))) return outcome;
    context.log.emit("session_activity", ticket.id, {
      text: `${stage}: verdict correction continuation failed; restarting fresh`,
    });
  }
  return runStageSession(
    context,
    ticket,
    worktree,
    stage,
    prompt,
    attemptDirectory,
    preSessionHead,
    agent,
  );
}

function verdictCorrectionPrompt(error: string, verdictPath: string): string {
  return [
    `Output does not meet spec: ${error}`,
    "",
    `Correct the verdict file at ${verdictPath}. Write only the required JSON object there; do not redo the stage's work.`,
  ].join("\n");
}

/**
 * Read a stage verdict, returning an existing invalid file to its author twice
 * inside the current round. An absent original file remains the caller's
 * session-failure path; only output that reached the sink but missed spec uses
 * this correction mechanism.
 */
async function readStageVerdictWithCorrections<Verdict>(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  roundDirectory: string,
  initialOutcome: StageOutcome,
  readVerdict: StageVerdictReader<Verdict>,
): Promise<StageVerdictResult<Verdict>> {
  const reportedPath = agentVerdictPath(worktree.path, stage);
  let outcome = initialOutcome;
  let combinedUsage = initialOutcome.usage;
  let result = await readVerdict(outcome.verdictPath, reportedPath);
  if (result.status === "valid") return { verdict: result.verdict, outcome };
  if (result.status === "missing") return { verdict: null, outcome };

  let error = result.error;
  let sessionId = outcome.sessionId;
  // Termination: correctionAttempt increases toward the fixed two-attempt cap.
  for (
    let correctionAttempt = 1;
    correctionAttempt <= MAX_VERDICT_CORRECTION_ATTEMPTS;
    correctionAttempt++
  ) {
    outcome = await runVerdictCorrectionAttempt(
      context,
      ticket,
      worktree,
      stage,
      path.join(roundDirectory, `verdict-fix-${correctionAttempt}`),
      verdictCorrectionPrompt(error, reportedPath),
      initialOutcome.preSessionHead,
      sessionId,
      initialOutcome.agent,
    );
    combinedUsage = combineSessionUsage(combinedUsage, outcome.usage);
    outcome = { ...outcome, usage: combinedUsage };
    sessionId = outcome.sessionId ?? sessionId;
    result = await readVerdict(outcome.verdictPath, reportedPath);
    if (result.status === "valid") return { verdict: result.verdict, outcome };
    error =
      result.status === "invalid"
        ? result.error
        : `required corrected verdict file is missing. Verdict file: ${reportedPath}`;
  }

  const failure = `${stage} agent failed to function properly after ${MAX_VERDICT_CORRECTION_ATTEMPTS} verdict correction attempts: ${error}`;
  context.log.emit("blocked", ticket.id, {
    reason: failure,
  });
  return { verdict: null, outcome, invalidVerdictFailure: failure };
}

function combineSessionUsage(first: SessionUsage, second: SessionUsage): SessionUsage {
  return {
    durationMs: first.durationMs + second.durationMs,
    costUsd:
      first.costUsd === null || second.costUsd === null ? null : first.costUsd + second.costUsd,
    inputTokens: first.inputTokens + second.inputTokens,
    cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    ...(second.model ? { model: second.model } : first.model ? { model: first.model } : {}),
    ...(first.isCostEstimated || second.isCostEstimated ? { isCostEstimated: true } : {}),
  };
}

async function stagePrompt(
  context: PipelineContext,
  name: PromptName,
  variables: Record<string, string>,
): Promise<string> {
  const template = await loadPrompt(context.jfdiDirectory, name);
  return renderPrompt(template, variables);
}

function commonVariables(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  verdictPath: string,
): Record<string, string> {
  return {
    TICKET_ID: ticket.id,
    SPEC: ticket.description,
    BRANCH: worktree.branch,
    TARGET_BRANCH: context.config.integration.targetBranch,
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

/**
 * A `blocks`/`blocked-by` link naming a note that is not in ticketsDirectory is
 * reported, never silently dropped: the human wrote a link to a ticket the
 * tool cannot see (a typo, or a note not created yet), and the wikilink-scope
 * invariant means looking for it anywhere else is not an option.
 */
function reportUnresolvedLinks(context: PipelineContext, ticket: Ticket): void {
  for (const link of ticket.links) {
    if (link.notePath === null)
      context.log.emit("unresolved_link", ticket.id, { kind: link.kind, target: link.target });
  }
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
      "**Q:**",
      quoteAgentText(question),
      "",
      "**Recommendation:**",
      quoteAgentText(recommendation),
      "",
      `_Answer by editing this note, then move the card back to "${beginColumn}"._`,
    ].join("\n"),
  );
  context.log.emit("escalation", ticket.id, { stage, question, recommendation });
}

interface HandoffCommitInput {
  worktree: Worktree;
  notePath: string;
  roundDirectory: string;
  /** What the session did and where the run went — the message's status line. */
  handoff: SessionHandoff;
  /** HEAD before the session ran, from its `StageOutcome`. */
  preSessionHead: string;
}

interface HandoffRecord {
  sha: string;
  message: string;
}

/**
 * The scribe's session: context in, commit message out. A message the scribe
 * did not produce — a dead session, an empty answer — degrades to the
 * pipeline's own wording rather than delaying the commit, and says so on the
 * event stream.
 */
async function renderHandoffMessage(
  context: PipelineContext,
  ticket: Ticket,
  input: HandoffCommitInput,
): Promise<string> {
  const commitContext = await collectCommitContext(input.worktree.path);
  const prompt = await stagePrompt(
    context,
    "commit-message",
    scribeVariables(ticket.id, ticket.description, input.handoff, commitContext),
  );
  const result = await runHeldSession(
    context,
    ticket.id,
    "commit-message",
    prompt,
    {
      cwd: input.worktree.path,
      logPath: path.join(input.roundDirectory, `${input.handoff.stage}.commit-message.log.jsonl`),
    },
    (event) => narrateSessionActivity(context, ticket.id, "commit-message", event),
  );
  const written = result.ok ? result.text : "";
  if (written.trim() === "")
    context.log.emit("session_activity", ticket.id, {
      text: "commit-message: the scribe wrote no message; committing with the pipeline's own",
    });
  return assembleCommitMessage(written, ticket.id, input.handoff);
}

/**
 * The pipeline's one commit per session — the whole of "agents never commit".
 * Anything the session committed despite the prompt is soft-reset back into the
 * index, so the pre-session HEAD is always the base and one commit is always
 * the result. It runs on every path a session can end on, success and failure
 * alike: partial work that lives in a commit is work a resume can continue.
 *
 * Preparation returns whether the session changed the tree. The caller can run
 * a gate before rendering the final status, then commit the already staged
 * handoff or render the no-commit stage record.
 */
async function prepareSessionHandoff(
  context: PipelineContext,
  ticket: Ticket,
  input: HandoffCommitInput,
): Promise<boolean> {
  const { worktree, preSessionHead, handoff } = input;
  if ((await parseRevision(worktree.path, "HEAD")) !== preSessionHead) {
    await git(worktree.path, "reset", "--soft", preSessionHead);
    context.log.emit("session_activity", ticket.id, {
      text: `${handoff.stage}: session committed; folding its commits into the pipeline's`,
    });
  }
  await git(worktree.path, "add", "-A");
  return hasStagedChanges(worktree.path);
}

/** Commit changes already normalized and staged by `prepareSessionHandoff`. */
async function commitPreparedSessionHandoff(
  context: PipelineContext,
  ticket: Ticket,
  input: HandoffCommitInput,
): Promise<HandoffRecord> {
  const { worktree, handoff } = input;
  const message = await renderHandoffMessage(context, ticket, input);
  await git(worktree.path, "commit", "-m", message);
  const sha = await parseRevision(worktree.path, "HEAD");
  context.log.emit("session_activity", ticket.id, {
    text: `${handoff.stage}: committed ${shortSha(sha)}`,
  });
  return { sha, message };
}

function stagePhaseLabel(handoff: SessionHandoff): string {
  return `${STAGE_LABELS[handoff.stage]} round ${handoff.round} ${handoff.isInterrupted ? "interrupted" : "complete"}`;
}

function recordStagePhase(notePath: string, handoff: SessionHandoff, body: string): Promise<void> {
  return recordPhase(notePath, stagePhaseLabel(handoff), handoff.stage, handoff.round, body);
}

function gateGreenRouting(gate: GateResult, destination: string): string {
  const checks = gate.results.map((result) => `${result.name} ✓`).join(" ");
  return `gate green${checks === "" ? "" : ` (${checks})`}, ${destination}`;
}

export interface QaStageOptions {
  /** Rendered into the prompt's gate slot; empty means "say nothing about the gate". */
  gateSummary?: string | undefined;
  /** Continue this earlier QA session instead of starting fresh. */
  previousSession?: StageSessionMemory | undefined;
  /** Why the branch moved since that session — provenance for the continuation. */
  previousFailure?: FeedbackItem | undefined;
}

/** Run QA alone (used on a complicated integration merge). */
export async function runQaStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  roundDirectory: string,
  notePath: string,
  options: QaStageOptions = {},
): Promise<StageVerdictResult<ReviewVerdict>> {
  const target = context.config.integration.targetBranch;
  const variables = {
    ...commonVariables(context, ticket, worktree, agentVerdictPath(worktree.path, "qa")),
    NOTE_PATH: notePath,
    GATE_RESULT: options.gateSummary ?? "",
  };
  const continuation = await buildQaContinuation(context, worktree, variables, options);
  const freshPrompt = async () => {
    const sandbox =
      (await readIfExists(path.join(context.jfdiDirectory, "sandbox.md"))) ??
      "(no sandbox contract found — exercise the artifact as best you can and say so in your feedback)";
    const change = await collectChangeContext(worktree.path, target);
    return stagePrompt(context, "qa", {
      ...variables,
      SANDBOX: sandbox,
      COMMIT_LOG: change.commitLog,
      DIFF_STAT: change.diffStat,
    });
  };
  const initialOutcome = await runStageWithFallback(
    context,
    ticket,
    worktree,
    "qa",
    roundDirectory,
    freshPrompt,
    continuation,
    options.previousSession?.agent,
  );
  const result = await readStageVerdictWithCorrections(
    context,
    ticket,
    worktree,
    "qa",
    roundDirectory,
    initialOutcome,
    (verdictPath, reportedPath) =>
      readReviewVerdict(verdictPath, { isEscalateAllowed: true, reportedPath }),
  );
  const { verdict, outcome } = result;
  context.log.emit("stage_end", ticket.id, {
    stage: "qa",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
    ...stageUsageFields(context, ticket.id, "qa", outcome.usage, outcome.agent.config),
  });
  return result;
}

async function buildQaContinuation(
  context: PipelineContext,
  worktree: Worktree,
  variables: Record<string, string>,
  options: QaStageOptions,
): Promise<ContinuationSpecification | null> {
  const { previousSession, previousFailure } = options;
  if (!previousSession?.sessionId || !previousSession.lastSeenCommit || !previousFailure)
    return null;
  const delta = await collectStageDelta(worktree.path, previousSession.lastSeenCommit);
  const headCommit = await parseRevision(worktree.path, "HEAD");
  return {
    sessionId: previousSession.sessionId,
    prompt: await stagePrompt(context, "qa-continue", {
      ...variables,
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
  | { kind: "blocked"; reason: string }
  | { kind: "escalate"; question: string; recommendation: string; observations: string[] };

interface ImplementationStageInput {
  roundDirectory: string;
  history: FeedbackItem[];
  resume: ResumeState | null;
  previousSession: StageSessionMemory | undefined;
}

async function runImplementationStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: ImplementationStageInput,
): Promise<{
  step: ImplementationStep;
  sessionId: string | undefined;
  preSessionHead: string;
  usage: SessionUsage;
  agent: LockedStageAgent;
}> {
  const { roundDirectory, history, resume } = input;
  const variables = commonVariables(
    context,
    ticket,
    worktree,
    agentVerdictPath(worktree.path, "implementation"),
  );
  const previousFailure = history.at(-1);
  const continuation =
    input.previousSession?.sessionId && previousFailure
      ? {
          sessionId: input.previousSession.sessionId,
          prompt: await stagePrompt(context, "implementation-continue", {
            ...variables,
            FEEDBACK: formatContinuationFeedback(previousFailure),
          }),
        }
      : null;
  const freshPrompt = () =>
    stagePrompt(context, "implementation", {
      ...variables,
      RESUME_SECTION: formatResumeSection(
        resume,
        worktree.branch,
        context.config.integration.targetBranch,
      ),
      FEEDBACK_SECTION: formatFeedbackSection(history, ticket.mode),
    });
  const initialOutcome = await runStageWithFallback(
    context,
    ticket,
    worktree,
    "implementation",
    roundDirectory,
    freshPrompt,
    continuation,
    input.previousSession?.agent,
  );
  const result = await readStageVerdictWithCorrections(
    context,
    ticket,
    worktree,
    "implementation",
    roundDirectory,
    initialOutcome,
    (verdictPath, reportedPath) => readImplementationVerdict(verdictPath, { reportedPath }),
  );
  const { verdict, outcome } = result;
  const staged = (step: ImplementationStep) => ({
    step,
    sessionId: outcome.sessionId,
    preSessionHead: outcome.preSessionHead,
    usage: outcome.usage,
    agent: outcome.agent,
  });
  context.log.emit("stage_end", ticket.id, {
    stage: "implementation",
    verdict: verdict?.status ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
    ...stageUsageFields(context, ticket.id, "implementation", outcome.usage, outcome.agent.config),
  });
  if (result.invalidVerdictFailure)
    return staged({ kind: "blocked", reason: result.invalidVerdictFailure });
  if (!verdict) {
    return staged({
      kind: "retry",
      feedback: outcome.ok
        ? "The previous implementation session ended without writing a valid verdict file. Re-verify the work is complete, then write the verdict file as instructed."
        : `The previous implementation session failed: ${outcome.resultText}`,
    });
  }
  const decisions = verdict.decisions ?? [];
  if (verdict.status === "escalate") {
    return staged({
      kind: "escalate",
      question: verdict.question ?? "Escalated without a stated question.",
      recommendation: verdict.recommendation ?? "(no recommendation given)",
      observations: verdict.observations ?? [],
    });
  }
  return staged({
    kind: "done",
    summary: verdict.summary,
    decisions,
    observations: verdict.observations ?? [],
  });
}

type CodeReviewStep =
  | { kind: "pass"; decisions: string[]; observations: string[] }
  | { kind: "retry"; feedback: string; decisions: string[]; observations: string[] }
  | { kind: "blocked"; reason: string; observations: string[] };

interface CodeReviewStageInput {
  roundDirectory: string;
  notePath: string;
  round: number;
  /** The gate result that admitted this commit to review, quoted into the prompt. */
  gate: GateResult;
  headCommit: string;
  previousSession: StageSessionMemory | undefined;
  previousFailure: FeedbackItem | undefined;
}

function codeReviewFailureFeedback(verdict: ReviewVerdict | null, outcome: StageOutcome): string {
  if (verdict?.feedback) return verdict.feedback;
  if (verdict) return "Code review failed without specific feedback.";
  return `Code review session did not produce a valid verdict${outcome.ok ? "" : `: ${outcome.resultText}`}.`;
}

interface CodeReviewJudgment {
  handoff: SessionHandoff;
  detail: string;
  step: CodeReviewStep;
}

function judgeCodeReview(
  result: StageVerdictResult<ReviewVerdict>,
  input: CodeReviewStageInput,
  maxRounds: number,
): CodeReviewJudgment {
  const { verdict, outcome } = result;
  const decisions = verdict?.decisions ?? [];
  const handoffBase = {
    stage: "code-review" as const,
    round: input.round,
    maxRounds,
    decisions,
    usage: outcome.usage,
  };
  if (result.invalidVerdictFailure) {
    const reason = result.invalidVerdictFailure;
    return {
      handoff: {
        ...handoffBase,
        outcome: "interrupted: invalid verdict",
        routing: BLOCKED_ROUTING,
        summary: reason,
        isInterrupted: true,
      },
      detail: reason,
      step: { kind: "blocked", reason, observations: [] },
    };
  }
  if (!verdict || verdict.verdict === "fail") {
    const feedback = codeReviewFailureFeedback(verdict, outcome);
    return {
      handoff: {
        ...handoffBase,
        outcome: verdict === null ? `interrupted: ${firstLine(feedback)}` : "FAILED",
        routing: retryRouting(input.round, maxRounds),
        summary: feedback,
        isInterrupted: verdict === null,
      },
      detail: feedback,
      step: {
        kind: "retry",
        feedback,
        decisions,
        observations: verdict?.observations ?? [],
      },
    };
  }
  return {
    handoff: {
      ...handoffBase,
      outcome: "PASSED",
      routing: `sign-off on commit \`${shortSha(input.headCommit)}\`, moving to QA`,
      summary: verdict.feedback ?? "",
      isInterrupted: false,
    },
    detail: verdict.feedback ?? "",
    step: { kind: "pass", decisions, observations: verdict.observations ?? [] },
  };
}

async function runCodeReviewStage(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: CodeReviewStageInput,
): Promise<{ step: CodeReviewStep; sessionId: string | undefined; agent: LockedStageAgent }> {
  const target = context.config.integration.targetBranch;
  const variables = {
    ...commonVariables(context, ticket, worktree, agentVerdictPath(worktree.path, "code-review")),
    NOTE_PATH: input.notePath,
    GATE_RESULT: formatGatePass(input.gate),
  };
  const { previousSession, previousFailure } = input;
  const continuation =
    previousSession?.sessionId && previousSession.lastSeenCommit && previousFailure
      ? {
          sessionId: previousSession.sessionId,
          prompt: await stagePrompt(context, "code-review-continue", {
            ...variables,
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
      ...variables,
      COMMIT_LOG: change.commitLog,
      DIFF_STAT: change.diffStat,
      DIFF_SECTION: change.diffSection,
    });
  };
  const initialOutcome = await runStageWithFallback(
    context,
    ticket,
    worktree,
    "code-review",
    input.roundDirectory,
    freshPrompt,
    continuation,
    input.previousSession?.agent,
  );
  const result = await readStageVerdictWithCorrections(
    context,
    ticket,
    worktree,
    "code-review",
    input.roundDirectory,
    initialOutcome,
    (verdictPath, reportedPath) =>
      readReviewVerdict(verdictPath, { isEscalateAllowed: false, reportedPath }),
  );
  const { verdict, outcome } = result;
  // Reviewers are read-only: discard stray modifications, and any commit the
  // session made despite the prompt — a reviewer never moves the branch.
  await git(worktree.path, "reset", "--hard", outcome.preSessionHead);
  context.log.emit("stage_end", ticket.id, {
    stage: "code-review",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
    ...stageUsageFields(context, ticket.id, "code-review", outcome.usage, outcome.agent.config),
  });
  const judgment = judgeCodeReview(result, input, context.config.pipeline.maxRounds);
  await recordStagePhase(
    input.notePath,
    judgment.handoff,
    assembleStageComment(judgment.handoff, judgment.detail),
  );
  return { sessionId: outcome.sessionId, step: judgment.step, agent: outcome.agent };
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
  logPath: string,
): Promise<GateResult> {
  context.log.emit("gate_start", ticket.id);
  const gate = await runGate(context.config.gate, worktree.path, logPath, (name) =>
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
  roundDirectory: string;
  notePath: string;
  round: number;
  runNumber: number;
  history: FeedbackItem[];
  resume: ResumeState | null;
  memory: SessionMemory;
}

/**
 * How many gate-fix sessions one round pays for before the gate failure is
 * allowed to consume the round. Gate fixes can get complicated, so this is
 * provisioned generously — the round cap still bounds the run as a whole.
 */
const MAX_GATE_FIX_SESSIONS_PER_ROUND = 10;

/** Spec-invalid verdict corrections stay inside their current round. */
const MAX_VERDICT_CORRECTION_ATTEMPTS = 2;

/** What the Implementation-gate cycle collected before it ended, either way. */
interface ImplementationCycleCollected {
  decisions: string[];
  observations: string[];
  summary: string | undefined;
  implementationSession: StageSessionMemory;
}

/** How the Implementation-gate cycle ended: onward to reviews, or out of the round. */
type ImplementationCycleResult =
  | ({ kind: "proceed"; gate: GateResult; headCommit: string } & ImplementationCycleCollected)
  | ({ kind: "exit"; step: RoundStep } & ImplementationCycleCollected);

/**
 * The round-ending step a session outcome forces, or null when the session
 * completed and the cycle may continue to the gate. Escalations are narrated
 * (Questions entry, blocked event) here, on their way out.
 */
async function implementationExitStep(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  step: ImplementationStep,
): Promise<RoundStep | null> {
  if (step.kind === "retry")
    return { kind: "retry", source: "implementation", feedback: step.feedback };
  if (step.kind === "blocked") return { kind: "blocked", reason: step.reason };
  if (step.kind !== "escalate") return null;
  await recordEscalation(
    context,
    ticket,
    notePath,
    "implementation",
    step.question,
    step.recommendation,
  );
  context.log.emit("blocked", ticket.id, {
    reason: `escalated: ${step.question}`,
  });
  return { kind: "blocked", reason: step.question };
}

/**
 * Where one cycle session's artifacts (verdict, logs, scribe log) land: the
 * round directory itself for the round's first session, a gate-fix subdirectory
 * for each fix session after it — so no session overwrites another's files.
 */
function cycleSessionDirectory(roundDirectory: string, fixSession: number): string {
  return fixSession === 0 ? roundDirectory : path.join(roundDirectory, `gate-fix-${fixSession}`);
}

interface ImplementationPhaseRecord {
  handoff: SessionHandoff;
  message: string;
}

interface MaterializedImplementationRecord {
  phaseRecord: ImplementationPhaseRecord;
  commitSha: string | null;
}

async function recordImplementationPhase(
  notePath: string,
  records: readonly ImplementationPhaseRecord[],
): Promise<void> {
  const last = records.at(-1);
  if (!last) throw new Error("cannot record an Implementation phase with no session record");
  const body = records
    .map((record, index) =>
      index === 0
        ? record.message.trimEnd()
        : `--- Gate-fix session ${index} ---\n\n${record.message.trimEnd()}`,
    )
    .join("\n\n");
  await recordStagePhase(notePath, last.handoff, body);
}

async function materializeImplementationRecord(
  context: PipelineContext,
  ticket: Ticket,
  input: HandoffCommitInput,
  hasChanges: boolean,
): Promise<MaterializedImplementationRecord> {
  if (!hasChanges)
    return {
      phaseRecord: { handoff: input.handoff, message: assembleStageComment(input.handoff) },
      commitSha: null,
    };
  const committed = await commitPreparedSessionHandoff(context, ticket, input);
  return {
    phaseRecord: { handoff: input.handoff, message: committed.message },
    commitSha: committed.sha,
  };
}

/** What one Implementation step contributes to the run-level collection. */
function implementationStepContributions(
  step: ImplementationStep,
  previousSummary: string | undefined,
): Pick<ImplementationCycleCollected, "decisions" | "observations" | "summary"> {
  switch (step.kind) {
    case "done":
      return {
        decisions: step.decisions,
        observations: step.observations,
        summary: step.summary ?? previousSummary,
      };
    case "escalate":
      return { decisions: [], observations: step.observations, summary: previousSummary };
    case "retry":
      return { decisions: [], observations: [], summary: previousSummary };
    case "blocked":
      return { decisions: [], observations: [], summary: previousSummary };
  }
}

interface ImplementationIterationBase {
  contributions: Pick<ImplementationCycleCollected, "decisions" | "observations" | "summary">;
  implementationSession: StageSessionMemory;
  materialized: MaterializedImplementationRecord;
}

type ImplementationIterationResult =
  | ({ kind: "exit"; step: RoundStep } & ImplementationIterationBase)
  | ({ kind: "gated"; gate: GateResult; feedback: string } & ImplementationIterationBase);

function implementationGateRouting(
  gate: GateResult,
  fixSession: number,
  round: number,
  maxRounds: number,
): string {
  if (gate.ok) return gateGreenRouting(gate, "moving to Code Review");
  const failedStep = gate.results.at(-1)?.name ?? "unknown step";
  if (fixSession >= MAX_GATE_FIX_SESSIONS_PER_ROUND)
    return `gate failed at \`${failedStep}\`, ${retryRouting(round, maxRounds)}`;
  return `gate failed at \`${failedStep}\`, continuing with gate fix ${fixSession + 1} of ${MAX_GATE_FIX_SESSIONS_PER_ROUND}`;
}

async function runImplementationGateIteration(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: RoundInput,
  fixSession: number,
  gateFailures: readonly FeedbackItem[],
  implementationSession: StageSessionMemory,
  previousSummary: string | undefined,
): Promise<ImplementationIterationResult> {
  const { roundDirectory, notePath, round, history, resume } = input;
  const maxRounds = context.config.pipeline.maxRounds;
  const sessionDirectory = cycleSessionDirectory(roundDirectory, fixSession);
  await ensureDirectory(sessionDirectory);
  const implementation = await runImplementationStage(context, ticket, worktree, {
    roundDirectory: sessionDirectory,
    history: [...history, ...gateFailures],
    resume: fixSession === 0 ? resume : null,
    previousSession: implementationSession,
  });
  const contributions = implementationStepContributions(implementation.step, previousSummary);
  const exitStep = await implementationExitStep(context, ticket, notePath, implementation.step);
  const preparedInput = {
    worktree,
    notePath,
    roundDirectory: sessionDirectory,
    handoff: implementationHandoff(implementation.step, round, maxRounds, implementation.usage),
    preSessionHead: implementation.preSessionHead,
  };
  const hasChanges = await prepareSessionHandoff(context, ticket, preparedInput);
  const nextSession = { sessionId: implementation.sessionId, agent: implementation.agent };
  if (exitStep)
    return {
      kind: "exit",
      step: exitStep,
      contributions,
      implementationSession: nextSession,
      materialized: await materializeImplementationRecord(
        context,
        ticket,
        preparedInput,
        hasChanges,
      ),
    };
  if (implementation.step.kind !== "done")
    throw new Error(
      `implementation step "${implementation.step.kind}" escaped implementationExitStep — only "done" may reach the gate`,
    );
  const gate = await runGateStage(
    context,
    ticket,
    worktree,
    path.join(roundDirectory, `gate-implementation-${fixSession + 1}.log`),
  );
  const handoff = implementationHandoff(
    implementation.step,
    round,
    maxRounds,
    implementation.usage,
    implementationGateRouting(gate, fixSession, round, maxRounds),
  );
  return {
    kind: "gated",
    gate,
    feedback: gate.ok ? "" : formatGateFailure(gate),
    contributions,
    implementationSession: nextSession,
    materialized: await materializeImplementationRecord(
      context,
      ticket,
      { ...preparedInput, handoff },
      hasChanges,
    ),
  };
}

/**
 * The Implementation-gate cycle: sessions until the gate is green. A gate
 * failure stays inside the round — it returns to the same Implementation
 * session as feedback and the gate reruns, up to
 * MAX_GATE_FIX_SESSIONS_PER_ROUND fix sessions — because rounds mean moving on
 * to other agents, not iterating with the machine. Only a gate still red after
 * those fixes leaves as a round-consuming retry step.
 */
async function runImplementationGateCycle(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: RoundInput,
): Promise<ImplementationCycleResult> {
  const { notePath, round, runNumber } = input;
  const decisions: string[] = [];
  const observations: string[] = [];
  let summary: string | undefined;
  let implementationSession: StageSessionMemory = input.memory.implementation ?? {};
  let lastHandoffCommit: string | null = null;
  const phaseRecords: ImplementationPhaseRecord[] = [];
  // Gate failures this round, oldest first — feedback for the next fix session.
  // Their full transcripts persist independently in the round directory.
  const gateFailures: FeedbackItem[] = [];
  const collected = () => ({ decisions, observations, summary, implementationSession });

  // Termination: each pass either returns (gate green, session retry/escalate,
  // or the fix-session cap); fixSession strictly increases toward the cap.
  for (let fixSession = 0; ; fixSession++) {
    const iteration = await runImplementationGateIteration(
      context,
      ticket,
      worktree,
      input,
      fixSession,
      gateFailures,
      implementationSession,
      summary,
    );
    implementationSession = iteration.implementationSession;
    decisions.push(...iteration.contributions.decisions);
    observations.push(...iteration.contributions.observations);
    summary = iteration.contributions.summary;
    phaseRecords.push(iteration.materialized.phaseRecord);
    if (iteration.materialized.commitSha) lastHandoffCommit = iteration.materialized.commitSha;
    if (iteration.kind === "exit") {
      await recordImplementationPhase(notePath, phaseRecords);
      return { kind: "exit", ...collected(), step: iteration.step };
    }
    if (iteration.gate.ok) {
      // The sign-offs bind to the pipeline's own handoff commit; only a cycle
      // that committed nothing (an unchanged tree) reviews the branch as it stood.
      const headCommit = lastHandoffCommit ?? (await parseRevision(worktree.path, "HEAD"));
      await recordImplementationPhase(notePath, phaseRecords);
      return { kind: "proceed", ...collected(), gate: iteration.gate, headCommit };
    }
    if (fixSession >= MAX_GATE_FIX_SESSIONS_PER_ROUND) {
      await recordImplementationPhase(notePath, phaseRecords);
      return {
        kind: "exit",
        ...collected(),
        step: { kind: "retry", source: "gate", feedback: iteration.feedback },
      };
    }
    gateFailures.push({ run: runNumber, round, source: "gate", feedback: iteration.feedback });
  }
}

/**
 * One round: the Implementation-gate cycle → Code Review → QA → gate again if
 * QA committed, stopping at the first step that wants another round. Reviews
 * are sequential — Code Review gates QA, so a code-review failure never pays
 * for a sandbox run. Stages that already ran this run are continued, not
 * restarted.
 */
async function runRound(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: RoundInput,
): Promise<RoundResult> {
  const { roundDirectory, notePath, round, history } = input;
  const memory: SessionMemory = { ...input.memory };
  const previousFailure = history.at(-1);

  const cycle = await runImplementationGateCycle(context, ticket, worktree, input);
  memory.implementation = cycle.implementationSession;
  const decisions = [...cycle.decisions];
  const observations = [...cycle.observations];
  const summary = cycle.summary;
  if (cycle.kind === "exit") return { decisions, observations, summary, memory, step: cycle.step };
  const { gate, headCommit } = cycle;
  const review = await runCodeReviewStage(context, ticket, worktree, {
    roundDirectory,
    notePath,
    round,
    gate,
    headCommit,
    previousSession: memory["code-review"],
    previousFailure,
  });
  memory["code-review"] = {
    sessionId: review.sessionId,
    lastSeenCommit: headCommit,
    agent: review.agent,
  };
  observations.push(...review.step.observations);
  if (review.step.kind === "blocked")
    return {
      decisions,
      observations,
      summary,
      memory,
      step: { kind: "blocked", reason: review.step.reason },
    };
  if (review.step.kind === "retry") {
    const { feedback } = review.step;
    decisions.push(...review.step.decisions);
    return {
      decisions,
      observations,
      summary,
      memory,
      step: { kind: "retry", source: "code-review", feedback },
    };
  }
  decisions.push(...review.step.decisions);

  const qa = await runQaPhase(context, ticket, worktree, {
    roundDirectory,
    notePath,
    round,
    gateSummary: formatGatePass(gate),
    headCommit,
    previousSession: memory.qa,
    previousFailure,
  });
  memory.qa = qa.memory;
  decisions.push(...qa.decisions);
  observations.push(...qa.observations);
  return { decisions, observations, summary, memory, step: qa.step };
}

interface QaPhaseInput {
  roundDirectory: string;
  notePath: string;
  round: number;
  gateSummary: string;
  /** The commit Code Review signed off on — what QA's own commit is measured against. */
  headCommit: string;
  previousSession: StageSessionMemory | undefined;
  previousFailure: FeedbackItem | undefined;
}

interface QaPhaseResult {
  step: RoundStep;
  decisions: string[];
  observations: string[];
  memory: StageSessionMemory;
}

/**
 * QA, its verdict, its commit, and the gate over what it committed. QA's tests
 * are code the reviewed gate never saw, so re-running the gate here is the
 * pipeline's job, not QA's — a session re-running a suite the machine can run
 * for free is wasted context.
 */
async function runQaPhase(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  input: QaPhaseInput,
): Promise<QaPhaseResult> {
  const { notePath, round } = input;
  const maxRounds = context.config.pipeline.maxRounds;
  const qa = await runQaStage(context, ticket, worktree, input.roundDirectory, notePath, {
    gateSummary: input.gateSummary,
    previousSession: input.previousSession,
    previousFailure: input.previousFailure,
  });
  let step = await judgeQa(context, ticket, notePath, qa);
  const initialHandoff = qaHandoff(
    step,
    qa.verdict,
    round,
    maxRounds,
    qa.outcome.usage,
    input.headCommit,
    null,
    context.config.integration.mode,
  );
  const handoffInput = {
    worktree,
    notePath,
    roundDirectory: input.roundDirectory,
    handoff: initialHandoff,
    preSessionHead: qa.outcome.preSessionHead,
  };
  const hasChanges = await prepareSessionHandoff(context, ticket, handoffInput);
  let postQaGate: GateResult | null = null;
  if (step.kind === "passed" && hasChanges) {
    postQaGate = await runGateStage(
      context,
      ticket,
      worktree,
      path.join(input.roundDirectory, "gate-post-qa-1.log"),
    );
    if (!postQaGate.ok)
      step = {
        kind: "retry",
        source: "gate",
        feedback: `The mechanical gate failed after QA committed its tests.\n\n${formatGateFailure(postQaGate)}`,
      };
  }
  const handoff = qaHandoff(
    step,
    qa.verdict,
    round,
    maxRounds,
    qa.outcome.usage,
    input.headCommit,
    postQaGate,
    context.config.integration.mode,
  );
  const committed = hasChanges
    ? await commitPreparedSessionHandoff(context, ticket, { ...handoffInput, handoff })
    : null;
  const detail = qa.verdict?.verdict === "fail" ? (qa.verdict.feedback ?? "") : "";
  await recordStagePhase(
    notePath,
    handoff,
    committed?.message ?? assembleStageComment(handoff, detail),
  );
  const memory = {
    sessionId: qa.outcome.sessionId,
    lastSeenCommit: committed?.sha ?? input.headCommit,
    agent: qa.outcome.agent,
  };
  const collected = {
    decisions: qa.verdict?.decisions ?? [],
    observations: qa.verdict?.observations ?? [],
  };
  return { step, ...collected, memory };
}

function firstLine(text: string): string {
  return text.split(/\r\n?|\n/)[0] ?? "";
}

/** What the Implementation session's commit says happened, and where the run went. */
function implementationHandoff(
  step: ImplementationStep,
  round: number,
  maxRounds: number,
  usage: SessionUsage,
  completedRouting = "moving to the mechanical gate",
): SessionHandoff {
  const base = { stage: "implementation" as const, round, maxRounds, usage };
  switch (step.kind) {
    case "done":
      return {
        ...base,
        outcome: "complete",
        routing: completedRouting,
        summary: step.summary ?? "",
        decisions: step.decisions,
        isInterrupted: false,
      };
    case "retry":
      return {
        ...base,
        outcome: `interrupted: ${firstLine(step.feedback)}`,
        routing: retryRouting(round, maxRounds),
        summary: step.feedback,
        isInterrupted: true,
      };
    case "blocked":
      return {
        ...base,
        outcome: "invalid verdict",
        routing: BLOCKED_ROUTING,
        summary: step.reason,
        detail: step.reason,
        isInterrupted: true,
      };
    case "escalate":
      return {
        ...base,
        outcome: "escalated",
        routing: BLOCKED_ROUTING,
        summary: step.question,
        isInterrupted: true,
      };
  }
}

/** The same, for QA — which commits when it wrote acceptance tests, and only then. */
function qaHandoff(
  step: RoundStep,
  verdict: ReviewVerdict | null,
  round: number,
  maxRounds: number,
  usage: SessionUsage,
  signedOffCommit: string,
  postQaGate: GateResult | null,
  integrationMode: JfdiConfig["integration"]["mode"],
): SessionHandoff {
  const base = {
    stage: "qa" as const,
    round,
    maxRounds,
    usage,
    decisions: verdict?.decisions ?? [],
  };
  const destination =
    integrationMode === "auto"
      ? "queued for integration"
      : "queued for approval before integration";
  if (step.kind === "passed") {
    const gateClause = postQaGate ? `${gateGreenRouting(postQaGate, destination)}` : destination;
    return {
      ...base,
      outcome: "PASSED",
      routing: `sign-off on commit \`${shortSha(signedOffCommit)}\`, ${gateClause}`,
      summary: verdict?.testsAdded ?? "",
      isInterrupted: false,
    };
  }
  if (step.kind === "blocked")
    return {
      ...base,
      outcome: "escalated",
      routing: BLOCKED_ROUTING,
      summary: step.reason,
      isInterrupted: true,
    };
  if (verdict?.verdict === "pass" && postQaGate && !postQaGate.ok)
    return {
      ...base,
      outcome: "PASSED",
      routing: `sign-off on commit \`${shortSha(signedOffCommit)}\`, gate failed over the new tests, ${retryRouting(round, maxRounds)}`,
      summary: step.feedback,
      isInterrupted: false,
    };
  // A QA session that produced no verdict did not finish; one that failed the
  // work did, and its tests are complete even though the round is not.
  return verdict === null
    ? {
        ...base,
        outcome: `interrupted: ${firstLine(step.feedback)}`,
        routing: retryRouting(round, maxRounds),
        summary: step.feedback,
        isInterrupted: true,
      }
    : {
        ...base,
        outcome: "FAILED",
        routing: retryRouting(round, maxRounds),
        summary: step.feedback,
        isInterrupted: false,
      };
}

/** Turn a QA outcome into the round's verdict, recording an escalation if that's what it is. */
async function judgeQa(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  qa: StageVerdictResult<ReviewVerdict>,
): Promise<RoundStep> {
  if (qa.invalidVerdictFailure) return { kind: "blocked", reason: qa.invalidVerdictFailure };
  if (qa.verdict?.verdict === "escalate") {
    const question = qa.verdict.question ?? "QA escalated without a stated question.";
    const recommendation = qa.verdict.recommendation ?? "(no recommendation given)";
    await recordEscalation(context, ticket, notePath, "qa", question, recommendation);
    context.log.emit("blocked", ticket.id, {
      reason: `QA escalated: ${question}`,
    });
    return { kind: "blocked", reason: question };
  }
  if (!qa.verdict || qa.verdict.verdict === "fail") {
    return {
      kind: "retry",
      source: "qa",
      feedback:
        qa.verdict?.feedback ??
        `QA session did not produce a valid verdict${qa.outcome.ok ? "" : `: ${qa.outcome.resultText}`}.`,
    };
  }
  return { kind: "passed", testsAdded: qa.verdict.testsAdded ?? "" };
}

function startedCommentBody(config: JfdiConfig, branch: string): string {
  const maxRounds = config.pipeline.maxRounds;
  const roundLabel = maxRounds === 1 ? "round" : "rounds";
  const target = config.integration.targetBranch;
  const mergePlan =
    config.integration.mode === "auto"
      ? `will merge to \`${target}\``
      : `will queue for approval before merging to \`${target}\``;
  return `Run started — ${maxRounds} ${roundLabel} max. Working branch \`${branch}\`, ${mergePlan}.`;
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
  const target = context.config.integration.targetBranch;
  await ensureJfdiGitignore(context.jfdiDirectory);
  const notePath = await ensureTicketNote(
    ticket,
    path.join(context.projectRoot, context.config.ticketsDirectory),
  );
  const runDirectories = await nextRunDirectory(context.stateDirectory, ticket.id);

  // Why the previous run failed. A malformed tool-owned file is an impossible
  // state, so stop before creating or sanitizing the worktree or dispatching. The
  // next run directory is deliberately not created: fixing or deleting this
  // same file is the only way a re-dispatch can proceed.
  let priorHistory: FeedbackItem[] = [];
  try {
    if (runDirectories.previous) priorHistory = await loadFeedbackHistory(runDirectories.previous);
  } catch (error) {
    if (!(error instanceof FeedbackHistoryError)) throw error;
    const warning = malformedFeedbackHistoryWarning(error);
    await recordTransition(notePath, "resume", 1, warning);
    context.log.emit("error", ticket.id, {
      message: error.message,
      filePath: error.filePath,
      failure: error.failure,
    });
    context.log.emit("blocked", ticket.id, {
      reason: error.message,
    });
    return { status: "blocked", reason: error.message, observations: [] };
  }

  const worktree = await createWorktree(
    context.projectRoot,
    worktreesDirectory(context.jfdiDirectory),
    ticket.id,
    target,
  );
  await ensureDirectory(runDirectories.current);
  // A fresh tally per run, and the clock the ticket-level elapsed measures from.
  context.usage.start(ticket.id);
  const runStartedMs = nowMs(context);
  const maxRounds = context.config.pipeline.maxRounds;
  context.log.emit("dispatch", ticket.id, { title: ticket.cardText, branch: worktree.branch });
  await recordPhase(
    notePath,
    "JFDI started",
    "dispatch",
    0,
    startedCommentBody(context.config, worktree.branch),
  );
  reportUnresolvedLinks(context, ticket);

  // A re-dispatched ticket may carry partial work and a half-finished git
  // state from a run that died; sanitize both before any session sees them.
  const resume = await prepareResume(worktree.path, target, ticket.id);
  if (resume)
    context.log.emit("resumed", ticket.id, {
      commitCount: resume.commitCount,
      hasCheckpointedChanges: resume.hasCheckpointedChanges,
      hasAbortedMerge: resume.hasAbortedMerge,
    });

  // `history` is this run's own; `priorHistory` was recovered before sanitizing.
  const history: FeedbackItem[] = [];
  const allDecisions: string[] = [];
  const allObservations = new Set<string>();
  let summary = "";
  let memory: SessionMemory = {};
  for (let round = 1; round <= maxRounds; round++) {
    context.log.emit("round_start", ticket.id, { round });
    const roundDirectory = path.join(runDirectories.current, `round-${round}`);
    await ensureDirectory(roundDirectory);

    const result = await runRound(context, ticket, worktree, {
      roundDirectory,
      notePath,
      round,
      runNumber: runDirectories.runNumber,
      history: [...priorHistory, ...history],
      // Only the first session of the run inherits an interrupted state; later
      // rounds work on top of commits this run made itself.
      resume: round === 1 ? resume : null,
      memory,
    });
    memory = result.memory;
    allDecisions.push(...result.decisions);
    for (const observation of result.observations) allObservations.add(observation);
    summary = result.summary ?? summary;

    if (result.step.kind === "retry") {
      history.push({
        run: runDirectories.runNumber,
        round,
        source: result.step.source,
        feedback: result.step.feedback,
      });
      await saveFeedbackHistory(runDirectories.current, [...priorHistory, ...history]);
      continue;
    }
    if (result.step.kind === "blocked") {
      // A blocked run concluded nothing: the session saw the inherited feedback
      // but stopped on a question instead of answering it. So the inherited
      // items stay unanswered business too and are carried forward.
      await saveFeedbackHistory(runDirectories.current, [...priorHistory, ...history]);
      return {
        status: "blocked",
        reason: result.step.reason,
        observations: [...allObservations],
      };
    }

    // The run finished: earlier rounds' feedback was addressed, so it is no
    // longer unfinished business for a later dispatch to inherit.
    await saveFeedbackHistory(runDirectories.current, []);
    const finalCommit = await parseRevision(worktree.path, "HEAD");
    return {
      status: "passed",
      worktree,
      report: {
        summary,
        decisions: allDecisions,
        observations: [...allObservations],
        testsAdded: result.step.testsAdded,
        rounds: round,
        commit: finalCommit,
        usageRows: context.usage.of(ticket.id).snapshot(),
        elapsedMs: nowMs(context) - runStartedMs,
      },
    };
  }

  return recordRoundsExhausted(context, ticket, notePath, history, maxRounds, [...allObservations]);
}

/** Rounds exhausted → Blocked, with the accumulated round history in the note. */
async function recordRoundsExhausted(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  history: FeedbackItem[],
  maxRounds: number,
  observations: string[],
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
      `_Full logs: ${runsDirectory(context.stateDirectory, ticket.id)}/. Adjust the ticket and move it back to "${context.config.board.columns.begin}" to retry._`,
    ].join("\n"),
  );
  context.log.emit("blocked", ticket.id, { reason: `retries exhausted after ${maxRounds} rounds` });
  return {
    status: "blocked",
    reason: `retries exhausted after ${maxRounds} rounds`,
    observations,
  };
}
