import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StageName } from "./events.js";
import { formatGateFailure, runGate } from "./gate.js";
import {
  abortMerge,
  commitAllIfDirty,
  commitMerge,
  deleteBranch,
  fastForward,
  GitError,
  git,
  isAncestor,
  isMergeInProgress,
  mergeTargetIntoBranch,
  parseRevision,
  removeWorktree,
  type Worktree,
} from "./git.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runHeldSession, runQaStage, runsDirectory, sessionSelectionFields } from "./pipeline.js";
import { formatGateCommands, loadPrompt, renderPrompt } from "./prompts.js";
import { isCorruptReport, loadReport, recordCorruptReport } from "./report.js";
import { appendToSection, quoteAgentText } from "./ticket-note.js";
import { ensureTicketNote, type Ticket } from "./tickets.js";
import { BLOCKED_ROUTING, recordPhase, shortSha, statusLine } from "./transitions.js";
import { renderUsageTable, resolveUsageModel, type UsageRow } from "./usage.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDirectory, fileExists } from "./util/fsx.js";
import {
  agentVerdictPath,
  collectVerdict,
  type IntegrationVerdict,
  readIntegrationVerdict,
} from "./verdicts.js";

/**
 * Integration is coordinator-owned and runs outside the round loop, so its
 * comments carry no round of their own — the same zero its QA re-run uses.
 */
const INTEGRATION_ROUND = 0;

/** Remote failures get five total attempts before integration blocks. */
const REMOTE_OPERATION_MAX_ATTEMPTS = 5;

/** First remote retry wait; each later wait doubles while the integration lock stays held. */
const REMOTE_RETRY_INITIAL_DELAY_MS = 30_000;

/** Exponential multiplier between successive remote-operation waits. */
const REMOTE_RETRY_BACKOFF_FACTOR = 2;

/** Unit conversion for narrating retry delays. */
const MILLISECONDS_PER_SECOND = 1_000;

type RemoteOperation = "fetch" | "push";

interface IntegrationRemote {
  name: string;
  sourceReference: string;
  trackingReference: string;
}

interface RemoteOperationFailure {
  status: "failed";
  reason: string;
}

/**
 * One integration's bounded remote-operation story. At most two operations,
 * five attempts apiece, their retries, and one fast-forward are recorded.
 */
class IntegrationNarration {
  private readonly lines: string[] = [];

  constructor(
    private readonly context: PipelineContext,
    private readonly ticket: Ticket,
  ) {}

  record(data: Record<string, unknown> & { text: string }): void {
    this.lines.push(data.text);
    this.context.log.emit("integration_activity", this.ticket.id, data);
  }

  render(): string {
    if (this.lines.length === 0) return "";
    return ["Remote operations:", ...this.lines.map((line) => `- ${line}`)].join("\n");
  }
}

/** Wait without detaching the integration job from its queue's critical section. */
function waitForRemoteRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Resolve the target's upstream remote and refs. With no configured remotes,
 * opt-in flags deliberately become a no-op. A target without an upstream uses
 * origin and a same-named branch, exactly like the configuration contract.
 */
async function resolveIntegrationRemote(
  projectRoot: string,
  target: string,
): Promise<IntegrationRemote | null> {
  const remotes = (await git(projectRoot, "remote")).split("\n").filter(Boolean);
  if (remotes.length === 0) return null;

  const upstreamFields = (
    await git(
      projectRoot,
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
      `refs/heads/${target}`,
    )
  ).split("\0");
  const [upstreamRemote, upstreamSourceReference, upstreamTrackingReference] = upstreamFields;
  if (
    upstreamRemote &&
    upstreamSourceReference &&
    upstreamTrackingReference &&
    remotes.includes(upstreamRemote)
  ) {
    return {
      name: upstreamRemote,
      sourceReference: upstreamSourceReference,
      trackingReference: upstreamTrackingReference,
    };
  }
  return {
    name: "origin",
    sourceReference: `refs/heads/${target}`,
    trackingReference: `refs/remotes/origin/${target}`,
  };
}

function remoteGitError(error: unknown): string {
  if (error instanceof GitError && error.stderr.trim()) return error.stderr.trim();
  return (error as Error).message;
}

function remoteAttemptAction(operation: RemoteOperation, attempt: number): string {
  if (operation === "fetch") return attempt === 1 ? "Fetching from" : "Retrying fetch from";
  return attempt === 1 ? "Pushing to" : "Retrying push to";
}

/** Run one fetch or push with the fixed exponential-backoff policy. */
async function runRemoteOperation(
  remote: IntegrationRemote,
  operation: RemoteOperation,
  narration: IntegrationNarration,
  run: () => Promise<void>,
): Promise<RemoteOperationFailure | null> {
  for (let attempt = 1; attempt <= REMOTE_OPERATION_MAX_ATTEMPTS; attempt += 1) {
    const action = remoteAttemptAction(operation, attempt);
    narration.record({
      operation,
      status: "attempt",
      remote: remote.name,
      attempt,
      maxAttempts: REMOTE_OPERATION_MAX_ATTEMPTS,
      text: `${action} remote \`${remote.name}\` (attempt ${attempt}/${REMOTE_OPERATION_MAX_ATTEMPTS}).`,
    });
    try {
      await run();
      narration.record({
        operation,
        status: "succeeded",
        remote: remote.name,
        attempt,
        maxAttempts: REMOTE_OPERATION_MAX_ATTEMPTS,
        text: `${operation === "fetch" ? "Fetched from" : "Pushed to"} remote \`${remote.name}\` on attempt ${attempt}/${REMOTE_OPERATION_MAX_ATTEMPTS}.`,
      });
      return null;
    } catch (error) {
      const detail = remoteGitError(error);
      if (attempt === REMOTE_OPERATION_MAX_ATTEMPTS) {
        const reason = `git ${operation} with remote ${remote.name} failed after ${REMOTE_OPERATION_MAX_ATTEMPTS} attempts: ${detail}`;
        narration.record({
          operation,
          status: "failed",
          remote: remote.name,
          attempt,
          maxAttempts: REMOTE_OPERATION_MAX_ATTEMPTS,
          error: detail,
          text: reason,
        });
        return { status: "failed", reason };
      }
      const delayMs = REMOTE_RETRY_INITIAL_DELAY_MS * REMOTE_RETRY_BACKOFF_FACTOR ** (attempt - 1);
      narration.record({
        operation,
        status: "retry",
        remote: remote.name,
        attempt: attempt + 1,
        maxAttempts: REMOTE_OPERATION_MAX_ATTEMPTS,
        delayMs,
        error: detail,
        text: `Git ${operation} failed on attempt ${attempt}/${REMOTE_OPERATION_MAX_ATTEMPTS}; retrying in ${delayMs / MILLISECONDS_PER_SECOND} seconds.`,
      });
      await waitForRemoteRetry(delayMs);
    }
  }
  throw new Error(`remote ${operation} retry loop exhausted without returning an outcome`);
}

/**
 * Fetch and, only when strictly behind, fast-forward the local target. A
 * target strictly ahead of the fetched ref needs no sync — pushAfter, when
 * enabled, advances the remote. Only true divergence (each ref holds commits
 * the other lacks) blocks.
 */
async function fetchTarget(
  context: PipelineContext,
  remote: IntegrationRemote,
  target: string,
  narration: IntegrationNarration,
): Promise<RemoteOperationFailure | null> {
  const fetchFailure = await runRemoteOperation(remote, "fetch", narration, async () => {
    await git(
      context.projectRoot,
      "fetch",
      remote.name,
      `+${remote.sourceReference}:${remote.trackingReference}`,
    );
  });
  if (fetchFailure) return fetchFailure;

  const localCommit = await parseRevision(context.projectRoot, target);
  const remoteCommit = await parseRevision(context.projectRoot, remote.trackingReference);
  if (localCommit === remoteCommit) return null;
  if (await isAncestor(context.projectRoot, remote.trackingReference, target)) return null;
  if (!(await isAncestor(context.projectRoot, target, remote.trackingReference))) {
    const reason = `local target ref ${target} (${localCommit}) has diverged from fetched ref ${remote.trackingReference} (${remoteCommit}); JFDI will not resolve or overwrite either ref`;
    narration.record({
      operation: "fetch",
      status: "failed",
      remote: remote.name,
      error: reason,
      text: reason,
    });
    return { status: "failed", reason };
  }

  try {
    await fastForward(context.projectRoot, target, remote.trackingReference);
  } catch (error) {
    const reason = `fast-forwarding local target ref ${target} to fetched ref ${remote.trackingReference} failed: ${(error as Error).message}`;
    narration.record({
      operation: "fast-forward",
      status: "failed",
      remote: remote.name,
      error: reason,
      text: reason,
    });
    return { status: "failed", reason };
  }
  narration.record({
    operation: "fast-forward",
    status: "succeeded",
    remote: remote.name,
    text: `Fast-forwarded local target \`${target}\` to fetched ref \`${remote.trackingReference}\` (${remoteCommit}).`,
  });
  return null;
}

/** Push only the configured target branch to its resolved remote branch. */
function pushTarget(
  context: PipelineContext,
  remote: IntegrationRemote,
  target: string,
  narration: IntegrationNarration,
): Promise<RemoteOperationFailure | null> {
  return runRemoteOperation(remote, "push", narration, async () => {
    await git(
      context.projectRoot,
      "push",
      remote.name,
      `refs/heads/${target}:${remote.sourceReference}`,
    );
  });
}

type RemotePreparation =
  | {
      status: "ready";
      remote: IntegrationRemote | null;
      narration: IntegrationNarration;
    }
  | { status: "failed"; reason: string; narration: IntegrationNarration };

/** Resolve the opt-in remote and fetch the target before any merge inspection. */
async function prepareRemoteIntegration(
  context: PipelineContext,
  ticket: Ticket,
  target: string,
): Promise<RemotePreparation> {
  const narration = new IntegrationNarration(context, ticket);
  const remoteConfig = context.config.integration.remote;
  const shouldUseRemote = remoteConfig.fetchBefore || remoteConfig.pushAfter;
  const remote = shouldUseRemote
    ? await resolveIntegrationRemote(context.projectRoot, target)
    : null;
  if (!remoteConfig.fetchBefore || !remote) return { status: "ready", remote, narration };
  const failure = await fetchTarget(context, remote, target, narration);
  if (failure) return { status: "failed", reason: failure.reason, narration };
  return { status: "ready", remote, narration };
}

/** Preserve every serialized integration gate run without overwriting an earlier attempt. */
async function nextIntegrationGateLogPath(runDirectory: string, step: string): Promise<string> {
  const prefix = `gate-${step}-`;
  const attempts = (await fs.readdir(runDirectory)).flatMap((entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith(".log")) return [];
    const attemptText = entry.slice(prefix.length, -".log".length);
    if (!/^\d+$/.test(attemptText)) return [];
    return [Number.parseInt(attemptText, 10)];
  });
  const attempt = Math.max(0, ...attempts) + 1;
  return path.join(runDirectory, `${prefix}${attempt}.log`);
}

export type IntegrateOutcome =
  | { status: "merged" }
  | { status: "already-merged" }
  | { status: "blocked"; reason: string };

type ConflictOutcome =
  | { status: "resolved"; notes: string }
  | { status: "blocked"; reason: string };

/** Drive the Integration agent over the conflicted worktree and read its verdict. */
async function runIntegrationAgent(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  runDirectory: string,
): Promise<IntegrationVerdict | null> {
  const stage: StageName = "integration";
  const configAtStart = context.config;
  const agent = {
    harness: context.harnesses[stage],
    config: configAtStart.stages[stage],
  };
  const verdictPath = path.join(runDirectory, "integration.verdict.json");
  const template = await loadPrompt(context.jfdiDirectory, "integration");
  const prompt = renderPrompt(template, {
    TICKET_ID: ticket.id,
    SPEC: ticket.description,
    BRANCH: worktree.branch,
    TARGET_BRANCH: context.config.integration.targetBranch,
    GATE_COMMANDS: formatGateCommands(context.config.gate),
    VERDICT_PATH: agentVerdictPath(worktree.path, stage),
  });
  context.log.emit("stage_start", ticket.id, {
    stage,
    ...sessionSelectionFields(configAtStart, stage),
  });
  const result = await runHeldSession(
    context,
    ticket.id,
    stage,
    prompt,
    { cwd: worktree.path, logPath: path.join(runDirectory, "integration.log.jsonl") },
    (event) => {
      if (event.type === "tool")
        context.log.emit("session_activity", ticket.id, { text: `integration: ${event.name}` });
    },
    agent,
  );
  // The agent wrote its verdict inside the worktree (the only place sandboxed
  // permission modes allow); collect it before reading.
  await collectVerdict(agentVerdictPath(worktree.path, stage), verdictPath);
  const verdictResult = await readIntegrationVerdict(verdictPath);
  const verdict = verdictResult.status === "valid" ? verdictResult.verdict : null;
  const model = resolveUsageModel(result.usage, agent.config.model);
  // Only this session's own numbers: integration runs may be a separate process
  // whose ledger holds no pipeline stages, so it must not overwrite the run
  // total the pipeline's own stage_end events already set. Its cost still reaches
  // the merged table's Integration row, from the ledger this session tallied into.
  context.log.emit("stage_end", ticket.id, {
    stage,
    verdict: verdict?.resolution ?? (result.ok ? "invalid-verdict" : "session-failed"),
    ...(model === null ? {} : { model: model.name, modelSource: model.source }),
    durationMs: result.usage.durationMs,
    costUsd: result.usage.costUsd,
    tokens: result.usage.inputTokens + result.usage.outputTokens,
  });
  return verdict;
}

/**
 * A resolution the agent itself called "complicated" touched real logic, so the
 * sign-off no longer binds to what is about to land: re-run QA and the gate.
 */
async function requalifyAfterMerge(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  notePath: string,
  runDirectory: string,
  notes: string,
): Promise<ConflictOutcome> {
  context.log.emit("complicated_merge", ticket.id, { notes });
  const qaDirectory = path.join(runDirectory, "requalify");
  await ensureDirectory(qaDirectory);
  const qa = await runQaStage(context, ticket, worktree, qaDirectory, notePath, {
    gateSummary:
      "The target branch was just merged in with conflict resolutions; the pipeline re-runs the full mechanical gate after your session — do not run it yourself.",
  });
  if (qa.verdict?.verdict !== "pass") {
    const detail = qa.verdict?.feedback ?? qa.verdict?.question ?? "no valid verdict";
    return { status: "blocked", reason: `post-merge QA did not pass: ${detail}` };
  }
  const gate = await runGate(
    context.config.gate,
    worktree.path,
    await nextIntegrationGateLogPath(runDirectory, "requalify"),
  );
  if (!gate.ok)
    return { status: "blocked", reason: `gate failed after re-QA:\n\n${formatGateFailure(gate)}` };
  return { status: "resolved", notes };
}

/**
 * A conflicted merge, from conflict to landable tree: the Integration agent
 * resolves in the worktree, the gate reruns on the result, and a complicated
 * resolution goes back through QA before it is allowed near the target.
 */
async function resolveConflictedMerge(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  notePath: string,
  runDirectory: string,
): Promise<ConflictOutcome> {
  const verdict = await runIntegrationAgent(context, ticket, worktree, runDirectory);
  if (await isMergeInProgress(worktree.path))
    return {
      status: "blocked",
      reason: "integration agent left the merge unfinished — resolve manually in the worktree",
    };
  if (!verdict) return { status: "blocked", reason: "integration agent produced no valid verdict" };
  const notes = verdict.notes ?? "";

  const gate = await runGate(
    context.config.gate,
    worktree.path,
    await nextIntegrationGateLogPath(runDirectory, "conflict-resolution"),
  );
  context.log.emit("gate_result", ticket.id, { ok: gate.ok });
  if (!gate.ok)
    return {
      status: "blocked",
      reason: `gate failed after conflict resolution:\n\n${formatGateFailure(gate)}`,
    };

  if (verdict.resolution !== "complicated") return { status: "resolved", notes };
  return requalifyAfterMerge(context, ticket, worktree, notePath, runDirectory, notes);
}

type QualifiedMerge =
  | { status: "qualified"; resolutionNote: string }
  | { status: "failed"; reason: string };

/** Merge the current target into the ticket branch and qualify the resulting tree. */
async function mergeAndQualify(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  notePath: string,
  runDirectory: string,
  target: string,
): Promise<QualifiedMerge> {
  const merge = await mergeTargetIntoBranch(worktree.path, target);
  if (!merge.ok) {
    if (!merge.hasConflict)
      return {
        status: "failed",
        reason: `merging ${target} into ${worktree.branch} failed: ${merge.output}`,
      };
    const resolution = await resolveConflictedMerge(
      context,
      ticket,
      worktree,
      notePath,
      runDirectory,
    );
    if (resolution.status === "blocked") return { status: "failed", reason: resolution.reason };
    return { status: "qualified", resolutionNote: resolution.notes };
  }

  const gate = await runGate(
    context.config.gate,
    worktree.path,
    await nextIntegrationGateLogPath(runDirectory, "clean-merge"),
  );
  context.log.emit("gate_result", ticket.id, { ok: gate.ok });
  if (!gate.ok)
    return {
      status: "failed",
      reason: `gate failed after merging ${target} into ${worktree.branch}:\n\n${formatGateFailure(gate)}`,
    };
  return { status: "qualified", resolutionNote: "" };
}

/**
 * Commit whatever a session left uncommitted, so that what lands is what the
 * gate ran against. The gate runs against the *working tree* while the landing
 * commit is built from HEAD's *tree*: the re-QA valve's own regression test, or
 * a file the conflict resolution left behind, would otherwise be dropped from
 * the merge — and then lost for good, because a successful integration removes
 * the worktree. Mirrors the pipeline's own post-QA checkpoint. Returns the
 * clause for the ticket note, empty when there was nothing to commit.
 */
async function captureLeftovers(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
): Promise<string> {
  const hasCommitted = await commitAllIfDirty(
    worktree.path,
    `jfdi(${ticket.id}): integration leftovers`,
  );
  if (!hasCommitted) return "";
  context.log.emit("session_activity", ticket.id, {
    text: "integration: committed changes a session left uncommitted",
  });
  return " Uncommitted changes a session left behind were committed into the merge.";
}

/**
 * The landing commit's message. It names the ticket, and is where trailers
 * (sign-off shas, run id) belong once the pipeline grows them.
 */
function mergeCommitMessage(ticket: Ticket, branch: string, target: string): string {
  return `Merge ${branch} into ${target}\n\n${ticket.cardText}\n`;
}

type LandingOutcome =
  | { status: "landed"; landingCommit: string; leftoverNote: string }
  | { status: "failed"; reason: string };

/** Build the merge commit from the tested tree and move the local target to it. */
async function landMerge(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  target: string,
  targetHead: string,
  signedOffCommit: string,
): Promise<LandingOutcome> {
  try {
    const leftoverNote = await captureLeftovers(context, ticket, worktree);
    const landingCommit = await commitMerge(
      worktree.path,
      { firstParent: targetHead, secondParent: signedOffCommit },
      mergeCommitMessage(ticket, worktree.branch, target),
    );
    await fastForward(context.projectRoot, target, landingCommit);
    return { status: "landed", landingCommit, leftoverNote };
  } catch (error) {
    return { status: "failed", reason: `merge failed: ${(error as Error).message}` };
  }
}

type StaleMergeOutcome = { status: "clear"; note?: string } | { status: "blocked"; reason: string };

/**
 * A previous integration can leave the worktree mid-merge (the agent gave up
 * half-resolved and we blocked). Re-entering there makes git refuse with "you
 * have not concluded your merge" — which is not a conflict, so it would block
 * again with a baffling reason. Abort first: this discards the integration
 * agent's half-done conflict resolutions because mid-merge working-tree state
 * cannot be checkpoint-committed. The raw session log at
 * runs/<ticket>/integration/integration.log.jsonl retains the agent's edit
 * history for manual archaeology. A worktree that is gone has no merge to abort;
 * the merge itself reports its absence as a blocked integration. An abort git
 * refuses is fatal to this integration — everything after it would run over
 * conflict markers.
 */
async function clearStaleMerge(worktree: Worktree): Promise<StaleMergeOutcome> {
  if (!(await fileExists(worktree.path))) return { status: "clear" };
  if (!(await isMergeInProgress(worktree.path))) return { status: "clear" };
  try {
    await abortMerge(worktree.path);
  } catch (error) {
    return { status: "blocked", reason: (error as Error).message };
  }
  return { status: "clear", note: "aborted a stale merge left in the worktree" };
}

type AlreadyMergedResolution =
  | { status: "continue"; leftoverNote: string }
  | { status: "complete"; outcome: IntegrateOutcome };

/** Close a clean hand-merge, or checkpoint dirty work before normal integration. */
async function resolveAlreadyMergedBranch(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  notePath: string,
  target: string,
  integrationNarration: IntegrationNarration,
): Promise<AlreadyMergedResolution> {
  if (!(await isAncestor(context.projectRoot, worktree.branch, target)))
    return { status: "continue", leftoverNote: "" };

  let leftoverNote = "";
  if (await fileExists(worktree.path)) {
    try {
      leftoverNote = await captureLeftovers(context, ticket, worktree);
    } catch (error) {
      return {
        status: "complete",
        outcome: await blocked(
          context,
          ticket,
          notePath,
          `checkpointing uncommitted changes before cleanup failed: ${(error as Error).message}`,
          integrationNarration.render(),
        ),
      };
    }
  }
  if (leftoverNote) return { status: "continue", leftoverNote };

  context.log.emit("merged", ticket.id, { note: "already contained in target" });
  await recordPhase(
    notePath,
    "Integration complete",
    "integration",
    INTEGRATION_ROUND,
    [
      `Branch already contained in \`${target}\` — closed without re-merging.`,
      integrationNarration.render(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  context.usage.finish(ticket.id);
  await cleanup(context, worktree);
  return { status: "complete", outcome: { status: "already-merged" } };
}

/**
 * Integrate one finished ticket: merge the target branch into the ticket
 * branch in its own worktree, resolve conflicts via the Integration agent,
 * rerun the gate, judge complicated merges back through QA, then land the
 * tested tree on the target as a merge commit — target's prior head first
 * parent, signed-off branch head second, so the sign-offs stay reachable and
 * `git log --first-parent` reads one entry per ticket. The caller is
 * responsible for serialization — exactly one integration runs at a time.
 */
export async function integrateTicket(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
): Promise<IntegrateOutcome> {
  const target = context.config.integration.targetBranch;
  const runDirectory = path.join(runsDirectory(context.stateDirectory, ticket.id), "integration");
  const notePath = await ensureTicketNote(
    ticket,
    path.join(context.projectRoot, context.config.ticketsDirectory),
  );
  const savedReport = await loadReport(context.stateDirectory, ticket.id);
  if (savedReport && isCorruptReport(savedReport)) {
    const reason = await recordCorruptReport(context, ticket.id, notePath, savedReport);
    return { status: "blocked", reason };
  }
  await ensureDirectory(runDirectory);
  const stale = await clearStaleMerge(worktree);
  if (stale.status === "blocked") return blocked(context, ticket, notePath, stale.reason);
  context.log.emit("merge_start", ticket.id, stale.note ? { note: stale.note } : undefined);
  // A coordinator in another process reads integration records from disk. Make
  // the in-flight record durable before git can expose a landed branch, or its
  // sweep can mistake this integration for a hand-merge and narrate it twice.
  await context.log.flush();

  const remotePreparation = await prepareRemoteIntegration(context, ticket, target);
  if (remotePreparation.status === "failed")
    return blocked(
      context,
      ticket,
      notePath,
      remotePreparation.reason,
      remotePreparation.narration.render(),
    );
  const { narration: integrationNarration, remote } = remotePreparation;

  // Human may have merged by hand (on-approval mode) — never double-merge a
  // clean branch. Dirty work advances the branch when checkpointed, so it must
  // fall through and land through the normal merge path instead of being lost.
  const alreadyMerged = await resolveAlreadyMergedBranch(
    context,
    ticket,
    worktree,
    notePath,
    target,
    integrationNarration,
  );
  if (alreadyMerged.status === "complete") return alreadyMerged.outcome;
  let { leftoverNote } = alreadyMerged;

  // Both parents of the landing commit, read before the merge moves either.
  const signedOffCommit = await parseRevision(context.projectRoot, worktree.branch);
  const targetHead = await parseRevision(context.projectRoot, target);

  const qualified = await mergeAndQualify(
    context,
    ticket,
    worktree,
    notePath,
    runDirectory,
    target,
  );
  if (qualified.status === "failed")
    return blocked(context, ticket, notePath, qualified.reason, integrationNarration.render());

  // 5. Land it: the tree the gate just ran against, under a merge commit that
  //    keeps the target's line first and the signed-off commit reachable.
  const landing = await landMerge(context, ticket, worktree, target, targetHead, signedOffCommit);
  if (landing.status === "failed") {
    return blocked(context, ticket, notePath, landing.reason, integrationNarration.render());
  }
  if (landing.leftoverNote) leftoverNote = landing.leftoverNote;
  if (context.config.integration.remote.pushAfter && remote) {
    const pushFailure = await pushTarget(context, remote, target, integrationNarration);
    if (pushFailure)
      return blocked(context, ticket, notePath, pushFailure.reason, integrationNarration.render());
  }
  context.log.emit("merged", ticket.id);
  await recordMergedTransition(
    context,
    ticket,
    notePath,
    {
      target,
      landingCommit: landing.landingCommit,
      leftoverNote,
      resolutionNote: qualified.resolutionNote,
      integrationNarration,
    },
    savedReport,
  );
  context.usage.finish(ticket.id);
  await cleanup(context, worktree);
  await deleteBranch(context.projectRoot, worktree.branch);
  return { status: "merged" };
}

/**
 * The whole run's model/cost/time table for the merged comment: the pipeline's stages
 * from the persisted report (it survives the process boundary a manual `jfdi
 * merge` crosses), plus the Integration row from this process's own ledger when
 * a conflict pulled in an integration agent. Null when there is nothing to show.
 */
function mergedUsageTable(
  context: PipelineContext,
  ticketId: string,
  report: RunReport | null,
): string | null {
  const integrationRow = context.usage
    .of(ticketId)
    .snapshot()
    .find((row: UsageRow) => row.label === "Integration");
  const rows = [...(report?.usageRows ?? []), ...(integrationRow ? [integrationRow] : [])];
  if (rows.length === 0) return null;
  return renderUsageTable(rows, report?.elapsedMs ?? null);
}

interface MergedTransitionDetails {
  target: string;
  landingCommit: string;
  leftoverNote: string;
  resolutionNote: string;
  integrationNarration: IntegrationNarration;
}

/** Record the closing comment, including any usage, leftovers, and conflict notes. */
async function recordMergedTransition(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  details: MergedTransitionDetails,
  report: RunReport | null,
): Promise<void> {
  // The whole body is blockquoted as one comment, so the Integration agent's
  // resolution notes ride in raw rather than pre-quoted like a standalone append.
  const mergedNarration = [
    statusLine(
      "integration",
      "merged",
      `landed on \`${details.target}\` as \`${shortSha(details.landingCommit)}\``,
    ),
  ];
  const table = mergedUsageTable(context, ticket.id, report);
  if (table) mergedNarration.push("", table);
  if (details.leftoverNote) mergedNarration.push("", details.leftoverNote.trim());
  if (details.resolutionNote)
    mergedNarration.push("", "Conflict resolution:", details.resolutionNote);
  const remoteOperations = details.integrationNarration.render();
  if (remoteOperations) mergedNarration.push("", remoteOperations);
  await recordPhase(
    notePath,
    "Integration complete",
    "integration",
    INTEGRATION_ROUND,
    mergedNarration.join("\n"),
  );
}

async function cleanup(context: PipelineContext, worktree: Worktree): Promise<void> {
  await removeWorktree(context.projectRoot, worktree.path, { shouldForce: true });
}

async function blocked(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  reason: string,
  integrationNarration = "",
): Promise<IntegrateOutcome> {
  const unnarratedReason = integrationNarration.endsWith(reason) ? "" : reason;
  await recordPhase(
    notePath,
    "Integration complete",
    "integration",
    INTEGRATION_ROUND,
    [statusLine("integration", "blocked", BLOCKED_ROUTING), integrationNarration, unnarratedReason]
      .filter(Boolean)
      .join("\n\n"),
  );
  await appendToSection(
    notePath,
    "Questions",
    [
      `### ${todayIsoDate()} — integration`,
      "",
      quoteAgentText(reason),
      "",
      `_The worktree is kept for inspection under \`.jfdi/worktrees/\`. Fix, then move the card back to "${context.config.board.columns.begin}"._`,
    ].join("\n"),
  );
  context.log.emit("blocked", ticket.id, { reason: reason.split("\n")[0] });
  context.usage.finish(ticket.id);
  return { status: "blocked", reason };
}

/** Serializes integrations: the global critical section. */
export class IntegrationQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async idle(): Promise<void> {
    await this.chain;
  }
}
