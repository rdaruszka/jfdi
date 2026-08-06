import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_EFFORT_LEVELS,
  ClaudeHarness,
  classifyClaudeFailure,
  mapClaudeLine,
} from "./claude.js";
import type { HarnessEvent, HarnessSelection } from "./types.js";

/** 2026-08-03 09:30 local. */
const NOW = new Date(2026, 7, 3, 9, 30).getTime();

/** Harness-only selection: the tests that care about flags name their own. */
const TEST_SELECTION: HarnessSelection = { sessionKind: "implementation" };

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

  it("preserves the full tool detail", () => {
    const command = `pnpm test --filter ${"long-command".repeat(20)}`;
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command } }],
      },
    });
    expect(mapClaudeLine(line)).toEqual([{ type: "tool", name: "Bash", detail: command }]);
  });

  it("maps the final result line", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", result: "all done" });
    expect(mapClaudeLine(line)).toEqual([{ type: "result", ok: true, text: "all done" }]);
  });

  it("carries the CLI-reported cost and tokens through verbatim on the result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "all done",
      total_cost_usd: 1.87,
      usage: {
        input_tokens: 120_000,
        output_tokens: 8_000,
        cache_read_input_tokens: 40_000,
      },
    });
    expect(mapClaudeLine(line)).toEqual([
      {
        type: "result",
        ok: true,
        text: "all done",
        // Claude reports dollars directly, so costUsd is its figure untouched;
        // durationMs stays zero until the pipeline measures it.
        usage: {
          durationMs: 0,
          costUsd: 1.87,
          inputTokens: 120_000,
          cachedInputTokens: 40_000,
          outputTokens: 8_000,
        },
      },
    ]);
  });

  it("surfaces the provider-reported model from the result line", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      modelUsage: { "claude-opus-4-8-provider-ran": {} },
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    const [event] = mapClaudeLine(line);
    expect(event).toMatchObject({ type: "result", ok: true });
    expect(event.type === "result" ? event.usage : undefined).toBeDefined();
    expect(event.type === "result" ? event.usage?.model : "unset").toBe(
      "claude-opus-4-8-provider-ran",
    );
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

  it("keeps session ids out of the public event stream", () => {
    const initLine = JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" });
    expect(mapClaudeLine(initLine)).toEqual([]);
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "def-456",
    });
    expect(mapClaudeLine(resultLine)).toEqual([{ type: "result", ok: true, text: "done" }]);
  });
});

describe("classifyClaudeFailure", () => {
  it("reads the usage-limit reset time out of 12-hour clock prose", () => {
    expect(
      classifyClaudeFailure("You've hit your session limit · resets 3:45pm", null, NOW),
    ).toEqual({
      kind: "usage-limit",
      resetsAtMs: new Date(2026, 7, 3, 15, 45).getTime(),
      detail: "You've hit your session limit · resets 3:45pm",
    });
  });

  it("reads the legacy raw-API form, where the reset is epoch seconds after a pipe", () => {
    const resetsAtMs = new Date(2026, 7, 3, 18).getTime();
    const epochSeconds = Math.floor(resetsAtMs / 1000);
    expect(
      classifyClaudeFailure(`Claude AI usage limit reached|${epochSeconds}`, null, NOW),
    ).toMatchObject({ kind: "usage-limit", resetsAtMs });
  });

  it("leaves the reset time null when the prose names none", () => {
    expect(classifyClaudeFailure("You've hit your session limit", null, NOW)).toEqual({
      kind: "usage-limit",
      resetsAtMs: null,
      detail: "You've hit your session limit",
    });
  });

  // Regression: a limit whose prose carries a deleted speculative shape (weekday
  // or calendar date) is still a usage-limit, but its reset is now unreadable —
  // so the pipeline pauses and backs off instead of pausing until a misread
  // instant. The calendar-date case is the one that once misread a past date.
  it("still pauses on a limit but leaves the reset null for a deleted prose shape", () => {
    for (const text of [
      "You've hit your weekly limit, resets Mon 12:00am",
      "You've hit your Opus limit · resets Aug 28 at 7pm",
      "You've hit your session limit · resets 19:00",
    ]) {
      expect(classifyClaudeFailure(text, null, NOW)).toMatchObject({
        kind: "usage-limit",
        resetsAtMs: null,
      });
    }
  });

  it("classifies the repairs only a human can make", () => {
    for (const text of [
      "Invalid API key · Please run /login",
      "You are not logged in",
      "OAuth token expired",
      "Credit balance is too low",
      "authentication_error: could not be refreshed",
    ]) {
      expect(classifyClaudeFailure(text, null, NOW)?.kind).toBe("needs-human");
    }
  });

  it("classifies transient failures as outages, by text or by HTTP status", () => {
    expect(classifyClaudeFailure("API Error: Overloaded", null, NOW)?.kind).toBe("outage");
    expect(classifyClaudeFailure("unable to connect to api.anthropic.com", null, NOW)?.kind).toBe(
      "outage",
    );
    expect(classifyClaudeFailure("connect ETIMEDOUT", null, NOW)?.kind).toBe("outage");
    // A 500 body that says nothing recognizable is still an outage.
    expect(classifyClaudeFailure("Internal server error", 500, NOW)?.kind).toBe("outage");
    expect(classifyClaudeFailure("something went wrong", 529, NOW)?.kind).toBe("outage");
  });

  it("preserves the full first line of a failure detail", () => {
    const detail = `API Error: Overloaded ${"provider-detail".repeat(20)}`;
    expect(classifyClaudeFailure(`${detail}\nsecondary diagnostics`, null, NOW)).toEqual({
      kind: "outage",
      detail,
    });
  });

  it("leaves an ordinary task failure unclassified, so it stays a feedback round", () => {
    expect(classifyClaudeFailure("ran out of turns", null, NOW)).toBeUndefined();
    // 400 is a bad request, not a provider outage.
    expect(classifyClaudeFailure("messages.0: too long", 400, NOW)).toBeUndefined();
  });
});

describe("mapClaudeLine failure classification", () => {
  it("classifies an API failure, which arrives as a success subtype with is_error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your session limit",
    });
    expect(mapClaudeLine(line)).toEqual([
      {
        type: "result",
        ok: false,
        text: "You've hit your session limit",
        failure: { kind: "usage-limit", resetsAtMs: null, detail: "You've hit your session limit" },
      },
    ]);
  });

  it("leaves error_* subtypes unclassified — those are the agent's problem, not the provider's", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "ran out",
    });
    expect(mapClaudeLine(line)).toEqual([{ type: "result", ok: false, text: "ran out" }]);
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
    const harness = new ClaudeHarness(TEST_SELECTION, "bypass", exe);
    const session = harness.spawn("first line\nsecond line with spaces", { cwd: dir });
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
    const harness = new ClaudeHarness(TEST_SELECTION, "bypass", exe);
    const session = harness.spawn("first line\nsecond line with spaces", { cwd: dir, logPath });
    await session.done;
    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain('"result"');
  });

  it("reports failure when the process exits non-zero", async () => {
    const exe = await stubClaude([], 2);
    const harness = new ClaudeHarness(TEST_SELECTION, "bypass", exe);
    const session = harness.spawn("first line\nsecond line with spaces", { cwd: dir });
    const result = await session.done;
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("exitCode");
  });

  it("reports failure when the executable is missing", async () => {
    const harness = new ClaudeHarness(TEST_SELECTION, "bypass", path.join(dir, "does-not-exist"));
    const session = harness.spawn("p", { cwd: dir });
    const result = await session.done;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("failed to spawn");
  });

  it("resolves with the session id so the pipeline can continue the session", async () => {
    const exe = await stubClaude([
      { type: "system", subtype: "init", session_id: "session-1" },
      { type: "result", subtype: "success", result: "ok", session_id: "session-1" },
    ]);
    const result = await new ClaudeHarness(TEST_SELECTION, "bypass", exe).spawn(
      "first line\nsecond line with spaces",
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
    const result = await new ClaudeHarness(TEST_SELECTION, "bypass", script).spawn("go on", {
      cwd: dir,
      continueSessionId: "old-session",
    }).done;
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
    const result = await new ClaudeHarness(TEST_SELECTION, "bypass", script).spawn("p", {
      cwd: dir,
    }).done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hooked");
  });
});

describe("ClaudeHarness selection flags", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-claude-argv-")));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Stub `claude` that records the argv it was handed, one argument per line. */
  async function argvRecorder(
    name = "recording-claude",
  ): Promise<{ executable: string; argv: () => Promise<string[]> }> {
    const argvPath = path.join(dir, `${name}.txt`);
    const executable = path.join(dir, name);
    await fs.writeFile(
      executable,
      ["#!/bin/sh", `for arg in "$@"; do echo "$arg" >> "${argvPath}"; done`, ""].join("\n"),
      { mode: 0o755 },
    );
    return {
      executable,
      argv: async () => (await fs.readFile(argvPath, "utf8")).split("\n").slice(0, -1),
    };
  }

  it("spells model and effort the way Claude Code does", async () => {
    const recorder = await argvRecorder();
    await new ClaudeHarness(
      { sessionKind: "qa", model: "claude-opus-4-8", effort: "xhigh" },
      "bypass",
      recorder.executable,
    ).spawn("p", { cwd: dir }).done;
    const argv = await recorder.argv();
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(argv).toContain("--effort");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("passes no flag for a value the stage did not configure", async () => {
    const recorder = await argvRecorder();
    await new ClaudeHarness(
      { sessionKind: "qa", model: "opus" },
      "bypass",
      recorder.executable,
    ).spawn("p", { cwd: dir }).done;
    const argv = await recorder.argv();
    expect(argv).toContain("--model");
    expect(argv).not.toContain("--effort");
  });

  it("passes the selection to an interactive launch too", async () => {
    const recorder = await argvRecorder();
    await new ClaudeHarness(
      { sessionKind: "implementation", model: "claude-opus-4-8", effort: "high" },
      "bypass",
      recorder.executable,
    ).spawnInteractive("brief", { cwd: dir, isSystemPrompt: true });
    expect(await recorder.argv()).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "high",
      "--append-system-prompt",
      "brief",
    ]);
  });

  it.each([
    // Claude's `auto` is interactive-only — a headless session has no human for
    // the classifier to escalate to and denies every write, worktree included —
    // so headless auto runs acceptEdits with the Bash tool allowed instead.
    {
      permissionMode: "auto" as const,
      headlessArgs: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"],
      interactiveArgs: ["--permission-mode", "auto"],
    },
    {
      permissionMode: "bypass" as const,
      headlessArgs: ["--permission-mode", "bypassPermissions"],
      interactiveArgs: ["--permission-mode", "bypassPermissions"],
    },
  ])(
    "maps $permissionMode permissions across headless, resume, and interactive launches",
    async ({ permissionMode, headlessArgs, interactiveArgs }) => {
      const headless = await argvRecorder(`${permissionMode}-headless`);
      await new ClaudeHarness(TEST_SELECTION, permissionMode, headless.executable).spawn("start", {
        cwd: dir,
      }).done;
      const resume = await argvRecorder(`${permissionMode}-resume`);
      await new ClaudeHarness(TEST_SELECTION, permissionMode, resume.executable).spawn("continue", {
        cwd: dir,
        continueSessionId: "session-4",
      }).done;
      const interactive = await argvRecorder(`${permissionMode}-interactive`);
      await new ClaudeHarness(
        TEST_SELECTION,
        permissionMode,
        interactive.executable,
      ).spawnInteractive("talk", { cwd: dir });

      for (const argv of [await headless.argv(), await resume.argv()]) {
        const flagIndex = argv.indexOf("--permission-mode");
        expect(argv.slice(flagIndex, flagIndex + headlessArgs.length)).toEqual(headlessArgs);
        expect(argv).not.toContain("auto");
      }
      const interactiveArgv = await interactive.argv();
      const flagIndex = interactiveArgv.indexOf("--permission-mode");
      expect(interactiveArgv.slice(flagIndex, flagIndex + interactiveArgs.length)).toEqual(
        interactiveArgs,
      );
    },
  );

  it("names the binary and the stages entry when the CLI is not installed", async () => {
    const result = await new ClaudeHarness(
      { sessionKind: "code-review" },
      "auto",
      path.join(dir, "not-installed"),
    ).spawn("p", { cwd: dir }).done;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("not-installed");
    expect(result.text).toContain("stages.code-review.harness");
  });

  it("accepts exactly the effort levels the CLI documents", () => {
    expect([...CLAUDE_EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
