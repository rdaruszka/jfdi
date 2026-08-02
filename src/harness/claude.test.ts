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

  it("maps the session id from init and result lines", () => {
    const initLine = JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" });
    expect(mapClaudeLine(initLine)).toEqual([{ type: "session", sessionId: "abc-123" }]);
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "def-456",
    });
    expect(mapClaudeLine(resultLine)).toEqual([
      { type: "session", sessionId: "def-456" },
      { type: "result", ok: true, text: "done" },
    ]);
  });
});

describe("ClaudeHarness subprocess", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-harness-")));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Stub `claude` executable that replays canned stream-json lines. */
  async function stubClaude(lines: object[], exitCode = 0): Promise<string> {
    const script = path.join(dir, "fake-claude");
    const body = [
      "#!/bin/sh",
      '[ "$1" = "-p" ] || exit 91',
      '[ "$2" = "first line\nsecond line with spaces" ] || exit 94',
      '[ "$6" = "--permission-mode" ] || exit 92',
      '[ "$7" = "bypassPermissions" ] || exit 93',
      `[ "$(pwd)" = "${dir}" ] || exit 95`,
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
    const harness = new ClaudeHarness(exe);
    const session = harness.spawn({ prompt: "first line\nsecond line with spaces" }, { cwd: dir });
    const seen: HarnessEvent[] = [];
    for await (const event of session.events) seen.push(event);
    const result = await session.done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("finished the work");
    expect(seen.some((e) => e.type === "text")).toBe(true);
  });

  it("captures raw output to the log path", async () => {
    const exe = await stubClaude([{ type: "result", subtype: "success", result: "ok" }]);
    const logPath = path.join(dir, "logs/session.jsonl");
    const harness = new ClaudeHarness(exe);
    const session = harness.spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir, logPath },
    );
    await session.done;
    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain('"result"');
  });

  it("reports failure when the process exits non-zero", async () => {
    const exe = await stubClaude([], 2);
    const harness = new ClaudeHarness(exe);
    const session = harness.spawn({ prompt: "first line\nsecond line with spaces" }, { cwd: dir });
    const result = await session.done;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("reports failure when the executable is missing", async () => {
    const harness = new ClaudeHarness(path.join(dir, "does-not-exist"));
    const session = harness.spawn({ prompt: "p" }, { cwd: dir });
    const result = await session.done;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("failed to spawn");
  });

  it("resolves with the session id so the pipeline can continue the session", async () => {
    const exe = await stubClaude([
      { type: "system", subtype: "init", session_id: "session-1" },
      { type: "result", subtype: "success", result: "ok", session_id: "session-1" },
    ]);
    const result = await new ClaudeHarness(exe).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    ).done;
    expect(result.sessionId).toBe("session-1");
  });

  it("passes --resume when continuing an earlier session", async () => {
    const script = path.join(dir, "fake-claude-resume");
    const body = [
      "#!/bin/sh",
      '[ "$8" = "--resume" ] || exit 96',
      '[ "$9" = "old-session" ] || exit 97',
      `echo '${JSON.stringify({ type: "result", subtype: "success", result: "continued" })}'`,
    ].join("\n");
    await fs.writeFile(script, `${body}\n`, { mode: 0o755 });
    const result = await new ClaudeHarness(script).spawn(
      { prompt: "go on" },
      { cwd: dir, continueSessionId: "old-session" },
    ).done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("continued");
  });

  it("passes --settings when the worktree carries .jfdi/claude-settings.json", async () => {
    const settingsPath = path.join(dir, ".jfdi", "claude-settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, "{}");
    const script = path.join(dir, "fake-claude-settings");
    const body = [
      "#!/bin/sh",
      '[ "$8" = "--settings" ] || exit 96',
      `[ "$9" = "${settingsPath}" ] || exit 97`,
      `echo '${JSON.stringify({ type: "result", subtype: "success", result: "hooked" })}'`,
    ].join("\n");
    await fs.writeFile(script, `${body}\n`, { mode: 0o755 });
    const result = await new ClaudeHarness(script).spawn({ prompt: "p" }, { cwd: dir }).done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hooked");
  });
});
