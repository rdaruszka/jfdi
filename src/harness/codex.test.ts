import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexHarness, mapCodexLine } from "./codex.js";
import type { HarnessEvent } from "./types.js";

describe("mapCodexLine", () => {
  it("maps completed agent messages", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "finished the work" },
    });
    expect(mapCodexLine(line)).toEqual([{ type: "text", text: "finished the work" }]);
  });

  it("maps command activity", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "pnpm test" },
    });
    expect(mapCodexLine(line)).toEqual([{ type: "tool", name: "command", detail: "pnpm test" }]);
  });

  it("maps failed turns", () => {
    const line = JSON.stringify({ type: "turn.failed", error: { message: "usage limit" } });
    expect(mapCodexLine(line)).toEqual([{ type: "result", ok: false, text: "usage limit" }]);
  });

  it("ignores unparseable lines", () => {
    expect(mapCodexLine("not json")).toEqual([]);
  });

  it("maps the thread id used to resume the session later", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "thread-9" });
    expect(mapCodexLine(line)).toEqual([{ type: "session", sessionId: "thread-9" }]);
  });
});

describe("CodexHarness subprocess", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-codex-harness-")));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function stubCodex(lines: object[], exitCode = 0): Promise<string> {
    const script = path.join(dir, "fake-codex");
    const body = [
      "#!/bin/sh",
      '[ "$1" = "exec" ] || exit 91',
      '[ "$2" = "--json" ] || exit 92',
      '[ "$3" = "--dangerously-bypass-approvals-and-sandbox" ] || exit 93',
      '[ "$4" = "first line\nsecond line with spaces" ] || exit 94',
      `[ "$(pwd)" = "${dir}" ] || exit 95`,
      ...lines.map((line) => `echo '${JSON.stringify(line)}'`),
      `exit ${exitCode}`,
    ].join("\n");
    await fs.writeFile(script, `${body}\n`, { mode: 0o755 });
    return script;
  }

  it("streams events and resolves with the final agent message", async () => {
    const executable = await stubCodex([
      { type: "item.started", item: { type: "command_execution", command: "pnpm test" } },
      { type: "item.completed", item: { type: "agent_message", text: "all done" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
    ]);
    const session = new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    );
    const events: HarnessEvent[] = [];
    for await (const event of session.events) events.push(event);

    await expect(session.done).resolves.toEqual({ ok: true, text: "all done", exitCode: 0 });
    expect(events).toContainEqual({ type: "tool", name: "command", detail: "pnpm test" });
    expect(events).toContainEqual({ type: "result", ok: true, text: "all done" });
  });

  it("captures raw output", async () => {
    const executable = await stubCodex([
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
    ]);
    const logPath = path.join(dir, "logs/session.jsonl");
    const session = new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir, logPath },
    );
    await session.done;
    expect(await fs.readFile(logPath, "utf8")).toContain("item.completed");
  });

  it("reports a nonzero exit", async () => {
    const executable = await stubCodex([], 2);
    const result = await new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    ).done;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("reports a missing executable", async () => {
    const result = await new CodexHarness(path.join(dir, "missing")).spawn(
      { prompt: "do it" },
      { cwd: dir },
    ).done;
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("resolves with the thread id so the pipeline can continue the session", async () => {
    const executable = await stubCodex([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
    ]);
    const result = await new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    ).done;
    expect(result.sessionId).toBe("thread-1");
  });

  it("runs `exec resume` when continuing an earlier session", async () => {
    const script = path.join(dir, "fake-codex-resume");
    const body = [
      "#!/bin/sh",
      '[ "$1" = "exec" ] || exit 91',
      '[ "$2" = "resume" ] || exit 92',
      '[ "$3" = "--json" ] || exit 93',
      '[ "$4" = "--dangerously-bypass-approvals-and-sandbox" ] || exit 94',
      '[ "$5" = "thread-7" ] || exit 95',
      '[ "$6" = "go on" ] || exit 96',
      `echo '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "continued" } })}'`,
    ].join("\n");
    await fs.writeFile(script, `${body}\n`, { mode: 0o755 });
    const result = await new CodexHarness(script).spawn(
      { prompt: "go on" },
      { cwd: dir, continueSessionId: "thread-7" },
    ).done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("continued");
  });
});
