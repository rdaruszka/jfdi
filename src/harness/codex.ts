import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { EXIT_COMMAND_NOT_EXECUTABLE } from "../util/exit-codes.js";
import { parseResetTime } from "./reset-time.js";
import type {
  Harness,
  HarnessEvent,
  HarnessFailure,
  HarnessFailureKind,
  HarnessResult,
  HarnessSession,
  InteractiveSpawnOptions,
  PromptSpec,
  SpawnOptions,
} from "./types.js";

const STDERR_TAIL_CHARS = 4_000;
const SIGKILL_DELAY_MS = 5_000;
const MAX_TOOL_DETAIL_CHARS = 80;
const ELLIPSIS = "...";

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
/** Failure text quoted into a pause banner — one line, terminal-width-ish. */
const MAX_FAILURE_DETAIL_CHARS = 160;

/**
 * A session that never announced its thread did not run at all — the
 * detached-TTY regression (openai/codex#19945). Nothing in the exit code says
 * so, so the absence of `thread.started` is the signal.
 */
const CODEX_NO_THREAD_DETAIL = "codex exited without starting a thread";

function failureDetail(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  return line.trim().slice(0, MAX_FAILURE_DETAIL_CHARS);
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
}

function parseStreamLine(line: string): CodexStreamLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as CodexStreamLine) : null;
  } catch {
    return null;
  }
}

function truncateDetail(detail: string): string {
  return detail.length > MAX_TOOL_DETAIL_CHARS
    ? `${detail.slice(0, MAX_TOOL_DETAIL_CHARS - ELLIPSIS.length)}${ELLIPSIS}`
    : detail;
}

/** Map one `codex exec --json` line to provider-neutral progress events. */
export function mapCodexLine(line: string): HarnessEvent[] {
  const parsed = parseStreamLine(line);
  if (parsed === null) return [];
  // The thread id is what `codex exec resume <id>` continues later.
  if (parsed.type === "thread.started" && parsed.thread_id) {
    return [{ type: "session", sessionId: parsed.thread_id }];
  }
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
    return [{ type: "tool", name: "command", detail: truncateDetail(item.command) }];
  }
  if (item?.type === "mcp_tool_call" && item.tool) {
    const name = item.server ? `${item.server}.${item.tool}` : item.tool;
    return [{ type: "tool", name }];
  }
  if (item?.type === "web_search" && item.query) {
    return [{ type: "tool", name: "web_search", detail: truncateDetail(item.query) }];
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
    ? { ok: true, text: finalText, exitCode: 0 }
    : {
        ok: false,
        text: failureText ?? exitText(exitCode, stderrTail),
        exitCode: exitCode ?? 1,
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
  readonly name = "codex";

  constructor(private readonly executable: string = "codex") {}

  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession {
    // `codex exec resume <thread-id> <prompt>` continues an earlier thread.
    const args = options.continueSessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          options.continueSessionId,
          promptSpec.prompt,
        ]
      : ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", promptSpec.prompt];
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
    const push = (event: HarnessEvent) => {
      queue.push(event);
      notify?.();
    };

    const stdoutLines = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : null;
    stdoutLines?.on("line", (line) => {
      log?.write(`${line}\n`);
      for (const event of mapCodexLine(line)) {
        if (event.type === "session") sessionId = event.sessionId;
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
          text: `failed to spawn ${this.executable}: ${error.message}`,
          exitCode: EXIT_COMMAND_NOT_EXECUTABLE,
        });
        notify?.();
      });
      child.on("close", (code) => {
        hasEnded = true;
        log?.end();
        const closed = closedResult(code, finalText, failureText, stderrTail);
        if (closed.ok) push({ type: "result", ok: true, text: closed.text });
        const failure = closed.ok
          ? undefined
          : (resultFailure ?? closeFailure(closed.text, sessionId !== undefined));
        resolve(withSession(failure ? { ...closed, failure } : closed, sessionId));
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

  spawnInteractive(promptSpec: PromptSpec, options: InteractiveSpawnOptions): Promise<number> {
    const child = spawn(
      this.executable,
      ["--dangerously-bypass-approvals-and-sandbox", promptSpec.prompt],
      { cwd: options.cwd, stdio: "inherit" },
    );
    return interactiveResult(child, this.executable);
  }
}

function interactiveResult(child: ChildProcess, executable: string): Promise<number> {
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`failed to launch ${executable}: ${error.message}`);
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
