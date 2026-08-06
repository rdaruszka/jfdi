/** Shared test fixtures (excluded from the build). */
import {
  type ChildProcess,
  type SpawnOptions as ChildProcessSpawnOptions,
  spawn,
} from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig, type JfdiConfig } from "./config.js";
import { EventLog } from "./events.js";
import { git } from "./git.js";
import type {
  Harness,
  HarnessEvent,
  HarnessFailure,
  HarnessResult,
  HarnessSession,
  SessionKind,
  SessionUsage,
  SpawnOptions,
} from "./harness/types.js";
import { PauseController, type PauseDelays } from "./pause.js";
import type { PipelineContext } from "./pipeline.js";
import { UsageRegistry } from "./usage.js";

const TEST_TERMINAL_COLUMNS = 80;
const TEST_TERMINAL_ROWS = 24;

const TTY_CLI_LAUNCHER = `
import { pathToFileURL } from "node:url";
Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { value: ${TEST_TERMINAL_COLUMNS} },
  rows: { value: ${TEST_TERMINAL_ROWS} },
});
Object.defineProperty(process.stdin, "isTTY", { value: true });
process.stdin.setRawMode = () => process.stdin;
const cliPath = process.env.JFDI_TEST_CLI_PATH;
const args = JSON.parse(process.env.JFDI_TEST_CLI_ARGS ?? "[]");
process.argv = [process.execPath, cliPath, ...args];
await import(pathToFileURL(cliPath).href);
`;

/** Spawn the built CLI with test pipes presented to Ink as a terminal. */
export function spawnTtyCli(
  cliPath: string,
  args: string[],
  options: ChildProcessSpawnOptions = {},
): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "--eval", TTY_CLI_LAUNCHER], {
    ...options,
    env: {
      ...(options.env ?? process.env),
      JFDI_TEST_CLI_ARGS: JSON.stringify(args),
      JFDI_TEST_CLI_PATH: cliPath,
    },
  });
}

export type FakeHandler = (
  prompt: string,
  options: SpawnOptions,
) => Promise<{
  ok: boolean;
  text: string;
  sessionId?: string;
  failure?: HarnessFailure;
  /** Optional progress events emitted before the result. */
  events?: HarnessEvent[];
  /** Optional usage a test can pin, so cost/token assertions stay deterministic. */
  usage?: SessionUsage;
}>;

/**
 * In-process harness for tests: the handler plays the agent, performing side
 * effects (writing files, committing, dropping verdict files) directly.
 */
export class FakeHarness implements Harness {
  readonly calls: Array<{ prompt: string; options: SpawnOptions }> = [];

  constructor(private readonly handler: FakeHandler) {}

  spawn(prompt: string, options: SpawnOptions): HarnessSession {
    this.calls.push({ prompt, options });
    let resolveDone: (result: HarnessResult) => void = () => {
      // Placeholder; replaced synchronously by the Promise executor below.
    };
    const done = new Promise<HarnessResult>((resolve) => {
      resolveDone = resolve;
    });
    const events: HarnessEvent[] = [];
    const run = this.handler(prompt, options)
      .then((result) => {
        const { events: progressEvents = [], ...harnessResult } = result;
        events.push(...progressEvents);
        events.push({
          type: "result",
          ok: result.ok,
          text: result.text,
          ...(result.usage ? { usage: result.usage } : {}),
        });
        resolveDone(harnessResult);
      })
      .catch((error: Error) => {
        resolveDone({ ok: false, text: error.message });
      });

    return {
      events: (async function* () {
        await run;
        yield* events;
      })(),
      done,
      kill: () => {
        // Nothing to kill — the fake resolves from an in-process handler.
      },
    };
  }

  spawnInteractive(): Promise<number> {
    return Promise.resolve(0);
  }
}

/**
 * Pause waits, shrunk to the millisecond scale. The real schedule is measured
 * in minutes; a test asserting that a held stage re-runs should not wait one.
 */
export const TEST_PAUSE_DELAYS: PauseDelays = {
  outageStageRetryMs: [5, 10, 20],
  probeMs: [10, 20, 40],
  usageLimitBufferMs: 0,
  maxWaitMs: 60_000,
};

export interface WaitForOptions {
  timeoutMs: number;
  intervalMs: number;
  describe: () => string | Promise<string>;
}

/**
 * Poll when a test is waiting for a condition to become true. A bounded settle
 * is still correct when proving a non-event, such as a process staying alive or
 * a card staying put, because there is no positive condition to end that wait.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs, intervalMs, describe }: WaitForOptions,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`cannot wait with timeoutMs ${timeoutMs}; use a finite non-negative duration`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`cannot wait with intervalMs ${intervalMs}; use a finite positive duration`);
  }

  const attemptLimit = Math.ceil(timeoutMs / intervalMs) + 1;
  const deadlineMs = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    if (await condition()) return;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }
  throw new Error(`waited ${timeoutMs}ms for ${await describe()}`);
}

export interface Fixture {
  root: string;
  repo: string;
  jfdiDir: string;
  /** Stand-in for ~/.jfdi/projects/<key>/ — outside the repo, like the real one. */
  stateDir: string;
  ticketsDir: string;
  config: JfdiConfig;
  context: (
    handler: FakeHandler,
    options?: ContextOptions,
  ) => PipelineContext & { harness: FakeHarness; scribe: FakeHarness };
  cleanup: () => Promise<void>;
}

export interface ContextOptions {
  /** Write events.jsonl/state.json, as a real run does — for cross-process tests. */
  shouldPersistEvents?: boolean;
  /** Play the scribe. The default writes a plausible subject and body. */
  scribeHandler?: FakeHandler;
}

/**
 * The scribe every fixture gets unless a test installs its own: it writes the
 * session's own summary as the subject, which is what a real scribe does with
 * it. It stands behind its own fake, so a test's stage handler never has to
 * know the pipeline asks for a message after each code-producing session.
 */
export const DEFAULT_SCRIBE_HANDLER: FakeHandler = (prompt) => {
  const summary = /## What the session said it did\n\n(.*)/.exec(prompt)?.[1] ?? "";
  const subject = summary.startsWith("(") || summary === "" ? "the session's work" : summary;
  return Promise.resolve({ ok: true, text: `${subject}\n\nWritten by the scribe.` });
};

/** Scratch repo under the OS temp dir — never inside a parent git repo. */
export async function makeFixture(configOverrides: Partial<JfdiConfig> = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-pipe-"));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@jfdi.local");
  await git(repo, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(repo, "README.md"), "product\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial");

  const jfdiDir = path.join(repo, ".jfdi");
  const ticketsDir = path.join(jfdiDir, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  const stateDir = path.join(root, "state");
  const config: JfdiConfig = { ...defaultConfig(), gate: [], ...configOverrides };

  return {
    root,
    repo,
    jfdiDir,
    stateDir,
    ticketsDir,
    config,
    context: (handler, options = {}) => {
      const harness = new FakeHarness(handler);
      const scribe = new FakeHarness(options.scribeHandler ?? DEFAULT_SCRIBE_HANDLER);
      const log = new EventLog(stateDir, options.shouldPersistEvents ?? false);
      return {
        repoRoot: repo,
        jfdiDir,
        stateDir,
        config,
        // One fake behind every stage, so `harness.calls` sees the whole run.
        // Tests about per-stage routing install distinct fakes themselves. The
        // scribe stands apart: it runs after every code-producing session, and
        // folding it into the stage handler would put a commit message in front
        // of every test that only cares about stages.
        harnesses: {
          implementation: harness,
          "code-review": harness,
          qa: harness,
          integration: harness,
          "commit-message": scribe,
        },
        harness,
        scribe,
        log,
        pause: new PauseController(log, TEST_PAUSE_DELAYS),
        usage: new UsageRegistry(),
      };
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/**
 * A `PipelineContext.now` that advances a fixed step on each call, so a session
 * (one start read, one end read) always measures `stepMs` of wall-clock — time
 * pinned without a real clock or a sleep.
 */
export function steppingClock(stepMs: number): () => number {
  let ticks = 0;
  return () => {
    const value = ticks * stepMs;
    ticks += 1;
    return value;
  };
}

/** A `SessionUsage` for a fake handler to return, so cost/token assertions are deterministic. */
export function usageFor(
  costUsd: number | null,
  tokens: { input?: number; cachedInput?: number; output?: number } = {},
): SessionUsage {
  return {
    durationMs: 0,
    costUsd,
    inputTokens: tokens.input ?? 0,
    cachedInputTokens: tokens.cachedInput ?? 0,
    outputTokens: tokens.output ?? 0,
  };
}

/** Which `stages` entry a prompt belongs to (matched on each default's task statement). */
export function sessionKindOf(prompt: string): SessionKind {
  if (prompt.startsWith("Output does not meet spec:")) {
    if (prompt.includes("/implementation.verdict.json")) return "implementation";
    if (prompt.includes("/code-review.verdict.json")) return "code-review";
    if (prompt.includes("/qa.verdict.json")) return "qa";
  }
  if (prompt.includes("Write the commit message")) return "commit-message";
  if (prompt.includes("Implement the ticket below completely")) return "implementation";
  if (prompt.includes("Your implementation session is being continued")) return "implementation";
  if (prompt.includes("pure code standpoint")) return "code-review";
  if (prompt.includes("Your code-review session is being continued")) return "code-review";
  if (prompt.includes("Derive your checks from the ticket")) return "qa";
  if (prompt.includes("Your QA session is being continued")) return "qa";
  if (prompt.includes("has hit conflicts")) return "integration";
  throw new Error(`cannot determine the session kind from prompt: ${prompt.slice(0, 100)}`);
}

/** Pull the verdict file path out of a rendered prompt. */
export function verdictPathOf(prompt: string): string {
  const match = /(\/\S+\.verdict\.json)/.exec(prompt);
  if (!match?.[1]) throw new Error("no verdict path in prompt");
  return match[1];
}

export async function writeVerdict(prompt: string, verdict: object): Promise<void> {
  await fs.writeFile(verdictPathOf(prompt), JSON.stringify(verdict));
}

export async function commitFile(
  cwd: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), content);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}
