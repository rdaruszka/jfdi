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
  isAncestor,
  isMergeInProgress,
  mergeTargetIntoBranch,
  removeWorktree,
  revParse,
  type Worktree,
} from "./git.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runHeldSession, runQaStage, runsDir, sessionSelectionFields } from "./pipeline.js";
import { formatGateCommands, loadPrompt, renderPrompt } from "./prompts.js";
import { isCorruptReport, loadReport, recordCorruptReport } from "./report.js";
import { appendToSection, quoteAgentText } from "./ticket-note.js";
import { ensureTicketNote, type Ticket } from "./tickets.js";
import { BLOCKED_ROUTING, recordTransition, shortSha, statusLine } from "./transitions.js";
import { renderUsageTable, type UsageRow } from "./usage.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDir, fileExists } from "./util/fsx.js";
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

/** Preserve every serialized integration gate run without overwriting an earlier attempt. */
async function nextIntegrationGateLogPath(runDir: string, step: string): Promise<string> {
  const prefix = `gate-${step}-`;
  const attempts = (await fs.readdir(runDir)).flatMap((entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith(".log")) return [];
    const attemptText = entry.slice(prefix.length, -".log".length);
    if (!/^\d+$/.test(attemptText)) return [];
    return [Number.parseInt(attemptText, 10)];
  });
  const attempt = Math.max(0, ...attempts) + 1;
  return path.join(runDir, `${prefix}${attempt}.log`);
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
  runDir: string,
): Promise<IntegrationVerdict | null> {
  const stage: StageName = "integration";
  const verdictPath = path.join(runDir, "integration.verdict.json");
  const template = await loadPrompt(context.jfdiDir, "integration");
  const prompt = renderPrompt(template, {
    TICKET_ID: ticket.id,
    SPEC: ticket.spec,
    BRANCH: worktree.branch,
    TARGET_BRANCH: context.config.integration.target_branch,
    GATE_COMMANDS: formatGateCommands(context.config.gate),
    VERDICT_PATH: agentVerdictPath(worktree.path, stage),
  });
  context.log.emit("stage_start", ticket.id, {
    stage,
    ...sessionSelectionFields(context.config, stage),
  });
  const result = await runHeldSession(
    context,
    ticket.id,
    stage,
    { prompt },
    { cwd: worktree.path, logPath: path.join(runDir, "integration.log.jsonl") },
    (event) => {
      if (event.type === "tool")
        context.log.emit("session_activity", ticket.id, { text: `integration: ${event.name}` });
    },
  );
  // The agent wrote its verdict inside the worktree (the only place sandboxed
  // permission modes allow); collect it before reading.
  await collectVerdict(agentVerdictPath(worktree.path, stage), verdictPath);
  const verdictResult = await readIntegrationVerdict(verdictPath);
  const verdict = verdictResult.status === "valid" ? verdictResult.verdict : null;
  // Only this session's own numbers: integration runs may be a separate process
  // whose ledger holds no pipeline stages, so it must not overwrite the run
  // total the pipeline's own stage_end events already set. Its cost still reaches
  // the merged table's Integration row, from the ledger this session tallied into.
  context.log.emit("stage_end", ticket.id, {
    stage,
    verdict: verdict?.resolution ?? (result.ok ? "invalid-verdict" : "session-failed"),
    ...(result.usage
      ? {
          durationMs: result.usage.durationMs,
          costUsd: result.usage.costUsd,
          tokens: result.usage.inputTokens + result.usage.outputTokens,
        }
      : {}),
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
  runDir: string,
  notes: string,
): Promise<ConflictOutcome> {
  context.log.emit("complicated_merge", ticket.id, { notes });
  const qaDir = path.join(runDir, "requalify");
  await ensureDir(qaDir);
  const qa = await runQaStage(context, ticket, worktree, qaDir, notePath, 0, {
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
    await nextIntegrationGateLogPath(runDir, "requalify"),
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
  runDir: string,
): Promise<ConflictOutcome> {
  const verdict = await runIntegrationAgent(context, ticket, worktree, runDir);
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
    await nextIntegrationGateLogPath(runDir, "conflict-resolution"),
  );
  context.log.emit("gate_result", ticket.id, { ok: gate.ok });
  if (!gate.ok)
    return {
      status: "blocked",
      reason: `gate failed after conflict resolution:\n\n${formatGateFailure(gate)}`,
    };

  if (verdict.resolution !== "complicated") return { status: "resolved", notes };
  return requalifyAfterMerge(context, ticket, worktree, notePath, runDir, notes);
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
): Promise<AlreadyMergedResolution> {
  if (!(await isAncestor(context.repoRoot, worktree.branch, target)))
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
        ),
      };
    }
  }
  if (leftoverNote) return { status: "continue", leftoverNote };

  context.log.emit("merged", ticket.id, { note: "already contained in target" });
  await recordTransition(
    notePath,
    "integration",
    INTEGRATION_ROUND,
    `Branch already contained in \`${target}\` — closed without re-merging.`,
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
  const target = context.config.integration.target_branch;
  const runDir = path.join(runsDir(context.stateDir, ticket.id), "integration");
  const notePath = await ensureTicketNote(
    ticket,
    path.join(context.repoRoot, context.config.ticketsDir),
  );
  const savedReport = await loadReport(context.stateDir, ticket.id);
  if (savedReport && isCorruptReport(savedReport)) {
    const reason = await recordCorruptReport(context, ticket.id, notePath, savedReport);
    return { status: "blocked", reason };
  }
  await ensureDir(runDir);
  const stale = await clearStaleMerge(worktree);
  if (stale.status === "blocked") return blocked(context, ticket, notePath, stale.reason);
  context.log.emit("merge_start", ticket.id, stale.note ? { note: stale.note } : undefined);
  // A coordinator in another process reads integration records from disk. Make
  // the in-flight record durable before git can expose a landed branch, or its
  // sweep can mistake this integration for a hand-merge and narrate it twice.
  await context.log.flush();

  // Human may have merged by hand (on-approval mode) — never double-merge a
  // clean branch. Dirty work advances the branch when checkpointed, so it must
  // fall through and land through the normal merge path instead of being lost.
  const alreadyMerged = await resolveAlreadyMergedBranch(
    context,
    ticket,
    worktree,
    notePath,
    target,
  );
  if (alreadyMerged.status === "complete") return alreadyMerged.outcome;
  let { leftoverNote } = alreadyMerged;

  // Both parents of the landing commit, read before the merge moves either.
  const signedOffCommit = await revParse(context.repoRoot, worktree.branch);
  const targetHead = await revParse(context.repoRoot, target);

  // 1. Merge the target into the branch, in the worktree.
  const merge = await mergeTargetIntoBranch(worktree.path, target);
  let resolutionNote = "";
  if (!merge.ok) {
    if (!merge.hasConflict) {
      const reason = `merging ${target} into ${worktree.branch} failed: ${merge.output}`;
      return blocked(context, ticket, notePath, reason);
    }
    // 2–4. Conflicts — agent resolution, gate, and re-QA if it got complicated.
    const resolution = await resolveConflictedMerge(context, ticket, worktree, notePath, runDir);
    if (resolution.status === "blocked")
      return blocked(context, ticket, notePath, resolution.reason);
    resolutionNote = resolution.notes;
  } else {
    // Clean merge still reruns the gate pre-land.
    const gate = await runGate(
      context.config.gate,
      worktree.path,
      await nextIntegrationGateLogPath(runDir, "clean-merge"),
    );
    context.log.emit("gate_result", ticket.id, { ok: gate.ok });
    if (!gate.ok) {
      return blocked(
        context,
        ticket,
        notePath,
        `gate failed after merging ${target} into ${worktree.branch}:\n\n${formatGateFailure(gate)}`,
      );
    }
  }

  // 5. Land it: the tree the gate just ran against, under a merge commit that
  //    keeps the target's line first and the signed-off commit reachable.
  let landingCommit = "";
  try {
    const latestLeftoverNote = await captureLeftovers(context, ticket, worktree);
    if (latestLeftoverNote) leftoverNote = latestLeftoverNote;
    landingCommit = await commitMerge(
      worktree.path,
      { firstParent: targetHead, secondParent: signedOffCommit },
      mergeCommitMessage(ticket, worktree.branch, target),
    );
    await fastForward(context.repoRoot, target, landingCommit);
  } catch (error) {
    return blocked(context, ticket, notePath, `merge failed: ${(error as Error).message}`);
  }
  context.log.emit("merged", ticket.id);
  await recordMergedTransition(
    context,
    ticket,
    notePath,
    {
      target,
      landingCommit,
      leftoverNote,
      resolutionNote,
    },
    savedReport,
  );
  context.usage.finish(ticket.id);
  await cleanup(context, worktree);
  await deleteBranch(context.repoRoot, worktree.branch);
  return { status: "merged" };
}

/**
 * The whole run's cost/time table for the merged comment: the pipeline's stages
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
  await recordTransition(notePath, "integration", INTEGRATION_ROUND, mergedNarration.join("\n"));
}

async function cleanup(context: PipelineContext, worktree: Worktree): Promise<void> {
  await removeWorktree(context.repoRoot, worktree.path, { shouldForce: true });
}

async function blocked(
  context: PipelineContext,
  ticket: Ticket,
  notePath: string,
  reason: string,
): Promise<IntegrateOutcome> {
  await recordTransition(
    notePath,
    "integration",
    INTEGRATION_ROUND,
    `${statusLine("integration", "blocked", BLOCKED_ROUTING)}\n\n${reason}`,
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
