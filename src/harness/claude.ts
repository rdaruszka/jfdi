import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
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

/** Map one stream-json line to harness events. */
export function mapClaudeLine(line: string): HarnessEvent[] {
  let parsed: ClaudeStreamLine;
  try {
    parsed = JSON.parse(line) as ClaudeStreamLine;
  } catch {
    return [];
  }
  const events: HarnessEvent[] = [];
  if (parsed.type === "assistant") {
    for (const block of parsed.message?.content ?? []) {
      if (block.type === "text" && block.text) events.push({ type: "text", text: block.text });
      if (block.type === "tool_use" && block.name) {
        const detail = summarizeInput(block.input);
        events.push({ type: "tool", name: block.name, ...(detail ? { detail } : {}) });
      }
    }
  } else if (parsed.type === "result") {
    events.push({
      type: "result",
      ok: parsed.subtype === "success" && !parsed.is_error,
      text: parsed.result ?? "",
    });
  }
  return events;
}

function summarizeInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "command", "path", "pattern", "description"]) {
    const v = rec[key];
    if (typeof v === "string")
      return v.length > MAX_TOOL_DETAIL_CHARS
        ? `${v.slice(0, MAX_TOOL_DETAIL_CHARS - ELLIPSIS.length)}${ELLIPSIS}`
        : v;
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

  spawn(spec: PromptSpec, opts: SpawnOptions): HarnessSession {
    const args = [
      "-p",
      spec.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.extraArgs,
    ];
    const child: ChildProcess = spawn(this.executable, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const log = opts.logPath ? openLog(opts.logPath) : null;
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-STDERR_TAIL_CHARS);
      log?.write(s);
    });

    const queue: HarnessEvent[] = [];
    let notify: (() => void) | null = null;
    let ended = false;
    let result: HarnessResult | null = null;

    const push = (evt: HarnessEvent) => {
      queue.push(evt);
      notify?.();
    };

    const rl = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : null;
    rl?.on("line", (line) => {
      log?.write(`${line}\n`);
      for (const evt of mapClaudeLine(line)) {
        if (evt.type === "result") result = { ok: evt.ok, text: evt.text, exitCode: 0 };
        push(evt);
      }
    });

    const done = new Promise<HarnessResult>((resolve) => {
      child.on("error", (err) => {
        ended = true;
        log?.end();
        resolve({
          ok: false,
          text: `failed to spawn ${this.executable}: ${err.message}`,
          exitCode: 127,
        });
        notify?.();
      });
      child.on("close", (code) => {
        ended = true;
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
            for (;;) {
              const evt = queue.shift();
              if (evt) return { value: evt, done: false };
              if (ended) return { value: undefined, done: true };
              await new Promise<void>((r) => {
                notify = r;
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
