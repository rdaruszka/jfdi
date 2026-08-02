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
  PromptSpec,
  SpawnOptions,
} from "./types.js";

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
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
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

/** Map one stream-json line to harness events. */
export function mapClaudeLine(line: string): HarnessEvent[] {
  const parsed = parseStreamLine(line);
  if (parsed === null) return [];
  if (parsed.type === "assistant") {
    return (parsed.message?.content ?? []).flatMap(mapAssistantBlock);
  }
  if (parsed.type === "result") {
    return [
      {
        type: "result",
        ok: parsed.subtype === "success" && !parsed.is_error,
        text: parsed.result ?? "",
      },
    ];
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
    private readonly extraArgs: string[] = [],
    private readonly executable: string = "claude",
  ) {}

  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession {
    const args = [
      "-p",
      promptSpec.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.extraArgs,
    ];
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
        if (event.type === "result") result = { ok: event.ok, text: event.text, exitCode: 0 };
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
        if (result && code === 0) {
          resolve({ ...result, exitCode: 0 });
        } else {
          resolve({
            ok: false,
            text:
              result?.text ??
              `harness exited with code ${code ?? "?"}${stderrTail ? `\nstderr: ${stderrTail.trim()}` : ""}`,
            exitCode: code ?? 1,
          });
        }
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
}

function openLog(logPath: string) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return createWriteStream(logPath, { flags: "a" });
}
