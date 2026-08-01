import * as path from "node:path";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runsDir } from "./pipeline.js";
import { appendToSection } from "./tickets.js";
import { atomicWrite, readIfExists } from "./util/fsx.js";

/** Persist the pipeline report so a later `jfdi merge` / restart can pick it up. */
export async function saveReport(
  jfdiDir: string,
  ticketId: string,
  report: RunReport,
): Promise<void> {
  await atomicWrite(
    path.join(runsDir(jfdiDir, ticketId), "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

export async function loadReport(jfdiDir: string, ticketId: string): Promise<RunReport | null> {
  const content = await readIfExists(path.join(runsDir(jfdiDir, ticketId), "report.json"));
  if (content === null) return null;
  try {
    return JSON.parse(content) as RunReport;
  } catch {
    return null;
  }
}

/** Append the final report to the ticket note at the merge-ready gate (on-approval). */
export async function recordMergeReady(
  ctx: PipelineContext,
  ticketId: string,
  notePath: string,
  report: RunReport,
): Promise<void> {
  await saveReport(ctx.jfdiDir, ticketId, report);
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
