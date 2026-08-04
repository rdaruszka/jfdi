import * as path from "node:path";
import { addCardIfAbsent } from "./board.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runsDir } from "./pipeline.js";
import { appendToSection, quoteAgentText } from "./ticket-note.js";
import { todayIsoDate } from "./util/dates.js";
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

/**
 * report.json is our own file, but a crashed write or a hand edit can leave
 * anything there — and callers dereference `decisions`/`observations` without
 * guarding. Check the shape before handing it over.
 */
function isRunReport(value: unknown): value is RunReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === "string" &&
    Array.isArray(record.decisions) &&
    Array.isArray(record.observations) &&
    typeof record.testsAdded === "string" &&
    typeof record.rounds === "number" &&
    typeof record.commit === "string"
  );
}

export async function loadReport(stateDir: string, ticketId: string): Promise<RunReport | null> {
  const content = await readIfExists(path.join(runsDir(stateDir, ticketId), "report.json"));
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A truncated or hand-mangled report is treated as absent: the caller
    // re-runs the pipeline rather than merging on a half-read record.
    return null;
  }
  return isRunReport(parsed) ? parsed : null;
}

/**
 * Materialize stage observations as cards in the board's inbox column — agents
 * propose, humans promote. Stage agents never touch the board themselves; this
 * runs coordinator-side through the same atomic-write path as card moves.
 * Duplicate proposals (retries, re-dispatches) are dropped by addCardIfAbsent.
 */
export async function recordObservations(
  context: PipelineContext,
  ticketId: string,
  observations: string[],
): Promise<void> {
  if (observations.length === 0) return;
  const boardPath = path.join(context.repoRoot, context.config.board.path);
  if (!(await fileExists(boardPath))) return;
  for (const observation of observations) {
    const added = await addCardIfAbsent(
      boardPath,
      context.config.board.columns.inbox,
      `${observation} *(from ${ticketId})*`,
    );
    if (added) context.log.emit("observation", ticketId, { text: observation });
  }
}

/** Append the final report to the ticket note at the merge-ready gate (on-approval). */
export async function recordMergeReady(
  context: PipelineContext,
  ticketId: string,
  notePath: string,
  report: RunReport,
): Promise<void> {
  await saveReport(context.stateDir, ticketId, report);
  const lines = [
    `### ${todayIsoDate()} — ready to merge`,
    "",
    report.summary
      ? `**Summary:**\n${quoteAgentText(report.summary)}`
      : "**Summary:** (none recorded)",
    "",
    `**Rounds:** ${report.rounds} · **Commit:** \`${report.commit.slice(0, 10)}\``,
  ];
  if (report.testsAdded)
    lines.push("", `**QA tests added:**\n${quoteAgentText(report.testsAdded)}`);
  if (report.decisions.length > 0)
    lines.push(
      "",
      "**Decisions made autonomously:**",
      ...report.decisions.flatMap((decision) => ["", quoteAgentText(decision)]),
    );
  lines.push("", `_Approve with \`jfdi merge ${ticketId}\`, or merge the branch by hand._`);
  await appendToSection(notePath, "Report", lines.join("\n"));
  context.log.emit("merge_ready", ticketId);
}
