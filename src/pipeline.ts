import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JfdiConfig } from "./config.js";
import type { EventLog, StageName } from "./events.js";
import { formatGateFailure, formatGatePass, type GateResult, runGate } from "./gate.js";
import { createWorktree, git, hasStagedChanges, revParse, type Worktree } from "./git.js";
import type {
  HarnessEvent,
  HarnessResult,
  PromptSpec,
  SessionHarnesses,
  SessionKind,
  SessionUsage,
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
  assembleCommitMessage,
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
import { appendComment, appendToSection, quoteAgentText } from "./ticket-note.js";
import { ensureTicketNote, type Ticket } from "./tickets.js";
import {
  BLOCKED_ROUTING,
  recordTransition,
  retryRouting,
  shortSha,
  statusLine,
} from "./transitions.js";
import type { UsageRegistry, UsageRow } from "./usage.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDir, fileExists, readIfExists } from "./util/fsx.js";
import {
  agentVerdictPath,
  collectVerdict,
  type ReviewVerdict,
  readImplementationVerdict,
  readReviewVerdict,
} from "./verdicts.js";

export interface PipelineContext {
  repoRoot: string;
  /** Absolute path to .jfdi/ — versioned setup (config, prompts, sandbox) + worktrees. */
  jfdiDir: string;
  /** Absolute path to ~/.jfdi/projects/<project-key>/ — runs, events, state snapshot. */
  stateDir: string;
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
  /** Per-stage cost/time tally for this run's table. Scribe included; integration not yet. */
  usageRows: UsageRow[];
  /** Dispatch → merge-ready wall-clock, labeled `elapsed` beside agent time. */
  elapsedMs: number;
}

export type PipelineOutcome =
  | { status: "passed"; worktree: Worktree; report: RunReport }
  | { status: "blocked"; reason: string; observations: string[] }
  | { status: "failed"; reason: string; observations: string[] };

/** One line of live session activity, trimmed to stay readable in the TUI. */
const MAX_ACTIVITY_CHARS = 120;
/** Blocked/escalation reasons carried on an event, trimmed for the same reason. */
const MAX_REASON_CHARS = 120;
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
  /**
   * HEAD before the stage's first session of this round — the reset target that
   * makes "agents never commit" true rather than hoped for.
   */
  preSessionHead: string;
  /** What this session cost and took — for its handoff commit's trailers. */
  usage: SessionUsage;
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
        text: `${sessionKind}: ${line.slice(0, MAX_ACTIVITY_CHARS)}`,
      });
  }
}

/**
 * One `stages` entry's agent selection, as the event stream records it — so
 * `jfdi logs` can answer "which model produced this" long after the run.
 */
export function sessionSelectionFields(
  config: JfdiConfig,
  sessionKind: SessionKind,
): Record<string, string> {
  const selection = config.stages[sessionKind];
  return {
    harness: selection.harness,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  };
}

/**
 * The cost/time a `stage_end` carries: this session's own numbers, plus the
 * run's cumulative totals so a renderer can show a running per-ticket figure
 * from the stream alone. The cumulative is read after the session was tallied,
 * so it includes it. `runCostUsd` is null when any session so far was unpriced.
 */
function stageUsageFields(
  context: PipelineContext,
  ticketId: string,
  usage: SessionUsage,
): Record<string, unknown> {
  const totals = context.usage.of(ticketId).totals();
  return {
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
function withDuration(result: HarnessResult, durationMs: number): HarnessResult {
  const usage: SessionUsage = result.usage
    ? { ...result.usage, durationMs }
    : {
        durationMs,
        costUsd: null,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      };
  return { ...result, usage };
}

/** One session, start to finish, with its events narrated as they arrive. */
async function runOneSession(
  context: PipelineContext,
  sessionKind: SessionKind,
  promptSpec: PromptSpec,
  options: SpawnOptions,
  onEvent: (event: HarnessEvent) => void,
): Promise<HarnessResult> {
  const session = context.harnesses[sessionKind].spawn(promptSpec, options);
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
  promptSpec: PromptSpec,
  options: SpawnOptions,
  onEvent: (event: HarnessEvent) => void,
): Promise<HarnessResult> {
  let attemptOptions = options;
  // Provider-failure retries are one logical session: their wall-clock all
  // counts as agent time, but the tokens/cost come from the attempt that
  // actually answered (the last one), so only the returned result is tallied.
  let accumulatedMs = 0;
  for (let attempt = 1; ; attempt++) {
    await context.pause.waitWhilePaused();
    const result = await runOneSession(context, sessionKind, promptSpec, attemptOptions, onEvent);
    accumulatedMs += result.usage?.durationMs ?? 0;
    if (!result.failure) {
      context.pause.reportHealthy();
      return tallied(context, ticketId, sessionKind, withDuration(result, accumulatedMs));
    }
    if (result.sessionId) attemptOptions = { ...options, continueSessionId: result.sessionId };
    context.log.emit("session_activity", ticketId, {
      text: `harness ${result.failure.kind}: ${result.failure.detail}`,
    });
    // Shutting down is the one way out that is not a working provider; the
    // caller then sees the failed session exactly as it did before this hold.
    if (!(await context.pause.holdAfterFailure(result.failure, attempt)))
      return tallied(context, ticketId, sessionKind, withDuration(result, accumulatedMs));
  }
}

/** Add a finished session to the ticket's ledger, then return it unchanged. */
function tallied(
  context: PipelineContext,
  ticketId: string,
  sessionKind: SessionKind,
  result: HarnessResult,
): HarnessResult {
  if (result.usage) context.usage.add(ticketId, sessionKind, result.usage);
  return result;
}

async function runStageSession(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  stage: StageName,
  prompt: string,
  roundDir: string,
  preSessionHead: string,
  continueSessionId?: string,
): Promise<StageOutcome> {
  const verdictPath = path.join(roundDir, `${stage}.verdict.json`);
  const logPath = path.join(roundDir, `${stage}.log.jsonl`);
  context.log.emit("stage_start", ticket.id, {
    stage,
    ...sessionSelectionFields(context.config, stage),
    ...(continueSessionId ? { isContinuation: true } : {}),
  });
  const result = await runHeldSession(
    context,
    ticket.id,
    stage,
    { prompt },
    { cwd: worktree.path, logPath, ...(continueSessionId ? { continueSessionId } : {}) },
    (event) => narrateSessionActivity(context, ticket.id, stage, event),
  );
  // The agent wrote its verdict inside the worktree (the only place sandboxed
  // permission modes allow); collect it before anything commits the tree.
  await collectVerdict(agentVerdictPath(worktree.path, stage), verdictPath);
  return {
    ok: result.ok,
    resultText: result.text,
    verdictPath,
    preSessionHead,
    usage: result.usage ?? zeroUsage(),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

/** A usage with everything at zero — a defensive default; runHeldSession fills real duration. */
function zeroUsage(): SessionUsage {
  return {
    durationMs: 0,
    costUsd: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
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
  // One reset target for the whole stage: a fallback session inherits whatever
  // the continuation left, and both are folded into the same handoff commit.
  const preSessionHead = await revParse(worktree.path, "HEAD");
  if (continuation) {
    const outcome = await runStageSession(
      context,
      ticket,
      worktree,
      stage,
      continuation.prompt,
      roundDir,
      preSessionHead,
      continuation.sessionId,
    );
    if (outcome.ok || (await fileExists(outcome.verdictPath))) return outcome;
    context.log.emit("session_activity", ticket.id, {
      text: `${stage}: continuation failed; restarting fresh`,
    });
  }
  return runStageSession(
    context,
    ticket,
    worktree,
    stage,
    await freshPrompt(),
    roundDir,
    preSessionHead,
  );
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

/**
 * A `blocks`/`blocked-by` link naming a note that is not in ticketsDir is
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

/**
 * Log each decision as its own entry in the note's `## Comments` trail, so an
 * agent's assumptions sit chronologically among the rounds that produced them —
 * and reach every later stage, which reads decision entries as part of the spec.
 */
async function recordDecisions(
  notePath: string,
  stage: string,
  round: number,
  decisions: string[] | undefined,
): Promise<string[]> {
  if (!decisions || decisions.length === 0) return [];
  for (const decision of decisions) {
    await appendComment(notePath, {
      kind: "decision",
      timestamp: new Date().toISOString(),
      stage,
      round,
      body: decision,
    });
  }
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
  roundDir: string;
  /** What the session did and where the run went — the message's status line. */
  handoff: SessionHandoff;
  /** HEAD before the session ran, from its `StageOutcome`. */
  preSessionHead: string;
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
    scribeVariables(ticket.id, ticket.spec, input.handoff, commitContext),
  );
  const result = await runHeldSession(
    context,
    ticket.id,
    "commit-message",
    { prompt },
    {
      cwd: input.worktree.path,
      logPath: path.join(input.roundDir, `${input.handoff.stage}.commit-message.log.jsonl`),
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
 * A session that changed nothing produces no commit and returns null; its
 * outcome reaches the ticket note as a comment instead.
 */
async function commitSessionHandoff(
  context: PipelineContext,
  ticket: Ticket,
  input: HandoffCommitInput,
): Promise<string | null> {
  const { worktree, preSessionHead, handoff } = input;
  if ((await revParse(worktree.path, "HEAD")) !== preSessionHead) {
    await git(worktree.path, "reset", "--soft", preSessionHead);
    context.log.emit("session_activity", ticket.id, {
      text: `${handoff.stage}: session committed; folding its commits into the pipeline's`,
    });
  }
  await git(worktree.path, "add", "-A");
  if (!(await hasStagedChanges(worktree.path))) return null;
  const message = await renderHandoffMessage(context, ticket, input);
  await git(worktree.path, "commit", "-m", message);
  const sha = await revParse(worktree.path, "HEAD");
  // One rendering, two surfaces: the commit and the note carry identical text.
  await recordTransition(input.notePath, handoff.stage, handoff.round, message);
  context.log.emit("session_activity", ticket.id, {
    text: `${handoff.stage}: committed ${shortSha(sha)}`,
  });
  return sha;
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
  roundDir: string,
  notePath: string,
  round: number,
  options: QaStageOptions = {},
): Promise<{ verdict: ReviewVerdict | null; outcome: StageOutcome }> {
  const target = context.config.integration.target_branch;
  const vars = {
    ...commonVars(context, ticket, worktree, agentVerdictPath(worktree.path, "qa")),
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
    ...stageUsageFields(context, ticket.id, outcome.usage),
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
  | { kind: "escalate"; question: string; recommendation: string; observations: string[] };

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
): Promise<{
  step: ImplementationStep;
  sessionId: string | undefined;
  preSessionHead: string;
  usage: SessionUsage;
}> {
  const { roundDir, notePath, round, history, resume } = input;
  const vars = commonVars(
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
  const staged = (step: ImplementationStep) => ({
    step,
    sessionId: outcome.sessionId,
    preSessionHead: outcome.preSessionHead,
    usage: outcome.usage,
  });
  const verdict = await readImplementationVerdict(outcome.verdictPath);
  context.log.emit("stage_end", ticket.id, {
    stage: "implementation",
    verdict: verdict?.status ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
    ...stageUsageFields(context, ticket.id, outcome.usage),
  });
  if (!verdict) {
    return staged({
      kind: "retry",
      feedback: outcome.ok
        ? "The previous implementation session ended without writing a valid verdict file. Re-verify the work is complete, then write the verdict file as instructed."
        : `The previous implementation session failed: ${outcome.resultText}`,
    });
  }
  const decisions = await recordDecisions(notePath, "implementation", round, verdict.decisions);
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
  | { kind: "retry"; feedback: string; observations: string[] };

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
  const vars = {
    ...commonVars(context, ticket, worktree, agentVerdictPath(worktree.path, "code-review")),
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
  // Reviewers are read-only: discard stray modifications, and any commit the
  // session made despite the prompt — a reviewer never moves the branch.
  await git(worktree.path, "reset", "--hard", outcome.preSessionHead);
  const verdict = await readReviewVerdict(outcome.verdictPath, { isEscalateAllowed: false });
  context.log.emit("stage_end", ticket.id, {
    stage: "code-review",
    verdict: verdict?.verdict ?? (outcome.ok ? "invalid-verdict" : "session-failed"),
    ...stageUsageFields(context, ticket.id, outcome.usage),
  });
  if (!verdict || verdict.verdict === "fail") {
    const feedback =
      verdict?.feedback ??
      (verdict
        ? "Code review failed without specific feedback."
        : `Code review session did not produce a valid verdict${outcome.ok ? "" : `: ${outcome.resultText}`}.`);
    await recordReviewTransition(input.notePath, "code-review", input.round, {
      outcome: "FAILED",
      routing: retryRouting(input.round, context.config.pipeline.max_rounds),
      detail: feedback,
    });
    return {
      sessionId: outcome.sessionId,
      step: { kind: "retry", feedback, observations: verdict?.observations ?? [] },
    };
  }
  const decisions = await recordDecisions(
    input.notePath,
    "code-review",
    input.round,
    verdict.decisions,
  );
  await recordReviewTransition(input.notePath, "code-review", input.round, {
    outcome: "PASSED",
    routing: "moving to QA",
    detail: verdict.feedback ?? "",
  });
  return {
    sessionId: outcome.sessionId,
    step: { kind: "pass", decisions, observations: verdict.observations ?? [] },
  };
}

/**
 * A review verdict as the ticket note records it: the status line, then the
 * handback text exactly as the implementer received it — a comment that
 * reworded the feedback would be a second, competing version of it.
 */
function recordReviewTransition(
  notePath: string,
  stage: StageName,
  round: number,
  verdict: { outcome: string; routing: string; detail: string },
): Promise<void> {
  const line = statusLine(stage, verdict.outcome, verdict.routing);
  const detail = verdict.detail.trim();
  return recordTransition(notePath, stage, round, detail === "" ? line : `${line}\n\n${detail}`);
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
  roundDir: string;
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
    reason: `escalated: ${step.question.slice(0, MAX_REASON_CHARS)}`,
  });
  return { kind: "blocked", reason: step.question };
}

/**
 * Where one cycle session's artifacts (verdict, logs, scribe log) land: the
 * round directory itself for the round's first session, a gate-fix subdirectory
 * for each fix session after it — so no session overwrites another's files.
 */
function cycleSessionDir(roundDir: string, fixSession: number): string {
  return fixSession === 0 ? roundDir : path.join(roundDir, `gate-fix-${fixSession}`);
}

/** Narrate an in-round gate failure to the note: why the round grew another commit. */
function recordGateFixTransition(
  notePath: string,
  round: number,
  gate: GateResult,
  fixSession: number,
): Promise<void> {
  const failedStep = gate.results.at(-1)?.name ?? "unknown step";
  return recordTransition(
    notePath,
    "gate",
    round,
    `JFDI gate FAILED at \`${failedStep}\` — returning to Implementation for gate fix ${fixSession + 1} of ${MAX_GATE_FIX_SESSIONS_PER_ROUND}; the round continues`,
  );
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
  }
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
  const { roundDir, notePath, round, runNumber, history, resume } = input;
  const maxRounds = context.config.pipeline.max_rounds;
  const decisions: string[] = [];
  const observations: string[] = [];
  let summary: string | undefined;
  let implementationSession: StageSessionMemory = input.memory.implementation ?? {};
  let lastHandoffCommit: string | null = null;
  // Gate failures this round, oldest first — feedback for the next fix session.
  // Their full transcripts persist independently in the round directory.
  const gateFailures: FeedbackItem[] = [];
  const collected = () => ({ decisions, observations, summary, implementationSession });

  // Termination: each pass either returns (gate green, session retry/escalate,
  // or the fix-session cap); fixSession strictly increases toward the cap.
  for (let fixSession = 0; ; fixSession++) {
    const sessionDir = cycleSessionDir(roundDir, fixSession);
    await ensureDir(sessionDir);
    const implementation = await runImplementationStage(context, ticket, worktree, {
      roundDir: sessionDir,
      notePath,
      round,
      history: [...history, ...gateFailures],
      resume: fixSession === 0 ? resume : null,
      previousSession: implementationSession,
    });
    implementationSession = { sessionId: implementation.sessionId };
    // Before any branching: whatever the session left becomes one commit, on
    // the way out of every exit below. Partial work in a commit is work a
    // re-dispatch can continue; uncommitted, sanitization would throw it away.
    lastHandoffCommit =
      (await commitSessionHandoff(context, ticket, {
        worktree,
        notePath,
        roundDir: sessionDir,
        handoff: implementationHandoff(implementation.step, round, maxRounds, implementation.usage),
        preSessionHead: implementation.preSessionHead,
      })) ?? lastHandoffCommit;
    const contributions = implementationStepContributions(implementation.step, summary);
    decisions.push(...contributions.decisions);
    observations.push(...contributions.observations);
    summary = contributions.summary;
    const exitStep = await implementationExitStep(context, ticket, notePath, implementation.step);
    if (exitStep) return { kind: "exit", ...collected(), step: exitStep };
    if (implementation.step.kind !== "done")
      throw new Error(
        `implementation step "${implementation.step.kind}" escaped implementationExitStep — only "done" may reach the gate`,
      );
    const gate = await runGateStage(
      context,
      ticket,
      worktree,
      path.join(roundDir, `gate-implementation-${fixSession + 1}.log`),
    );
    if (gate.ok) {
      // The sign-offs bind to the pipeline's own handoff commit; only a cycle
      // that committed nothing (an unchanged tree) reviews the branch as it stood.
      const headCommit = lastHandoffCommit ?? (await revParse(worktree.path, "HEAD"));
      return { kind: "proceed", ...collected(), gate, headCommit };
    }
    const feedback = formatGateFailure(gate);
    if (fixSession >= MAX_GATE_FIX_SESSIONS_PER_ROUND) {
      return { kind: "exit", ...collected(), step: { kind: "retry", source: "gate", feedback } };
    }
    gateFailures.push({ run: runNumber, round, source: "gate", feedback });
    await recordGateFixTransition(notePath, round, gate, fixSession);
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
  const { roundDir, notePath, round, history } = input;
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
    roundDir,
    notePath,
    round,
    gate,
    headCommit,
    previousSession: memory["code-review"],
    previousFailure,
  });
  memory["code-review"] = { sessionId: review.sessionId, lastSeenCommit: headCommit };
  observations.push(...review.step.observations);
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

  const qa = await runQaPhase(context, ticket, worktree, {
    roundDir,
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
  roundDir: string;
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
  const maxRounds = context.config.pipeline.max_rounds;
  const qa = await runQaStage(context, ticket, worktree, input.roundDir, notePath, round, {
    gateSummary: input.gateSummary,
    previousSession: input.previousSession,
    previousFailure: input.previousFailure,
  });
  const step = await judgeQa(context, ticket, notePath, qa);
  const handoff = qaHandoff(step, qa.verdict, round, maxRounds, qa.outcome.usage);
  const qaCommit = await commitSessionHandoff(context, ticket, {
    worktree,
    notePath,
    roundDir: input.roundDir,
    handoff,
    preSessionHead: qa.outcome.preSessionHead,
  });
  await recordReviewTransition(notePath, "qa", round, {
    outcome: handoff.outcome,
    routing: handoff.routing,
    detail: qa.verdict?.feedback ?? "",
  });
  const memory = {
    sessionId: qa.outcome.sessionId,
    lastSeenCommit: qaCommit ?? input.headCommit,
  };
  const collected = {
    decisions: qa.verdict?.decisions ?? [],
    observations: qa.verdict?.observations ?? [],
  };
  if (step.kind !== "passed") return { step, ...collected, memory };

  if (qaCommit === null) return { step, ...collected, memory };
  const postQaGate = await runGateStage(
    context,
    ticket,
    worktree,
    path.join(input.roundDir, "gate-post-qa-1.log"),
  );
  if (postQaGate.ok) return { step, ...collected, memory };
  return {
    ...collected,
    memory,
    step: {
      kind: "retry",
      source: "gate",
      feedback: `The mechanical gate failed after QA committed its tests.\n\n${formatGateFailure(postQaGate)}`,
    },
  };
}

/** Longest excerpt of a failure reason carried on a status line. */
const MAX_OUTCOME_REASON_CHARS = 100;

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, MAX_OUTCOME_REASON_CHARS);
}

/** What the Implementation session's commit says happened, and where the run went. */
function implementationHandoff(
  step: ImplementationStep,
  round: number,
  maxRounds: number,
  usage: SessionUsage,
): SessionHandoff {
  const base = { stage: "implementation" as const, round, maxRounds, usage };
  switch (step.kind) {
    case "done":
      return {
        ...base,
        outcome: "complete",
        routing: "moving to the mechanical gate",
        summary: step.summary ?? "",
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
): SessionHandoff {
  const base = { stage: "qa" as const, round, maxRounds, usage };
  if (step.kind === "passed")
    return {
      ...base,
      outcome: "PASSED",
      routing: "re-running the mechanical gate over the tests it wrote",
      summary: verdict?.testsAdded ?? "",
      isInterrupted: false,
    };
  if (step.kind === "blocked")
    return {
      ...base,
      outcome: "escalated",
      routing: BLOCKED_ROUTING,
      summary: step.reason,
      isInterrupted: true,
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
        `QA session did not produce a valid verdict${qa.outcome.ok ? "" : `: ${qa.outcome.resultText}`}.`,
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
  // A fresh tally per run, and the clock the ticket-level elapsed measures from.
  context.usage.start(ticket.id);
  const runStartedMs = nowMs(context);
  context.log.emit("dispatch", ticket.id, { title: ticket.cardText, branch: worktree.branch });
  await recordTransition(
    notePath,
    "dispatch",
    1,
    `JFDI run started — round 1, branch \`${worktree.branch}\``,
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

  // Why the previous run failed, recovered from disk; `history` is this run's own.
  const priorHistory = runDirs.previous ? await loadFeedbackHistory(runDirs.previous) : [];
  const history: FeedbackItem[] = [];
  const allDecisions: string[] = [];
  const allObservations = new Set<string>();
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
      runNumber: runDirs.runNumber,
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
        run: runDirs.runNumber,
        round,
        source: result.step.source,
        feedback: result.step.feedback,
      });
      await saveFeedbackHistory(runDirs.current, [...priorHistory, ...history]);
      continue;
    }
    if (result.step.kind === "blocked") {
      // A blocked run concluded nothing: the session saw the inherited feedback
      // but stopped on a question instead of answering it. So the inherited
      // items stay unanswered business too and are carried forward.
      await saveFeedbackHistory(runDirs.current, [...priorHistory, ...history]);
      return {
        status: "blocked",
        reason: result.step.reason,
        observations: [...allObservations],
      };
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
  await recordTransition(
    notePath,
    "pipeline",
    maxRounds,
    `JFDI run exhausted its ${maxRounds} rounds — ${BLOCKED_ROUTING}\n\n${historyMarkdown}`,
  );
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
  return {
    status: "blocked",
    reason: `retries exhausted after ${maxRounds} rounds`,
    observations,
  };
}
