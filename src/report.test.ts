import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fixture } from "./test-helpers.js";
import { makeFixture } from "./test-helpers.js";
import { loadReport } from "./report.js";

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
});
