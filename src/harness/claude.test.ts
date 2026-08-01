import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHarness, mapClaudeLine } from "./claude.js";
import type { HarnessEvent } from "./types.js";

describe("mapClaudeLine", () => {
  it("maps assistant text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "working on it" }] },
    });
    expect(mapClaudeLine(line)).toEqual([{ type: "text", text: "working on it" }]);
  });

  it("maps tool_use blocks with a summarized input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      },
    });
    expect(mapClaudeLine(line)).toEqual([{ type: "tool", name: "Bash", detail: "npm test" }]);
  });

  it("maps the final result line", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", result: "all done" });
    expect(mapClaudeLine(line)).toEqual([{ type: "result", ok: true, text: "all done" }]);
  });

  it("maps error results as not ok", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "ran out",
    });
    expect(mapClaudeLine(line)).toEqual([{ type: "result", ok: false, text: "ran out" }]);
  });

  it("ignores unparseable lines", () => {
    expect(mapClaudeLine("not json")).toEqual([]);
  });
});

describe("ClaudeHarness subprocess", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-harness-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Stub `claude` executable that replays canned stream-json lines. */
  async function stubClaude(lines: object[], exitCode = 0): Promise<string> {
    const script = path.join(dir, "fake-claude");
    const body = [
      "#!/bin/sh",
      ...lines.map((l) => `echo '${JSON.stringify(l)}'`),
      `exit ${exitCode}`,
    ].join("\n");
    await fs.writeFile(script, `${body}\n`, { mode: 0o755 });
    return script;
  }

  it("streams events and resolves with the result", async () => {
    const exe = await stubClaude([
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success", result: "finished the work" },
    ]);
    const harness = new ClaudeHarness([], exe);
    const session = harness.spawn({ prompt: "do it" }, { cwd: dir });
    const seen: HarnessEvent[] = [];
    for await (const evt of session.events) seen.push(evt);
    const result = await session.done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("finished the work");
    expect(seen.some((e) => e.type === "text")).toBe(true);
  });

  it("captures raw output to the log path", async () => {
    const exe = await stubClaude([{ type: "result", subtype: "success", result: "ok" }]);
    const logPath = path.join(dir, "logs/session.jsonl");
    const harness = new ClaudeHarness([], exe);
    const session = harness.spawn({ prompt: "p" }, { cwd: dir, logPath });
    await session.done;
    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain('"result"');
  });

  it("reports failure when the process exits non-zero", async () => {
    const exe = await stubClaude([], 2);
    const harness = new ClaudeHarness([], exe);
    const session = harness.spawn({ prompt: "p" }, { cwd: dir });
    const result = await session.done;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("reports failure when the executable is missing", async () => {
    const harness = new ClaudeHarness([], path.join(dir, "does-not-exist"));
    const session = harness.spawn({ prompt: "p" }, { cwd: dir });
    const result = await session.done;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("failed to spawn");
  });
});
