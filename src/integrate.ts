import * as path from "node:path";
import type { StageName } from "./events.js";
import { formatGateFailure, runGate } from "./gate.js";
import {
  deleteBranch,
  fastForward,
  isAncestor,
  rebaseInProgress,
  rebaseOnto,
  removeWorktree,
  ticketBranch,
  type Worktree,
} from "./git.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runQaStage, runsDir, worktreesDir } from "./pipeline.js";
import { formatGateCommands, loadPrompt, renderPrompt } from "./prompts.js";
import { appendToSection, ensureTicketNote, type Ticket } from "./tickets.js";
import { ensureDir } from "./util/fsx.js";
import { readIntegrationVerdict } from "./verdicts.js";

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
    `### ${new Date().toISOString().slice(0, 10)}`,
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

/**
 * Integrate one finished ticket: rebase onto the target branch, resolve
 * conflicts via the Integration agent, rerun the gate, judge complicated
 * merges back through QA, then fast-forward the target. The caller is
 * responsible for serialization — exactly one integration runs at a time.
 */
export async function integrateTicket(
  ctx: PipelineContext,
  ticket: Ticket,
  worktree: Worktree,
  report: RunReport | null,
): Promise<IntegrateOutcome> {
  const target = ctx.config.integration.target_branch;
  const notePath = await ensureTicketNote(ticket, path.join(ctx.repoRoot, ctx.config.ticketsDir));
  ctx.log.emit("merge_start", ticket.id);

  // Human may have merged by hand (on-approval mode) — never double-merge.
  if (await isAncestor(ctx.repoRoot, worktree.branch, target)) {
    ctx.log.emit("merged", ticket.id, { note: "already contained in target" });
    await appendReport(notePath, ticket, report, `Branch already merged into \`${target}\`.`);
    await cleanup(ctx, worktree);
    return { status: "already-merged" };
  }

  // 1. Rebase onto the target.
  const rebase = await rebaseOnto(worktree.path, target);
  let resolutionNote = "";
  if (!rebase.ok) {
    if (!rebase.conflict) {
      const reason = `rebase onto ${target} failed: ${rebase.output.slice(0, 500)}`;
      return blocked(ctx, ticket, notePath, reason);
    }
    // 2. Conflicts — the Integration agent resolves them in the worktree.
    const runDir = path.join(runsDir(ctx.stateDir, ticket.id), "integration");
    await ensureDir(runDir);
    const verdictPath = path.join(runDir, "integration.verdict.json");
    const template = await loadPrompt(ctx.jfdiDir, "integration");
    const prompt = renderPrompt(template, {
      TICKET_ID: ticket.id,
      SPEC: ticket.spec,
      BRANCH: worktree.branch,
      TARGET_BRANCH: target,
      GATE_COMMANDS: formatGateCommands(ctx.config.gate),
      VERDICT_PATH: verdictPath,
    });
    const stage: StageName = "integration";
    ctx.log.emit("stage_start", ticket.id, { stage });
    const session = ctx.harness.spawn(
      { prompt },
      { cwd: worktree.path, logPath: path.join(runDir, "integration.log.jsonl") },
    );
    for await (const evt of session.events) {
      if (evt.type === "tool")
        ctx.log.emit("session_activity", ticket.id, { text: `integration: ${evt.name}` });
    }
    const result = await session.done;
    const verdict = await readIntegrationVerdict(verdictPath);
    ctx.log.emit("stage_end", ticket.id, {
      stage,
      verdict: verdict?.resolution ?? (result.ok ? "invalid-verdict" : "session-failed"),
    });
    if (await rebaseInProgress(worktree.path)) {
      return blocked(
        ctx,
        ticket,
        notePath,
        "integration agent left the rebase unfinished — resolve manually in the worktree",
      );
    }
    if (!verdict) {
      return blocked(ctx, ticket, notePath, "integration agent produced no valid verdict");
    }
    resolutionNote = verdict.notes ?? "";

    // 3. Rerun the gate on the rebased result.
    const gate1 = await runGate(ctx.config.gate, worktree.path);
    ctx.log.emit("gate_result", ticket.id, { ok: gate1.ok });
    if (!gate1.ok) {
      return blocked(
        ctx,
        ticket,
        notePath,
        `gate failed after conflict resolution:\n\n${formatGateFailure(gate1)}`,
      );
    }

    // 4. Complicated merge → the card goes back through QA before landing.
    if (verdict.resolution === "complicated") {
      ctx.log.emit("complicated_merge", ticket.id, { notes: resolutionNote });
      const qaDir = path.join(runDir, "requalify");
      await ensureDir(qaDir);
      const qa = await runQaStage(ctx, ticket, worktree, qaDir, notePath, 0);
      if (qa.verdict?.verdict !== "pass") {
        return blocked(
          ctx,
          ticket,
          notePath,
          `post-merge QA did not pass: ${qa.verdict?.feedback ?? qa.verdict?.question ?? "no valid verdict"}`,
        );
      }
      const gate2 = await runGate(ctx.config.gate, worktree.path);
      if (!gate2.ok)
        return blocked(
          ctx,
          ticket,
          notePath,
          `gate failed after re-QA:\n\n${formatGateFailure(gate2)}`,
        );
    }
  } else {
    // Clean rebase still reruns the gate pre-merge.
    const gate = await runGate(ctx.config.gate, worktree.path);
    ctx.log.emit("gate_result", ticket.id, { ok: gate.ok });
    if (!gate.ok) {
      return blocked(
        ctx,
        ticket,
        notePath,
        `gate failed after rebase onto ${target}:\n\n${formatGateFailure(gate)}`,
      );
    }
  }

  // 5. Land it.
  try {
    await fastForward(ctx.repoRoot, target, worktree.branch);
  } catch (err) {
    return blocked(ctx, ticket, notePath, `merge failed: ${(err as Error).message}`);
  }
  ctx.log.emit("merged", ticket.id);
  await appendReport(
    notePath,
    ticket,
    report,
    `Merged into \`${target}\`.${resolutionNote ? ` Conflict resolution: ${resolutionNote}` : ""}`,
  );
  await cleanup(ctx, worktree);
  await deleteBranch(ctx.repoRoot, worktree.branch);
  return { status: "merged" };
}

async function cleanup(ctx: PipelineContext, worktree: Worktree): Promise<void> {
  await removeWorktree(ctx.repoRoot, worktree.path, { force: true });
}

async function blocked(
  ctx: PipelineContext,
  ticket: Ticket,
  notePath: string,
  reason: string,
): Promise<IntegrateOutcome> {
  await appendToSection(
    notePath,
    "Questions",
    [
      `### ${new Date().toISOString().slice(0, 10)} — integration`,
      "",
      reason,
      "",
      `_The worktree is kept for inspection under \`.jfdi/worktrees/\`. Fix, then move the card back to "${ctx.config.board.columns.begin}"._`,
    ].join("\n"),
  );
  ctx.log.emit("blocked", ticket.id, { reason: reason.split("\n")[0] });
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
