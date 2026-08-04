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
  ticketBranch,
  type Worktree,
} from "./git.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import {
  runHeldSession,
  runQaStage,
  runsDir,
  stageSelectionFields,
  worktreesDir,
} from "./pipeline.js";
import { formatGateCommands, loadPrompt, renderPrompt } from "./prompts.js";
import { appendToSection, quoteAgentText } from "./ticket-note.js";
import { ensureTicketNote, type Ticket } from "./tickets.js";
import { todayIsoDate } from "./util/dates.js";
import { ensureDir, fileExists } from "./util/fsx.js";
import { type IntegrationVerdict, readIntegrationVerdict } from "./verdicts.js";

/** Git output quoted into a blocked reason when the merge fails outright. */
const MAX_MERGE_ERROR_CHARS = 500;

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
    report?.summary
      ? `**Summary:**\n${quoteAgentText(report.summary)}`
      : "**Summary:** (none recorded)",
    "",
    `**Rounds:** ${report?.rounds ?? "?"} · **Branch:** \`${ticketBranch(ticket.id)}\``,
  ];
  if (report?.testsAdded)
    lines.push("", `**QA tests added:**\n${quoteAgentText(report.testsAdded)}`);
  if (report && report.decisions.length > 0)
    lines.push(
      "",
      "**Decisions made autonomously:**",
      ...report.decisions.flatMap((decision) => ["", quoteAgentText(decision)]),
    );
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
  context.log.emit("stage_start", ticket.id, {
    stage,
    ...stageSelectionFields(context.config, stage),
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
      "The target branch was just merged in with conflict resolutions; the pipeline re-runs the full mechanical gate after your session — do not run it yourself.",
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
 * A conflicted merge, from conflict to landable tree: the Integration agent
 * resolves in the worktree, the gate reruns on the result, and a complicated
 * resolution goes back through QA before it is allowed near the target.
 */
async function resolveConflictedMerge(
  context: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  notePath: string,
): Promise<ConflictOutcome> {
  const runDir = path.join(runsDir(context.stateDir, ticket.id), "integration");
  await ensureDir(runDir);
  const verdict = await runIntegrationAgent(context, ticket, worktree, runDir);
  if (await isMergeInProgress(worktree.path))
    return {
      status: "blocked",
      reason: "integration agent left the merge unfinished — resolve manually in the worktree",
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
 * again with a baffling reason. Abort first: a conflicted merge has committed
 * nothing and left the branch ref alone, so this restores the pre-merge state
 * losslessly. A worktree that is gone has no merge to abort; the merge itself
 * reports its absence as a blocked integration. An abort git refuses is fatal
 * to this integration — everything after it would run over conflict markers.
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
  report: RunReport | null,
): Promise<IntegrateOutcome> {
  const target = context.config.integration.target_branch;
  const notePath = await ensureTicketNote(
    ticket,
    path.join(context.repoRoot, context.config.ticketsDir),
  );
  const stale = await clearStaleMerge(worktree);
  if (stale.status === "blocked") return blocked(context, ticket, notePath, stale.reason);
  context.log.emit("merge_start", ticket.id, stale.note ? { note: stale.note } : undefined);

  // Human may have merged by hand (on-approval mode) — never double-merge.
  if (await isAncestor(context.repoRoot, worktree.branch, target)) {
    context.log.emit("merged", ticket.id, { note: "already contained in target" });
    await appendReport(notePath, ticket, report, `Branch already merged into \`${target}\`.`);
    await cleanup(context, worktree);
    return { status: "already-merged" };
  }

  // Both parents of the landing commit, read before the merge moves either.
  const signedOffCommit = await revParse(context.repoRoot, worktree.branch);
  const targetHead = await revParse(context.repoRoot, target);

  // 1. Merge the target into the branch, in the worktree.
  const merge = await mergeTargetIntoBranch(worktree.path, target);
  let resolutionNote = "";
  if (!merge.ok) {
    if (!merge.hasConflict) {
      const reason = `merging ${target} into ${worktree.branch} failed: ${merge.output.slice(0, MAX_MERGE_ERROR_CHARS)}`;
      return blocked(context, ticket, notePath, reason);
    }
    // 2–4. Conflicts — agent resolution, gate, and re-QA if it got complicated.
    const resolution = await resolveConflictedMerge(context, ticket, worktree, notePath);
    if (resolution.status === "blocked")
      return blocked(context, ticket, notePath, resolution.reason);
    resolutionNote = resolution.notes;
  } else {
    // Clean merge still reruns the gate pre-land.
    const gate = await runGate(context.config.gate, worktree.path);
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
  let leftoverNote = "";
  try {
    leftoverNote = await captureLeftovers(context, ticket, worktree);
    const landing = await commitMerge(
      worktree.path,
      { firstParent: targetHead, secondParent: signedOffCommit },
      mergeCommitMessage(ticket, worktree.branch, target),
    );
    await fastForward(context.repoRoot, target, landing);
  } catch (error) {
    return blocked(context, ticket, notePath, `merge failed: ${(error as Error).message}`);
  }
  context.log.emit("merged", ticket.id);
  // The resolution notes come from the Integration agent's verdict — quoted,
  // like every other piece of agent text a note carries.
  await appendReport(
    notePath,
    ticket,
    report,
    `Merged into \`${target}\`.${leftoverNote}${resolutionNote ? `\n\nConflict resolution:\n${quoteAgentText(resolutionNote)}` : ""}`,
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
      quoteAgentText(reason),
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
