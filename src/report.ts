import * as path from "node:path";
import { addCardIfAbsent } from "./board.js";
import type { PipelineContext, RunReport } from "./pipeline.js";
import { runsDir } from "./pipeline.js";
import { recordTransition, shortSha } from "./transitions.js";
import { renderUsageTable, usageTotals } from "./usage.js";
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
 * anything there. Invalid JSON or a missing core field is returned as explicit
 * corruption so every caller can block without destroying the evidence. The
 * cost/time fields are checked leniently: a report written before this feature
 * has none, and a merge should still proceed reading them as "no table" rather
 * than refusing.
 */
function reportShapeError(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return "invalid report shape: expected a JSON object";
  const record = parsed as Record<string, unknown>;
  const expectedFields: Array<[string, "string" | "number" | "array"]> = [
    ["summary", "string"],
    ["decisions", "array"],
    ["observations", "array"],
    ["testsAdded", "string"],
    ["rounds", "number"],
    ["commit", "string"],
  ];
  for (const [field, expected] of expectedFields) {
    const value = record[field];
    const isExpected = expected === "array" ? Array.isArray(value) : typeof value === expected;
    if (!isExpected) {
      const expectedDescription = expected === "array" ? "an array" : `a ${expected}`;
      return `invalid report shape: expected ${field} to be ${expectedDescription}`;
    }
  }
  return null;
}

export interface CorruptReport {
  kind: "corrupt";
  path: string;
  error: string;
}

export function isCorruptReport(report: RunReport | CorruptReport): report is CorruptReport {
  return "kind" in report && report.kind === "corrupt";
}

export async function loadReport(
  stateDir: string,
  ticketId: string,
): Promise<RunReport | CorruptReport | null> {
  const reportPath = path.join(runsDir(stateDir, ticketId), "report.json");
  const content = await readIfExists(reportPath);
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      kind: "corrupt",
      path: reportPath,
      error: `could not parse JSON: ${(error as Error).message}`,
    };
  }
  const shapeError = reportShapeError(parsed);
  if (shapeError !== null) return { kind: "corrupt", path: reportPath, error: shapeError };
  const record = parsed as Record<string, unknown>;
  // Backfill the cost/time fields so an older report loads as one without a table.
  return {
    ...(record as unknown as RunReport),
    usageRows: Array.isArray(record.usageRows) ? (record.usageRows as RunReport["usageRows"]) : [],
    elapsedMs: typeof record.elapsedMs === "number" ? record.elapsedMs : 0,
  };
}

/** The one unblock recipe every entry point gives for JFDI-owned report corruption. */
export function corruptReportMessage(ticketId: string, report: CorruptReport): string {
  return [
    `Run report \`${report.path}\` is corrupt: ${report.error}.`,
    `To unblock, fix or restore \`runs/${ticketId}/report.json\` to keep the existing pass intact, or delete the file to deliberately request a full re-run.`,
  ].join("\n\n");
}

/** Record report corruption without touching the report itself. */
export async function recordCorruptReport(
  context: PipelineContext,
  ticketId: string,
  notePath: string,
  report: CorruptReport,
): Promise<string> {
  const message = corruptReportMessage(ticketId, report);
  await recordTransition(notePath, "report", 0, message);
  context.log.emit("blocked", ticketId, { reason: message.split("\n")[0] });
  return message;
}

/**
 * Materialize stage observations as cards in the board's inbox column — agents
 * propose, humans promote. Stage agents never touch the board themselves; this
 * runs coordinator-side through the same atomic-write path as card moves.
 * Duplicate proposals (retries, re-dispatches) are dropped by addCardIfAbsent.
 * Returns false only when non-empty observations have no board to receive them.
 */
export async function recordObservations(
  context: PipelineContext,
  ticketId: string,
  observations: string[],
): Promise<boolean> {
  if (observations.length === 0) return true;
  const boardPath = path.join(context.repoRoot, context.config.board.path);
  if (!(await fileExists(boardPath))) return false;
  for (const observation of observations) {
    const added = await addCardIfAbsent(
      boardPath,
      context.config.board.columns.inbox,
      `${observation} *(from ${ticketId})*`,
    );
    if (added) context.log.emit("observation", ticketId, { text: observation });
  }
  return true;
}

/**
 * Record merge-readiness (on-approval): persist the run report for a later
 * `jfdi merge`, then close the note's `## Comments` trail with the
 * ready-to-merge entry a human approves from. The saved `report.json` — not
 * this comment — is what the coordinator and `jfdi merge` consult; the comment
 * is only the human-readable half. Autonomous decisions are already decision
 * entries in the trail, so they are not repeated here.
 */
export async function recordMergeReady(
  context: PipelineContext,
  ticketId: string,
  notePath: string,
  report: RunReport,
): Promise<void> {
  await saveReport(context.stateDir, ticketId, report);
  const lines = [
    "Run passed all stages — ready to merge.",
    "",
    report.summary ? `**Summary:**\n${report.summary}` : "**Summary:** (none recorded)",
    "",
    `**Rounds:** ${report.rounds} · **Commit:** \`${shortSha(report.commit)}\``,
  ];
  // The whole run's cost and time — the integration row is still to come, so
  // this table's elapsed runs to merge-ready only.
  if (report.usageRows.length > 0)
    lines.push("", renderUsageTable(report.usageRows, report.elapsedMs));
  if (report.testsAdded) lines.push("", `**QA tests added:**\n${report.testsAdded}`);
  lines.push("", `_Approve with \`jfdi merge ${ticketId}\`, or merge the branch by hand._`);
  await recordTransition(notePath, "pipeline", report.rounds, lines.join("\n"));
  // Carry the complete run total so the status/TUI snapshot lands the final
  // figure — including this run's last scribe, which ran after the last stage_end.
  const totals = usageTotals(report.usageRows);
  context.log.emit("merge_ready", ticketId, {
    runAgentMs: totals.durationMs,
    runCostUsd: totals.costUsd,
    runTokens: totals.totalTokens,
  });
}
