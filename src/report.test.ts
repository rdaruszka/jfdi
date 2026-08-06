import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReport } from "./report.js";
import type { Fixture } from "./test-helpers.js";
import { makeFixture } from "./test-helpers.js";

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("loadReport", () => {
  it("distinguishes a corrupt report from an absent report and preserves the parse error", async () => {
    const ticketId = "corrupt-report";
    const reportPath = path.join(fixture.stateDir, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, '{"summary":');

    const corrupt = await loadReport(fixture.stateDir, ticketId);
    expect(corrupt).toMatchObject({ kind: "corrupt", path: reportPath });
    expect(corrupt && "error" in corrupt ? corrupt.error : "").toContain("JSON");

    await fs.rm(reportPath);
    expect(await loadReport(fixture.stateDir, ticketId)).toBeNull();
  });

  it("reports which required field makes a parsed report corrupt", async () => {
    const ticketId = "invalid-report";
    const reportPath = path.join(fixture.stateDir, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ summary: "unfinished" }));

    const corrupt = await loadReport(fixture.stateDir, ticketId);
    expect(corrupt).toMatchObject({ kind: "corrupt", path: reportPath });
    expect(corrupt && "error" in corrupt ? corrupt.error : "").toContain("decisions");
  });

  it("backfills model data when loading a report written before model reporting", async () => {
    const ticketId = "old-report";
    const reportPath = path.join(fixture.stateDir, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        summary: "done",
        decisions: [],
        observations: [],
        testsAdded: "none",
        rounds: 1,
        commit: "abc123",
        usageRows: [
          {
            label: "Implementation",
            sessions: 1,
            durationMs: 1,
            knownCostUsd: 1,
            unknownCostSessions: 0,
            estimatedCostSessions: 0,
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
          },
        ],
        elapsedMs: 1,
      }),
    );

    const report = await loadReport(fixture.stateDir, ticketId);
    expect(report && !("kind" in report) ? report.usageRows[0]?.models : null).toEqual([]);
  });
});
