import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_EFFORT_LEVELS, CodexHarness, classifyCodexFailure, mapCodexLine } from "./codex.js";
import type { HarnessEvent, HarnessResult, HarnessSelection } from "./types.js";

/** 2026-08-03 09:30 local. */
const NOW = new Date(2026, 7, 3, 9, 30).getTime();

/** Harness-only selection: the tests that care about flags name their own. */
const TEST_SELECTION: HarnessSelection = { sessionKind: "implementation" };

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

  it("preserves the full command activity detail", () => {
    const command = `pnpm test --filter ${"long-command".repeat(20)}`;
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command },
    });
    expect(mapCodexLine(line)).toEqual([{ type: "tool", name: "command", detail: command }]);
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

  it("keeps the thread id out of the public event stream", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "thread-9" });
    expect(mapCodexLine(line)).toEqual([]);
  });
});

describe("classifyCodexFailure", () => {
  it("reads a usage-limit reset from 12-hour clock prose", () => {
    expect(
      classifyCodexFailure("You've hit your usage limit. Try again at 3:45 PM.", NOW),
    ).toMatchObject({ kind: "usage-limit", resetsAtMs: new Date(2026, 7, 3, 15, 45).getTime() });
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

  // Regression: the deleted calendar-date form once read `Mar 3rd, 2027 3:45 PM`
  // as a real instant. It is still a usage-limit, but now leaves the reset null
  // so the pipeline backs off instead of trusting a speculative parse.
  it("still pauses on a limit but leaves the reset null for a deleted prose shape", () => {
    expect(
      classifyCodexFailure("You are out of credits. Try again at Mar 3rd, 2027 3:45 PM.", NOW),
    ).toMatchObject({ kind: "usage-limit", resetsAtMs: null });
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

  it("preserves the full first line of a failure detail", () => {
    const detail = `Connection failed: ${"provider-detail".repeat(20)}`;
    expect(classifyCodexFailure(`${detail}\nsecondary diagnostics`, NOW)).toEqual({
      kind: "outage",
      detail,
    });
  });

  it("leaves an ordinary task failure unclassified", () => {
    expect(classifyCodexFailure("the tool call was rejected", NOW)).toBeUndefined();
  });
});

describe("CodexHarness subprocess", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-codex-harness-")));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function stubCodex(lines: object[], exitCode = 0): Promise<string> {
    const script = path.join(directory, "fake-codex");
    const body = [
      "#!/bin/sh",
      '[ "$1" = "exec" ] || exit 91',
      '[ "$2" = "--json" ] || exit 92',
      '[ "$3" = "--dangerously-bypass-approvals-and-sandbox" ] || exit 93',
      '[ "$4" = "first line\nsecond line with spaces" ] || exit 94',
      `[ "$(pwd)" = "${directory}" ] || exit 95`,
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
    const session = new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory },
    );
    const events: HarnessEvent[] = [];
    for await (const event of session.events) events.push(event);

    // The turn.completed usage rides out on the result; Codex reports no
    // dollars and the test model is unpriced, so costUsd stays null.
    const expectedUsage = {
      durationMs: 0,
      costUsd: null,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 2,
    };
    await expect(session.done).resolves.toEqual({
      ok: true,
      text: "all done",
      usage: expectedUsage,
    });
    expect(events).toContainEqual({ type: "tool", name: "command", detail: "pnpm test" });
    expect(events).toContainEqual({
      type: "result",
      ok: true,
      text: "all done",
      usage: expectedUsage,
    });
  });

  it("captures raw output", async () => {
    const executable = await stubCodex([
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
    ]);
    const logPath = path.join(directory, "logs/session.jsonl");
    const session = new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory, logPath },
    );
    await session.done;
    expect(await fs.readFile(logPath, "utf8")).toContain("item.completed");
  });

  it("reports a nonzero exit", async () => {
    const executable = await stubCodex([], 2);
    const result = await new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory },
    ).done;
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("exitCode");
  });

  it("reports a missing executable", async () => {
    const result = await new CodexHarness(
      TEST_SELECTION,
      "bypass",
      path.join(directory, "missing"),
    ).spawn("do it", { cwd: directory }).done;
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("exitCode");
  });

  it("resolves with the thread id so the pipeline can continue the session", async () => {
    const executable = await stubCodex([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
    ]);
    const result = await new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory },
    ).done;
    expect(result.sessionId).toBe("thread-1");
  });

  it("reports a session Codex retried mid-stream and then completed as a success", async () => {
    const executable = await stubCodex([
      { type: "thread.started", thread_id: "thread-2" },
      { type: "error", message: "Reconnecting... 2/5: stream disconnected" },
      { type: "item.completed", item: { type: "agent_message", text: "all done" } },
    ]);
    const result = await new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory },
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
    const result = await new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory },
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
    const result = await new CodexHarness(TEST_SELECTION, "bypass", executable).spawn(
      "first line\nsecond line with spaces",
      { cwd: directory },
    ).done;
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("outage");
  });

  it("runs `exec resume` when continuing an earlier session", async () => {
    const script = path.join(directory, "fake-codex-resume");
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
    const result = await new CodexHarness(TEST_SELECTION, "bypass", script).spawn("go on", {
      cwd: directory,
      continueSessionId: "thread-7",
    }).done;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("continued");
  });
});

describe("CodexHarness selection flags", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-codex-argv-")));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  /** Stub `codex` that records the argv it was handed, one argument per line. */
  async function argvRecorder(
    name = "recording-codex",
  ): Promise<{ executable: string; argv: () => Promise<string[]> }> {
    const argvPath = path.join(directory, `${name}.txt`);
    const executable = path.join(directory, name);
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

  it("spells model as a flag and effort as a config override", async () => {
    const recorder = await argvRecorder();
    await new CodexHarness(
      { sessionKind: "code-review", model: "gpt-5.6-sol", effort: "high" },
      "bypass",
      recorder.executable,
    ).spawn("review it", { cwd: directory }).done;
    expect(await recorder.argv()).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
      "review it",
    ]);
  });

  it("keeps the flags ahead of the positional thread id when continuing", async () => {
    const recorder = await argvRecorder();
    await new CodexHarness(
      { sessionKind: "code-review", model: "gpt-5.6-sol", effort: "low" },
      "bypass",
      recorder.executable,
    ).spawn("go on", { cwd: directory, continueSessionId: "thread-7" }).done;
    const argv = await recorder.argv();
    expect(argv.slice(-2)).toEqual(["thread-7", "go on"]);
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("thread-7"));
    expect(argv.indexOf("-c")).toBeLessThan(argv.indexOf("thread-7"));
  });

  it("passes no flag for a value the stage did not configure", async () => {
    const recorder = await argvRecorder();
    await new CodexHarness(
      { sessionKind: "qa", effort: "medium" },
      "bypass",
      recorder.executable,
    ).spawn("p", { cwd: directory }).done;
    const argv = await recorder.argv();
    expect(argv).not.toContain("--model");
    expect(argv).toContain("model_reasoning_effort=medium");
  });

  it("passes the selection to an interactive launch too", async () => {
    const recorder = await argvRecorder();
    await new CodexHarness(
      { sessionKind: "implementation", model: "gpt-5.6-sol", effort: "high" },
      "bypass",
      recorder.executable,
    ).spawnInteractive("brief", { cwd: directory });
    expect(await recorder.argv()).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
      "brief",
    ]);
  });

  it("releases inherited stdin after an interactive launch exits", async () => {
    const recorder = await argvRecorder();
    const pauseInput = vi.spyOn(process.stdin, "pause");

    await new CodexHarness(TEST_SELECTION, "auto", recorder.executable).spawnInteractive("brief", {
      cwd: directory,
    });

    expect(pauseInput).toHaveBeenCalledOnce();
  });

  it.each([
    {
      permissionMode: "auto" as const,
      codexArgs: [
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        "sandbox_workspace_write.network_access=true",
      ],
    },
    {
      permissionMode: "bypass" as const,
      codexArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    },
  ])(
    "maps $permissionMode permissions across exec, exec resume, and interactive launches",
    async ({ permissionMode, codexArgs }) => {
      const headless = await argvRecorder(`${permissionMode}-headless`);
      await new CodexHarness(TEST_SELECTION, permissionMode, headless.executable).spawn("start", {
        cwd: directory,
      }).done;
      const resume = await argvRecorder(`${permissionMode}-resume`);
      await new CodexHarness(TEST_SELECTION, permissionMode, resume.executable).spawn("continue", {
        cwd: directory,
        continueSessionId: "thread-4",
      }).done;
      const interactive = await argvRecorder(`${permissionMode}-interactive`);
      await new CodexHarness(
        TEST_SELECTION,
        permissionMode,
        interactive.executable,
      ).spawnInteractive("talk", { cwd: directory });

      for (const argv of [await headless.argv(), await resume.argv(), await interactive.argv()]) {
        expect(argv).toEqual(expect.arrayContaining(codexArgs));
        expect(argv).not.toContain("--full-auto");
        // `codex exec resume` rejects `--sandbox`, so no spawn form may use it.
        expect(argv).not.toContain("--sandbox");
        if (permissionMode === "auto") {
          expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
        }
      }
    },
  );

  it("names the binary and the stages entry when the CLI is not installed", async () => {
    const result = await new CodexHarness(
      { sessionKind: "code-review" },
      "auto",
      path.join(directory, "not-installed"),
    ).spawn("p", { cwd: directory }).done;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("not-installed");
    expect(result.text).toContain("stages.code-review.harness");
  });

  it("accepts exactly the effort levels the API documents", () => {
    expect([...CODEX_EFFORT_LEVELS]).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

// End-to-end coverage of the pricing fix: `selection.model` is the single string
// handed to `--model` (what the CLI accepts) AND used to look up the price table.
// These drive a real codex subprocess and assert both facts at once — the CLI got
// the exact spelling (the stub refuses any other) and the price came from that same
// spelling. Re-introducing `.toLowerCase()` or the `Math.max(0, …)` clamp fails one.
describe("CodexHarness prices from the configured model spelling verbatim", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-codex-pricing-")));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  /**
   * Stub `codex` that runs only when `--model <expectedModel>` reached it verbatim
   * (exit 95 otherwise, which fails the session), then reports `usage` on
   * `turn.completed`. The agent message makes the session a success so the harness
   * prices it. Because the harness derives both `--model` and the price lookup from
   * the one `selection.model`, the spelling this stub accepts is the spelling priced.
   */
  async function stubPricingCodex(
    name: string,
    expectedModel: string,
    usage: object,
  ): Promise<string> {
    const script = path.join(directory, name);
    const body = [
      "#!/bin/sh",
      '[ "$1" = "exec" ] || exit 91',
      '[ "$2" = "--json" ] || exit 92',
      '[ "$3" = "--dangerously-bypass-approvals-and-sandbox" ] || exit 93',
      '[ "$4" = "--model" ] || exit 94',
      `[ "$5" = "${expectedModel}" ] || exit 95`,
      '[ "$6" = "do the work" ] || exit 96',
      `echo '${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}'`,
      `echo '${JSON.stringify({ type: "turn.completed", usage })}'`,
      "exit 0",
    ].join("\n");
    await fs.writeFile(script, `${body}\n`, { mode: 0o755 });
    return script;
  }

  function priceRun(model: string, executable: string): Promise<HarnessResult> {
    return new CodexHarness({ sessionKind: "implementation", model }, "bypass", executable).spawn(
      "do the work",
      { cwd: directory },
    ).done;
  }

  it("prices a table model, proving the CLI model and the priced model are one string", async () => {
    const executable = await stubPricingCodex("priced", "gpt-5.6-terra", {
      input_tokens: 1_000_000,
      cached_input_tokens: 200_000,
      output_tokens: 500_000,
    });
    const result = await priceRun("gpt-5.6-terra", executable);
    // ok:true means the stub's `--model gpt-5.6-terra` guard passed → the CLI got
    // the verbatim spelling. terra: 800K×$2 + 200K×$0.20 + 500K×$12 per 1M.
    expect(result.ok).toBe(true);
    expect(result.usage?.costUsd).toBeCloseTo(1.6 + 0.04 + 6.0, 6);
    expect(result.usage?.isCostEstimated).toBe(true);
    // Codex did not report a model in its stream; the configured pricing key is
    // not promoted into the provider-confirmed usage field.
    expect(result.usage?.model).toBeUndefined();
  });

  it("leaves a mixed-case model unpriced instead of lowercasing it into the table", async () => {
    // The CLI is handed "GPT-5.6-Terra" verbatim (the stub guard enforces it), yet
    // the table — keyed on the exact lowercase spelling the CLI accepts — has no
    // such row, so the cost stays unknown. The lookup must not widen the table's
    // vocabulary past what the CLI itself would take.
    const executable = await stubPricingCodex("mixedcase", "GPT-5.6-Terra", {
      input_tokens: 1_000_000,
      cached_input_tokens: 0,
      output_tokens: 0,
    });
    const result = await priceRun("GPT-5.6-Terra", executable);
    expect(result.ok).toBe(true);
    expect(result.usage?.costUsd).toBeNull();
    // Tokens are still recorded; only the dollar figure is withheld.
    expect(result.usage?.inputTokens).toBe(1_000_000);
    expect(result.usage?.isCostEstimated).toBeUndefined();
  });

  it("lets cached input exceeding total input surface as a negative cost, unclamped", async () => {
    // These provider counts break the documented subset invariant. Without the old
    // `Math.max(0, …)` clamp the figure goes negative — a visibly wrong number that
    // exposes the broken boundary data instead of a plausible clamped one that hides
    // it. terra: (100K−200K)×$2/M input = −0.2, +200K×$0.20/M cached = +0.04 → −0.16.
    const executable = await stubPricingCodex("overcached", "gpt-5.6-terra", {
      input_tokens: 100_000,
      cached_input_tokens: 200_000,
      output_tokens: 0,
    });
    const result = await priceRun("gpt-5.6-terra", executable);
    expect(result.usage?.costUsd).toBeCloseTo(-0.16, 6);
    expect(result.usage?.costUsd).toBeLessThan(0);
  });
});
