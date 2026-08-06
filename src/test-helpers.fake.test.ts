import { describe, expect, it } from "vitest";
import { FakeHarness } from "./test-helpers.js";

describe("FakeHarness", () => {
  it("passes a bare prompt to its handler without fabricating process data", async () => {
    const harness = new FakeHarness(async (prompt) => ({ ok: true, text: prompt }));

    const result = await harness.spawn("do the work", { cwd: "/worktree" }).done;

    expect(harness.calls).toEqual([{ prompt: "do the work", options: { cwd: "/worktree" } }]);
    expect(result).toEqual({ ok: true, text: "do the work" });
  });
});
