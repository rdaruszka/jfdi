import * as path from "node:path";
import type { StageName } from "./events.js";
import { formatGateFailure, runGate } from "./gate.js";
import {
  abortRebase,
  deleteBranch,
  fastForward,
  isAncestor,
  isRebaseInProgress,
  rebaseOnto,
  removeWorktree,
  ticketBranch,
  type Worktree,
} from "./git.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runHeldSession, runQaStage, runsDir, worktreesDir } from "./pipeline.js";
import { formatGateCommands, loadPrompt, renderPrompt } from "./prompts.js";
import { appendToSection, ensureTicketNote, type Ticket } from "./tickets.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDir, fileExists } from "./util/fsx.js";
import { type IntegrationVerdict, readIntegrationVerdict } from "./verdicts.js";

/** Git output quoted into a blocked reason when a rebase fails outright. */
const MAX_REBASE_ERROR_CHARS = 500;

export type IntegrateOutcome =
  | { status: "merged" }
  | { status: "already-merged" }
  | { status: "blocked"; reason: string };

async function appendReport(
  notePath: string,
  ticket: Ticket,
  report: RunReport | null,
  mergeNote: string,
): Promise<void> {
  const lines = [
    `### ${todayIsoDate()}`,
    "",
    report?.summary ? `**Summary:** ${report.summary}` : "**Summary:** (none recorded)",
    "",
    `**Rounds:** ${report?.rounds ?? "?"} · **Branch:** \`${ticketBranch(ticket.id)}\``,
  ];
  if (report?.testsAdded) lines.push("", `**QA tests added:** ${report.testsAdded}`);
  if (report && report.decisions.length > 0)
    lines.push("", "**Decisions made autonomously:**", ...report.decisions.map((d) => `- ${d}`));
  lines.push("", mergeNote);
  await appendToSection(notePath, "Report", lines.join("\n"));
}

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
  const verdictPath = path.join(runDir, "integration.verdict.json");
  const template = await loadPrompt(context.jfdiDir, "integration");
  const prompt = renderPrompt(template, {
    TICKET_ID: ticket.id,
    SPEC: ticket.spec,
    BRANCH: worktree.branch,
    TARGET_BRANCH: context.config.integration.target_branch,
    GATE_COMMANDS: formatGateCommands(context.config.gate),
    VERDICT_PATH: verdictPath,
  });
  const stage: StageName = "integration";
  context.log.emit("stage_start", ticket.id, { stage });
  const result = await runHeldSession(
    context,
    ticket.id,
    { prompt },
    { cwd: worktree.path, logPath: path.join(runDir, "integration.log.jsonl") },
    (event) => {
      if (event.type === "tool")
        context.log.emit("session_activity", ticket.id, { text: `integration: ${event.name}` });
    },
  );
  const verdict = await readIntegrationVerdict(verdictPath);
  context.log.emit("stage_end", ticket.id, {
    stage,
    verdict: verdict?.resolution ?? (result.ok ? "invalid-verdict" : "session-failed"),
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
      "The branch was just rebased with conflict resolutions; the pipeline re-runs the full mechanical gate after your session — do not run it yourself.",
  });
  if (qa.verdict?.verdict !== "pass") {
    const detail = qa.verdict?.feedback ?? qa.verdict?.question ?? "no valid verdict";
    return { status: "blocked", reason: `post-merge QA did not pass: ${detail}` };
  }
  const gate = await runGate(context.config.gate, worktree.path);
  if (!gate.ok)
    return { status: "blocked", reason: `gate failed after re-QA:\n\n${formatGateFailure(gate)}` };
  return { status: "resolved", notes };
}

/**
 * A conflicted rebase, from conflict to landable branch: the Integration agent
 * resolves in the worktree, the gate reruns on the result, and a complicated
 * resolution goes back through QA before it is allowed near the target.
 */
async function resolveConflictedRebase(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  notePath: string,
): Promise<ConflictOutcome> {
  const runDir = path.join(runsDir(context.stateDir, ticket.id), "integration");
  await ensureDir(runDir);
  const verdict = await runIntegrationAgent(context, ticket, worktree, runDir);
  if (await isRebaseInProgress(worktree.path))
    return {
      status: "blocked",
      reason: "integration agent left the rebase unfinished — resolve manually in the worktree",
    };
  if (!verdict) return { status: "blocked", reason: "integration agent produced no valid verdict" };
  const notes = verdict.notes ?? "";

  const gate = await runGate(context.config.gate, worktree.path);
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
 * Integrate one finished ticket: rebase onto the target branch, resolve
 * conflicts via the Integration agent, rerun the gate, judge complicated
 * merges back through QA, then fast-forward the target. The caller is
 * responsible for serialization — exactly one integration runs at a time.
 */
export async function integrateTicket(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  report: RunReport | null,
): Promise<IntegrateOutcome> {
  const target = context.config.integration.target_branch;
  const notePath = await ensureTicketNote(
    ticket,
    path.join(context.repoRoot, context.config.ticketsDir),
  );
  // A previous integration can leave the worktree mid-rebase (the agent gave
  // up half-resolved and we blocked). Re-entering there makes git refuse with
  // "rebase already in progress" — which is not a conflict, so it would block
  // again with a baffling reason. Abort first: a mid-rebase worktree has a
  // detached HEAD and an untouched branch ref, so this restores the
  // pre-rebase state losslessly. A worktree that is gone has no rebase to
  // abort; the rebase below reports its absence as a blocked integration.
  const hadStaleRebase =
    (await fileExists(worktree.path)) && (await isRebaseInProgress(worktree.path));
  if (hadStaleRebase) await abortRebase(worktree.path);
  context.log.emit(
    "merge_start",
    ticket.id,
    hadStaleRebase ? { note: "aborted a stale rebase left in the worktree" } : undefined,
  );

  // Human may have merged by hand (on-approval mode) — never double-merge.
  if (await isAncestor(context.repoRoot, worktree.branch, target)) {
    context.log.emit("merged", ticket.id, { note: "already contained in target" });
    await appendReport(notePath, ticket, report, `Branch already merged into \`${target}\`.`);
    await cleanup(context, worktree);
    return { status: "already-merged" };
  }

  // 1. Rebase onto the target.
  const rebase = await rebaseOnto(worktree.path, target);
  let resolutionNote = "";
  if (!rebase.ok) {
    if (!rebase.hasConflict) {
      const reason = `rebase onto ${target} failed: ${rebase.output.slice(0, MAX_REBASE_ERROR_CHARS)}`;
      return blocked(context, ticket, notePath, reason);
    }
    // 2–4. Conflicts — agent resolution, gate, and re-QA if it got complicated.
    const resolution = await resolveConflictedRebase(context, ticket, worktree, notePath);
    if (resolution.status === "blocked")
      return blocked(context, ticket, notePath, resolution.reason);
    resolutionNote = resolution.notes;
  } else {
    // Clean rebase still reruns the gate pre-merge.
    const gate = await runGate(context.config.gate, worktree.path);
    context.log.emit("gate_result", ticket.id, { ok: gate.ok });
    if (!gate.ok) {
      return blocked(
        context,
        ticket,
        notePath,
        `gate failed after rebase onto ${target}:\n\n${formatGateFailure(gate)}`,
      );
    }
  }

  // 5. Land it.
  try {
    await fastForward(context.repoRoot, target, worktree.branch);
  } catch (error) {
    return blocked(context, ticket, notePath, `merge failed: ${(error as Error).message}`);
  }
  context.log.emit("merged", ticket.id);
  await appendReport(
    notePath,
    ticket,
    report,
    `Merged into \`${target}\`.${resolutionNote ? ` Conflict resolution: ${resolutionNote}` : ""}`,
  );
  await cleanup(context, worktree);
  await deleteBranch(context.repoRoot, worktree.branch);
  return { status: "merged" };
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
  await appendToSection(
    notePath,
    "Questions",
    [
      `### ${todayIsoDate()} — integration`,
      "",
      reason,
      "",
      `_The worktree is kept for inspection under \`.jfdi/worktrees/\`. Fix, then move the card back to "${context.config.board.columns.begin}"._`,
    ].join("\n"),
  );
  context.log.emit("blocked", ticket.id, { reason: reason.split("\n")[0] });
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

export { worktreesDir };
