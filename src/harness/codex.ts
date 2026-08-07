import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { PermissionMode } from "../config.js";
import { EXIT_COMMAND_NOT_EXECUTABLE } from "../util/exit-codes.js";
import { codexCostUsd } from "./codex-pricing.js";
import { parseResetTime } from "./reset-time.js";
import { spawnFailureText } from "./spawn-failure.js";
import type {
  Harness,
  HarnessEvent,
  HarnessFailure,
  HarnessFailureKind,
  HarnessResult,
  HarnessSelection,
  HarnessSession,
  InteractiveSpawnOptions,
  SessionUsage,
  SpawnOptions,
} from "./types.js";

const STDERR_TAIL_CHARS = 4_000;
const SIGKILL_DELAY_MS = 5_000;

/**
 * What `-c model_reasoning_effort=` accepts. Codex has no flag for it and
 * validates nothing locally — it forwards the value to the API, which answers
 * an unknown one with a 400 mid-session (verified against Codex 0.146.0,
 * Aug 2026). This table is what turns that into a config error at startup.
 */
export const CODEX_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** The selection, as Codex spells it. An absent value passes no flag. */
function codexSelectionArgs(selection: HarnessSelection): string[] {
  return [
    ...(selection.model ? ["--model", selection.model] : []),
    ...(selection.effort ? ["-c", `model_reasoning_effort=${selection.effort}`] : []),
  ];
}

/**
 * The instance-wide permission mode, as Codex spells it. `auto` uses the `-c`
 * config spelling, not `--sandbox`: `codex exec resume` rejects `--sandbox`
 * (verified against Codex 0.146.0, Aug 2026), and both subcommands accept the
 * `-c` overrides, so one spelling serves fresh spawns and continuations alike.
 */
function codexPermissionArgs(permissionMode: PermissionMode): string[] {
  return permissionMode === "auto"
    ? ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"]
    : ["--dangerously-bypass-approvals-and-sandbox"];
}

/**
 * How a Codex failure message is read as an infrastructure class, most
 * specific first. Verified against Codex 0.146.0 (Aug 2026) — version-volatile
 * strings, so this is a table to extend, and an unmatched message stays an
 * ordinary task failure the pipeline feeds back as a round.
 */
const CODEX_FAILURE_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: HarnessFailureKind }> = [
  {
    pattern: /You've hit your usage limit|out of credits|spend cap|Quota exceeded/i,
    kind: "usage-limit",
  },
  {
    pattern: /could not be refreshed|status 401|codex login|no Codex credentials/i,
    kind: "needs-human",
  },
  {
    pattern:
      /exceeded retry limit|stream disconnected|Connection failed|request timed out|Error while reading the server response|high demand|at capacity/i,
    kind: "outage",
  },
];

/** `Try again at 3:45 PM.` — local time, no timezone marker. `Try again later.` carries none. */
const CODEX_TRY_AGAIN_AT = /try again at ([^.\n]+)/i;
/**
 * A session that never announced its thread did not run at all — the
 * detached-TTY regression (openai/codex#19945). Nothing in the exit code says
 * so, so the absence of `thread.started` is the signal.
 */
const CODEX_NO_THREAD_DETAIL = "codex exited without starting a thread";

function failureDetail(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  return line.trim();
}

/** Classify a Codex failure message. Undefined means "the agent's problem, not the provider's". */
export function classifyCodexFailure(text: string, nowMs: number): HarnessFailure | undefined {
  const matched = CODEX_FAILURE_PATTERNS.find((entry) => entry.pattern.test(text));
  if (!matched) return undefined;
  const detail = failureDetail(text);
  if (matched.kind !== "usage-limit") return { kind: matched.kind, detail };
  const tryAgainAt = CODEX_TRY_AGAIN_AT.exec(text);
  return {
    kind: "usage-limit",
    resetsAtMs: tryAgainAt?.[1] === undefined ? null : parseResetTime(tryAgainAt[1], nowMs),
    detail,
  };
}

/**
 * Cumulative token counts as Codex reports them. `output_tokens` already
 * includes reasoning tokens. `cached_input_tokens` is a subset of
 * `input_tokens`. Version-volatile field names, so read defensively.
 */
interface CodexTokenCounts {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface CodexStreamLine {
  type?: string;
  message?: string;
  thread_id?: string;
  error?: { message?: string };
  item?: {
    type?: string;
    text?: string;
    command?: string;
    server?: string;
    tool?: string;
    query?: string;
  };
  /** `token_count` events nest cumulative usage under `info.total_token_usage`. */
  info?: { total_token_usage?: CodexTokenCounts };
  /** `turn.completed` (newer exec JSON) carries usage here instead. */
  usage?: CodexTokenCounts;
}

/**
 * The cumulative token counts a Codex line carries, or null when it carries
 * none. Codex emits these on `token_count` events and `turn.completed`; the
 * counts are cumulative, so the last one seen is the session total. Cost is
 * left null here — the harness computes it from the price table at close, once
 * it knows the model.
 */
export function codexUsageTokens(line: string): SessionUsage | null {
  const parsed = parseStreamLine(line);
  if (parsed === null) return null;
  const counts = parsed.info?.total_token_usage ?? parsed.usage;
  if (counts === undefined) return null;
  return {
    durationMs: 0,
    costUsd: null,
    inputTokens: counts.input_tokens ?? 0,
    cachedInputTokens: counts.cached_input_tokens ?? 0,
    outputTokens: counts.output_tokens ?? 0,
  };
}

function parseStreamLine(line: string): CodexStreamLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as CodexStreamLine) : null;
  } catch {
    return null;
  }
}

/**
 * Fill a session's cost from the price table, once the model is known. Codex
 * reports no dollars, so an unpriced model leaves `costUsd` null (unknown).
 * Returns undefined when the session reported no token usage at all.
 */
function pricedUsage(
  tokens: SessionUsage | null,
  configuredModel: string | undefined,
): SessionUsage | undefined {
  if (tokens === null) return undefined;
  const costUsd = codexCostUsd(configuredModel, tokens);
  return {
    ...tokens,
    costUsd,
    // A dollar figure here is always a table estimate (Codex reports no cost);
    // flag it so the dollars carry an "estimate, runs low" note downstream. An
    // unpriced model has no dollars to qualify, so it carries no flag.
    ...(costUsd !== null ? { isCostEstimated: true } : {}),
  };
}

/** Assemble the final result at close: fold in usage, classify a failure, attach the session id. */
function finalizeClose(
  closed: HarnessResult,
  usage: SessionUsage | undefined,
  resultFailure: HarnessFailure | undefined,
  sessionId: string | undefined,
): HarnessResult {
  const failure = closed.ok
    ? undefined
    : (resultFailure ?? closeFailure(closed.text, sessionId !== undefined));
  const withUsage = usage ? { ...closed, usage } : closed;
  return withSession(failure ? { ...withUsage, failure } : withUsage, sessionId);
}

/** Map one `codex exec --json` line to provider-neutral progress events. */
export function mapCodexLine(line: string): HarnessEvent[] {
  const parsed = parseStreamLine(line);
  if (parsed === null) return [];
  if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
    return parsed.item.text ? [{ type: "text", text: parsed.item.text }] : [];
  }
  if (parsed.type === "item.started" || parsed.type === "item.completed") {
    return mapToolItem(parsed.item);
  }
  // Only `turn.failed` is terminal. Bare `error` events carry Codex's own
  // mid-stream retries ("Reconnecting… 2/5: …") with no field to tell them
  // apart, so treating one as a failed result reported a session Codex went on
  // to complete as failed.
  if (parsed.type === "turn.failed") {
    const text = parsed.error?.message ?? parsed.message ?? "Codex session failed";
    const failure = classifyCodexFailure(text, Date.now());
    return [{ type: "result", ok: false, text, ...(failure ? { failure } : {}) }];
  }
  return [];
}

function mapToolItem(item: CodexStreamLine["item"]): HarnessEvent[] {
  if (item?.type === "command_execution" && item.command) {
    return [{ type: "tool", name: "command", detail: item.command }];
  }
  if (item?.type === "mcp_tool_call" && item.tool) {
    const name = item.server ? `${item.server}.${item.tool}` : item.tool;
    return [{ type: "tool", name }];
  }
  if (item?.type === "web_search" && item.query) {
    return [{ type: "tool", name: "web_search", detail: item.query }];
  }
  return [];
}

/**
 * What a finished session reports. Codex says nothing on the way out: success
 * is inferred from a clean exit that produced an agent message and no
 * `turn.failed`.
 */
function closedResult(
  exitCode: number | null,
  finalText: string,
  failureText: string | null,
  stderrTail: string,
): HarnessResult {
  const isSuccess = exitCode === 0 && finalText !== "" && failureText === null;
  return isSuccess
    ? { ok: true, text: finalText }
    : {
        ok: false,
        text: failureText ?? exitText(exitCode, stderrTail),
      };
}

/**
 * Why a session that has already exited failed, when the provider was the
 * reason. Beyond the message text there is one signal only the close knows: a
 * session that never announced a thread never ran, whatever its exit code.
 */
function closeFailure(text: string, hasStartedThread: boolean): HarnessFailure | undefined {
  const classified = classifyCodexFailure(text, Date.now());
  if (classified) return classified;
  return hasStartedThread ? undefined : { kind: "outage", detail: CODEX_NO_THREAD_DETAIL };
}

/** Harness implementation running `codex exec --json` in the ticket worktree. */
export class CodexHarness implements Harness {
  constructor(
    private readonly selection: HarnessSelection,
    private readonly permissionMode: PermissionMode,
    private readonly executable: string = "codex",
  ) {}

  spawn(prompt: string, options: SpawnOptions): HarnessSession {
    // `codex exec resume <thread-id> <prompt>` continues an earlier thread.
    // Flags precede the positional thread id and prompt in both forms.
    const selectionArgs = codexSelectionArgs(this.selection);
    const args = options.continueSessionId
      ? [
          "exec",
          "resume",
          "--json",
          ...codexPermissionArgs(this.permissionMode),
          ...selectionArgs,
          options.continueSessionId,
          prompt,
        ]
      : ["exec", "--json", ...codexPermissionArgs(this.permissionMode), ...selectionArgs, prompt];
    const child: ChildProcess = spawn(this.executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const log = options.logPath ? openLog(options.logPath) : null;
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      log?.write(text);
    });

    const queue: HarnessEvent[] = [];
    let notify: (() => void) | null = null;
    let hasEnded = false;
    let finalText = "";
    let failureText: string | null = null;
    let resultFailure: HarnessFailure | undefined;
    let sessionId: string | undefined;
    // Codex reports cumulative token counts, so the last one seen is the total.
    let latestUsage: SessionUsage | null = null;
    const push = (event: HarnessEvent) => {
      queue.push(event);
      notify?.();
    };

    const stdoutLines = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : null;
    stdoutLines?.on("line", (line) => {
      log?.write(`${line}\n`);
      const usage = codexUsageTokens(line);
      if (usage) latestUsage = usage;
      const parsed = parseStreamLine(line);
      if (parsed?.type === "thread.started" && parsed.thread_id) sessionId = parsed.thread_id;
      for (const event of mapCodexLine(line)) {
        if (event.type === "text") finalText = event.text;
        if (event.type === "result" && !event.ok) {
          failureText = event.text;
          resultFailure = event.failure;
        }
        push(event);
      }
    });

    const done = new Promise<HarnessResult>((resolve) => {
      child.on("error", (error) => {
        hasEnded = true;
        log?.end();
        resolve({
          ok: false,
          text: spawnFailureText(this.executable, this.selection, error.message),
        });
        notify?.();
      });
      child.on("close", (code) => {
        hasEnded = true;
        log?.end();
        const closed = closedResult(code, finalText, failureText, stderrTail);
        const usage = closed.ok ? pricedUsage(latestUsage, this.selection.model) : undefined;
        if (closed.ok)
          push({ type: "result", ok: true, text: closed.text, ...(usage ? { usage } : {}) });
        resolve(finalizeClose(closed, usage, resultFailure, sessionId));
        notify?.();
      });
    });

    const events: AsyncIterable<HarnessEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HarnessEvent>> {
            for (;;) {
              const event = queue.shift();
              if (event) return { value: event, done: false };
              if (hasEnded) return { value: undefined, done: true };
              await new Promise<void>((resolve) => {
                notify = resolve;
              });
              notify = null;
            }
          },
        };
      },
    };

    return {
      events,
      done,
      kill: () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), SIGKILL_DELAY_MS).unref();
      },
    };
  }

  spawnInteractive(prompt: string, options: InteractiveSpawnOptions): Promise<number> {
    // `-m` and `-c` are top-level Codex options, so the interactive launch
    // honors the selection supplied for conversational init. Project-context
    // isolation maps to project_doc_max_bytes=0 (Codex reads no AGENTS.md).
    // Codex has no append-system-prompt seam, so the caller's system framing
    // degrades gracefully to a preamble on the opening user message.
    const args = [
      ...codexPermissionArgs(this.permissionMode),
      ...codexSelectionArgs(this.selection),
    ];
    if (options.shouldIgnoreProjectContext) args.push("-c", "project_doc_max_bytes=0");
    const openingMessage =
      options.systemPrompt === undefined ? prompt : `${options.systemPrompt}\n\n---\n\n${prompt}`;
    const child = spawn(this.executable, [...args, openingMessage], {
      cwd: options.cwd,
      stdio: "inherit",
    });
    return interactiveResult(child, this.executable, this.selection);
  }
}

function interactiveResult(
  child: ChildProcess,
  executable: string,
  selection: HarnessSelection,
): Promise<number> {
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(spawnFailureText(executable, selection, error.message, "init-flags"));
      resolve(EXIT_COMMAND_NOT_EXECUTABLE);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function openLog(logPath: string) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return createWriteStream(logPath, { flags: "a" });
}

/** Attach the provider's session id to a result when one was reported. */
function withSession(result: HarnessResult, sessionId: string | undefined): HarnessResult {
  return sessionId ? { ...result, sessionId } : result;
}

function exitText(code: number | null, stderrTail: string): string {
  return `harness exited with code ${code ?? "?"}${stderrTail ? `\nstderr: ${stderrTail.trim()}` : ""}`;
}
