import { describe, expect, it } from "vitest";
import * as board from "./board.js";
import * as git from "./git.js";
import * as harnessModule from "./harness/index.js";
import * as integrate from "./integrate.js";
import * as pipeline from "./pipeline.js";
import { FakeHarness } from "./test-helpers.js";
import * as tickets from "./tickets.js";
import * as usage from "./usage.js";

/**
 * Regression guard for the dead-exports sweep: each name below had zero
 * production callers and was deleted. These assertions fail if any is
 * reintroduced onto its module's public surface — the mechanical form of the
 * ticket's "zero references to any deleted name remain" criterion, checked
 * against the compiled modules rather than by grep. Each case also pins the
 * live alternative the deletion relied on, so the guard documents *why* the
 * removal was safe.
 */
describe("dead-exports sweep stays swept", () => {
  const surface = (module: object): Record<string, unknown> => module as Record<string, unknown>;

  it("board.findCard is gone; parseBoard/findColumn remain the live surface", () => {
    expect(surface(board).findCard).toBeUndefined();
    // cards.ts owns production card lookup via findTicketCard; board keeps only
    // its parsing/column helpers.
    expect(typeof board.parseBoard).toBe("function");
    expect(typeof board.findColumn).toBe("function");
  });

  it("git.branchDiff is gone (stage-context issues its own git diff)", () => {
    expect(surface(git).branchDiff).toBeUndefined();
  });

  it("tickets.ensureTicketsDir is gone (scaffold uses ensureDir directly)", () => {
    expect(Reflect.get(surface(tickets), "ensureTicketsDir")).toBeUndefined();
    expect(typeof tickets.ensureTicketNote).toBe("function");
  });

  it("usage.usageRowFor is gone (the mapping runs through UsageLedger.add)", () => {
    expect(surface(usage).usageRowFor).toBeUndefined();
  });

  it("worktreesDirectory is exported by pipeline, not re-exported by integrate", () => {
    // The mid-branch build failure was a leftover integrate re-export; every
    // caller (coordinator, commands/merge) imports it from pipeline.
    expect(typeof pipeline.worktreesDirectory).toBe("function");
    expect(surface(integrate).worktreesDirectory).toBeUndefined();
  });

  it("the Harness interface no longer carries a name field", () => {
    const harness = new FakeHarness(async () => ({ ok: true, text: "" }));
    expect(surface(harness).name).toBeUndefined();
    // The interface members that survive still exist.
    expect(typeof harness.spawn).toBe("function");
    expect(typeof harness.spawnInteractive).toBe("function");
  });

  it("the production harness surface does not export its test double", () => {
    expect(surface(harnessModule).FakeHarness).toBeUndefined();
  });
});
