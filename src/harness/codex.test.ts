import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexHarness, classifyCodexFailure, mapCodexLine } from "./codex.js";
import type { HarnessEvent } from "./types.js";

/** 2026-08-03 09:30 local. */
const NOW = new Date(2026, 7, 3, 9, 30).getTime();

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

  it("ignores bare error events — Codex emits them for retries it goes on to survive", () => {
    const line = JSON.stringify({ type: "error", message: "Reconnecting... 2/5: stream error" });
    expect(mapCodexLine(line)).toEqual([]);
  });

  it("ignores unparseable lines", () => {
    expect(mapCodexLine("not json")).toEqual([]);
  });

  it("maps the thread id used to resume the session later", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "thread-9" });
    expect(mapCodexLine(line)).toEqual([{ type: "session", sessionId: "thread-9" }]);
  });
});

describe("classifyCodexFailure", () => {
  it("reads each usage-limit wording, with the local reset time out of the prose", () => {
    expect(
      classifyCodexFailure("You've hit your usage limit. Try again at 3:45 PM.", NOW),
    ).toMatchObject({ kind: "usage-limit", resetsAtMs: new Date(2026, 7, 3, 15, 45).getTime() });
    expect(
      classifyCodexFailure("You are out of credits. Try again at Mar 3rd, 2027 3:45 PM.", NOW),
    ).toMatchObject({ kind: "usage-limit", resetsAtMs: new Date(2027, 2, 3, 15, 45).getTime() });
    expect(classifyCodexFailure("Quota exceeded for this spend cap", NOW)?.kind).toBe(
      "usage-limit",
    );
  });

  it("leaves the reset time null when the message only says `Try again later.`", () => {
    expect(classifyCodexFailure("You've hit your usage limit. Try again later.", NOW)).toEqual({
      kind: "usage-limit",
      resetsAtMs: null,
      detail: "You've hit your usage limit. Try again later.",
    });
  });

  it("classifies the repairs only a human can make", () => {
    for (const text of [
      "The provided token could not be refreshed",
      "unexpected status 401 Unauthorized",
      "Please run codex login",
      "no Codex credentials found",
    ]) {
      expect(classifyCodexFailure(text, NOW)?.kind).toBe("needs-human");
    }
  });

  it("classifies transient failures as outages", () => {
    for (const text of [
      "exceeded retry limit, last status: 503",
      "stream disconnected before completion",
      "Connection failed",
      "request timed out",
      "Error while reading the server response",
      "We're experiencing high demand",
      "the model is at capacity",
    ]) {
      expect(classifyCodexFailure(text, NOW)?.kind).toBe("outage");
    }
  });

  it("leaves an ordinary task failure unclassified", () => {
    expect(classifyCodexFailure("the tool call was rejected", NOW)).toBeUndefined();
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

  it("reports a session Codex retried mid-stream and then completed as a success", async () => {
    const executable = await stubCodex([
      { type: "thread.started", thread_id: "thread-2" },
      { type: "error", message: "Reconnecting... 2/5: stream disconnected" },
      { type: "item.completed", item: { type: "agent_message", text: "all done" } },
    ]);
    const result = await new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    ).done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("all done");
    expect(result.failure).toBeUndefined();
  });

  it("classifies a turn.failed usage limit for the pipeline to pause on", async () => {
    const executable = await stubCodex(
      [
        { type: "thread.started", thread_id: "thread-3" },
        // No apostrophes: the stub replays its lines through a shell `echo`.
        { type: "turn.failed", error: { message: "You are out of credits. Try again later." } },
      ],
      1,
    );
    const result = await new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    ).done;
    expect(result.failure).toEqual({
      kind: "usage-limit",
      resetsAtMs: null,
      detail: "You are out of credits. Try again later.",
    });
  });

  it("calls a session that never started a thread an outage, whatever its exit code", async () => {
    // The detached-TTY regression: codex exits having emitted nothing at all.
    const executable = await stubCodex([]);
    const result = await new CodexHarness(executable).spawn(
      { prompt: "first line\nsecond line with spaces" },
      { cwd: dir },
    ).done;
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("outage");
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
