import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { EXIT_COMMAND_NOT_EXECUTABLE } from "../util/exit-codes.js";
import type {
  Harness,
  HarnessEvent,
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
  if (parsed.type === "turn.failed" || parsed.type === "error") {
    const text = parsed.error?.message ?? parsed.message ?? "Codex session failed";
    return [{ type: "result", ok: false, text }];
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
        if (event.type === "result" && !event.ok) failureText = event.text;
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
        const isSuccess = code === 0 && finalText !== "" && failureText === null;
        if (isSuccess) push({ type: "result", ok: true, text: finalText });
        const closed: HarnessResult = isSuccess
          ? { ok: true, text: finalText, exitCode: 0 }
          : {
              ok: false,
              text: failureText ?? exitText(code, stderrTail),
              exitCode: code ?? 1,
            };
        resolve(withSession(closed, sessionId));
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
