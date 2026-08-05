import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { PermissionMode } from "../config.js";
import { EXIT_COMMAND_NOT_EXECUTABLE } from "../util/exit-codes.js";
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
  PromptSpec,
  SessionUsage,
  SpawnOptions,
} from "./types.js";

/**
 * What `claude --effort` accepts (verified against `claude --help`, Aug 2026).
 * Config validation reads this so a typo fails at startup rather than burning
 * a round; it is version-volatile, so it is a table to extend.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The selection, as Claude Code spells it. An absent value passes no flag. */
function claudeSelectionArgs(selection: HarnessSelection): string[] {
  return [
    ...(selection.model ? ["--model", selection.model] : []),
    ...(selection.effort ? ["--effort", selection.effort] : []),
  ];
}

/** The instance-wide permission mode, as Claude Code spells it. */
function claudePermissionArgs(permissionMode: PermissionMode): string[] {
  return ["--permission-mode", permissionMode === "auto" ? "auto" : "bypassPermissions"];
}

/** Longest tool-input excerpt shown as a progress detail. */
const MAX_TOOL_DETAIL_CHARS = 80;
const ELLIPSIS = "...";
/** How much stderr is kept to explain a non-zero exit. */
const STDERR_TAIL_CHARS = 4_000;
/** Grace period between SIGTERM and SIGKILL when a session is killed. */
const SIGKILL_DELAY_MS = 5_000;

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  /** HTTP status behind an API-level failure; null for connection errors. */
  api_error_status?: number | null;
  session_id?: string;
  /** Dollars the CLI computed for the whole session — used verbatim, never recomputed. */
  total_cost_usd?: number;
  /** Cumulative token usage the CLI reports on the result line. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
}

/**
 * The provider-neutral usage for a Claude result line. Claude reports dollars
 * directly, so `costUsd` is its `total_cost_usd` verbatim (§3 of the ticket);
 * tokens ride along for the machine record and the price-unknown fallback.
 * `durationMs` stays zero — agent time is pipeline-measured, not provider-read.
 */
function claudeUsage(parsed: ClaudeStreamLine): SessionUsage | undefined {
  const usage = parsed.usage;
  if (parsed.total_cost_usd === undefined && usage === undefined) return undefined;
  return {
    durationMs: 0,
    costUsd: parsed.total_cost_usd ?? null,
    inputTokens: usage?.input_tokens ?? 0,
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    reasoningTokens: 0,
  };
}

/**
 * How a Claude Code failure message is read as an infrastructure class,
 * most specific first. Verified against Claude Code v2.1.220 (Aug 2026) —
 * these strings are version-volatile, so this is a table to extend, and
 * anything it does not match stays an ordinary task failure that the pipeline
 * feeds back as a round.
 */
const CLAUDE_FAILURE_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: HarnessFailureKind }> = [
  { pattern: /You've hit your (session|weekly|Opus|Sonnet) limit/i, kind: "usage-limit" },
  { pattern: /usage limit reached/i, kind: "usage-limit" },
  {
    pattern:
      /run \/login|not logged in|invalid api key|oauth token (expired|revoked)|could not be refreshed|authentication/i,
    kind: "needs-human",
  },
  { pattern: /credit balance is too low/i, kind: "needs-human" },
  {
    pattern: /unable to connect|connection error|ECONN|ETIMEDOUT|ENOTFOUND|timed out|overloaded/i,
    kind: "outage",
  },
];

/** API statuses that mean "come back later", not "your request was wrong". */
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_OVERLOADED = 529;
const CLAUDE_OUTAGE_STATUSES = new Set([HTTP_INTERNAL_SERVER_ERROR, HTTP_OVERLOADED]);
/** Legacy raw-API form: the reset instant after a pipe, in epoch seconds. */
const CLAUDE_LEGACY_RESET = /usage limit reached\|(\d+)/i;
/** The only machine-free form the CLI prints: `resets 3:45pm`, `resets Mon 12:00am`. */
const CLAUDE_RESETS_AT = /resets\s+([^.\n]+)/i;
const MS_PER_SECOND = 1_000;
/** Failure text quoted into a pause banner — one line, terminal-width-ish. */
const MAX_FAILURE_DETAIL_CHARS = 160;

function failureDetail(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  return line.trim().slice(0, MAX_FAILURE_DETAIL_CHARS);
}

function claudeResetTime(text: string, nowMs: number): number | null {
  const legacy = CLAUDE_LEGACY_RESET.exec(text);
  if (legacy?.[1] !== undefined) {
    const resetsAtMs = Number(legacy[1]) * MS_PER_SECOND;
    return resetsAtMs > nowMs ? resetsAtMs : null;
  }
  const resets = CLAUDE_RESETS_AT.exec(text);
  return resets?.[1] === undefined ? null : parseResetTime(resets[1], nowMs);
}

/**
 * Classify a failed Claude session. `apiErrorStatus` is the `api_error_status`
 * the result line carried, or null when there was none — a connection error,
 * or a failure that never reached the API at all.
 */
export function classifyClaudeFailure(
  text: string,
  apiErrorStatus: number | null,
  nowMs: number,
): HarnessFailure | undefined {
  const matched = CLAUDE_FAILURE_PATTERNS.find((entry) => entry.pattern.test(text));
  const kind =
    matched?.kind ??
    (apiErrorStatus !== null && CLAUDE_OUTAGE_STATUSES.has(apiErrorStatus) ? "outage" : null);
  if (kind === null) return undefined;
  const detail = failureDetail(text);
  return kind === "usage-limit"
    ? { kind, resetsAtMs: claudeResetTime(text, nowMs), detail }
    : { kind, detail };
}

type ClaudeContentBlock = NonNullable<NonNullable<ClaudeStreamLine["message"]>["content"]>[number];

/** Whatever the subprocess wrote, it is untrusted text — a bad line is simply not an event. */
function parseStreamLine(line: string): ClaudeStreamLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeStreamLine) : null;
  } catch {
    // Partial or non-JSON output (progress noise, a truncated final line).
    return null;
  }
}

function mapAssistantBlock(block: ClaudeContentBlock): HarnessEvent[] {
  if (block.type === "text" && block.text) return [{ type: "text", text: block.text }];
  if (block.type === "tool_use" && block.name) {
    const detail = summarizeInput(block.input);
    return [{ type: "tool", name: block.name, ...(detail ? { detail } : {}) }];
  }
  return [];
}

/** The `result` line as a result event: ok/failure classification plus usage. */
function mapResultLine(parsed: ClaudeStreamLine): HarnessEvent {
  const text = parsed.result ?? "";
  const isOk = parsed.subtype === "success" && !parsed.is_error;
  // An API-level failure arrives as subtype "success" with is_error set — the
  // subtype describes the CLI's turn, not the provider's answer.
  const failure = isOk
    ? undefined
    : classifyClaudeFailure(text, parsed.api_error_status ?? null, Date.now());
  const usage = claudeUsage(parsed);
  return {
    type: "result",
    ok: isOk,
    text,
    ...(failure ? { failure } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Map one stream-json line to harness events. */
export function mapClaudeLine(line: string): HarnessEvent[] {
  const parsed = parseStreamLine(line);
  if (parsed === null) return [];
  if (parsed.type === "assistant") {
    return (parsed.message?.content ?? []).flatMap(mapAssistantBlock);
  }
  // A continued session gets a fresh id, so the init line and the result line
  // both report it; the last one seen wins.
  if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
    return [{ type: "session", sessionId: parsed.session_id }];
  }
  if (parsed.type === "result") {
    const events: HarnessEvent[] = [];
    if (parsed.session_id) events.push({ type: "session", sessionId: parsed.session_id });
    events.push(mapResultLine(parsed));
    return events;
  }
  return [];
}

function summarizeInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ["file_path", "command", "path", "pattern", "description"]) {
    const value = fields[key];
    if (typeof value === "string")
      return value.length > MAX_TOOL_DETAIL_CHARS
        ? `${value.slice(0, MAX_TOOL_DETAIL_CHARS - ELLIPSIS.length)}${ELLIPSIS}`
        : value;
  }
  return undefined;
}

/**
 * Harness implementation running `claude -p` headless with stream-json output,
 * spawned in the ticket's worktree.
 */
export class ClaudeHarness implements Harness {
  readonly name = "claude";

  constructor(
    private readonly selection: HarnessSelection,
    private readonly permissionMode: PermissionMode,
    private readonly executable: string = "claude",
  ) {}

  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession {
    const args = [
      "-p",
      promptSpec.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...claudePermissionArgs(this.permissionMode),
      ...claudeSelectionArgs(this.selection),
    ];
    if (options.continueSessionId) args.push("--resume", options.continueSessionId);
    // Per-project hook config (PostToolUse formatter etc.), scoped to
    // JFDI-spawned sessions only — never the target project's own .claude/.
    const settingsPath = path.join(options.cwd, ".jfdi", "claude-settings.json");
    if (existsSync(settingsPath)) args.push("--settings", settingsPath);
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
    let result: HarnessResult | null = null;
    let resultFailure: HarnessFailure | undefined;
    let sessionId: string | undefined;

    const push = (event: HarnessEvent) => {
      queue.push(event);
      notify?.();
    };

    const stdoutLines = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : null;
    stdoutLines?.on("line", (line) => {
      log?.write(`${line}\n`);
      for (const event of mapClaudeLine(line)) {
        if (event.type === "session") sessionId = event.sessionId;
        if (event.type === "result") {
          result = {
            ok: event.ok,
            text: event.text,
            exitCode: 0,
            ...(event.usage ? { usage: event.usage } : {}),
          };
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
          exitCode: EXIT_COMMAND_NOT_EXECUTABLE,
        });
        notify?.();
      });
      child.on("close", (code) => {
        hasEnded = true;
        log?.end();
        const closed: HarnessResult =
          result && code === 0
            ? { ...result, exitCode: 0 }
            : {
                ok: false,
                text: result?.text ?? exitText(code, stderrTail),
                exitCode: code ?? 1,
              };
        // A session that died before any result line leaves its only evidence
        // in stderr, so the exit text is classified too, not just the result.
        const failure =
          closed.ok === false
            ? (resultFailure ?? classifyClaudeFailure(closed.text, null, Date.now()))
            : undefined;
        resolve(withSession(failure ? { ...closed, failure } : closed, sessionId));
        notify?.();
      });
    });

    const events: AsyncIterable<HarnessEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HarnessEvent>> {
            // Unbounded but never hot: each pass either takes a queued event,
            // reports the stream closed, or awaits the next `notify` — and the
            // subprocess's close/error handler always sets hasEnded.
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

  spawnInteractive(promptSpec: PromptSpec, options: InteractiveSpawnOptions): Promise<number> {
    // Both flags are session-scoped on the interactive CLI too, so an
    // interactive launch runs the same agent the implementation stage would.
    const args = [
      ...claudePermissionArgs(this.permissionMode),
      ...claudeSelectionArgs(this.selection),
      ...(options.isSystemPrompt ? ["--append-system-prompt"] : []),
      promptSpec.prompt,
    ];
    const child = spawn(this.executable, args, { cwd: options.cwd, stdio: "inherit" });
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
      console.error(spawnFailureText(executable, selection, error.message));
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
