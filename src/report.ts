import * as path from "node:path";
import { addCardIfAbsent } from "./board.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runsDir } from "./pipeline.js";
import { appendToSection } from "./tickets.js";
import { atomicWrite, fileExists, readIfExists } from "./util/fsx.js";

/** Persist the pipeline report so a later `jfdi merge` / restart can pick it up. */
export async function saveReport(
  stateDir: string,
  ticketId: string,
  report: RunReport,
): Promise<void> {
  await atomicWrite(
    path.join(runsDir(stateDir, ticketId), "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

export async function loadReport(stateDir: string, ticketId: string): Promise<RunReport | null> {
  const content = await readIfExists(path.join(runsDir(stateDir, ticketId), "report.json"));
  if (content === null) return null;
  try {
    return JSON.parse(content) as RunReport;
  } catch {
    return null;
  }
}

/**
 * Materialize stage observations as cards in the board's inbox column — agents
 * propose, humans promote. Stage agents never touch the board themselves; this
 * runs coordinator-side through the same atomic-write path as card moves.
 * Duplicate proposals (retries, re-dispatches) are dropped by addCardIfAbsent.
 */
export async function recordObservations(
  ctx: PipelineContext,
  ticketId: string,
  observations: string[],
): Promise<void> {
  if (observations.length === 0) return;
  const boardPath = path.join(ctx.repoRoot, ctx.config.board.path);
  if (!(await fileExists(boardPath))) return;
  for (const observation of observations) {
    const added = await addCardIfAbsent(
      boardPath,
      ctx.config.board.columns.inbox,
      `${observation} *(from ${ticketId})*`,
    );
    if (added) ctx.log.emit("observation", ticketId, { text: observation });
  }
}

/** Append the final report to the ticket note at the merge-ready gate (on-approval). */
export async function recordMergeReady(
  ctx: PipelineContext,
  ticketId: string,
  notePath: string,
  report: RunReport,
): Promise<void> {
  await saveReport(ctx.stateDir, ticketId, report);
  const lines = [
    `### ${new Date().toISOString().slice(0, 10)} — ready to merge`,
    "",
    `**Summary:** ${report.summary || "(none recorded)"}`,
    "",
    `**Rounds:** ${report.rounds} · **Commit:** \`${report.commit.slice(0, 10)}\``,
  ];
  if (report.testsAdded) lines.push("", `**QA tests added:** ${report.testsAdded}`);
  if (report.decisions.length > 0)
    lines.push("", "**Decisions made autonomously:**", ...report.decisions.map((d) => `- ${d}`));
  lines.push("", `_Approve with \`jfdi merge ${ticketId}\`, or merge the branch by hand._`);
  await appendToSection(notePath, "Report", lines.join("\n"));
  ctx.log.emit("merge_ready", ticketId);
}
