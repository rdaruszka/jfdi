/**
 * Acceptance for the crash-shaped hole in feedback carry, driven through the
 * built CLI.
 *
 * The resume machinery's promise is "carry the why across interruption." The
 * unit tests cover the persistence primitive in isolation; the existing resume
 * lifecycle e2e covers a *clean* re-dispatch. Neither exercises the failure the
 * ticket names: a run inherits a prior run's feedback, retries, and the process
 * dies between persisted rounds — after which resume reads exactly one run back
 * and must still surface the *original* feedback.
 *
 * This drives `dist/index.js` in a scratch repo under the OS temp dir with a
 * stub agent on PATH, and asserts on what the resumed agent can actually see in
 * its prompt — the only place "the feedback survived the crash" is observable
 * from outside the process. A real SIGKILL between run 2's persisted round 1 and
 * its round 2 stands in for the coordinator death.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here reaches
 * the real `~/.jfdi`, and the stub guarantees no real agent CLI is spawned.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const projectRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(projectRoot, "dist", "index.js");

const PIPELINE_TIMEOUT_MS = 120_000;
const KILL_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 100;

/**
 * The agent both stubbed CLIs play. It replays the stream-json the harness
 * parses, records each prompt it was handed, and writes the verdict its prompt
 * names. Two knobs drive the crash scenario: STUB_REVIEW_FEEDBACK makes Code
 * Review refuse (with that text) so the run keeps retrying, and
 * STUB_HANG_IMPLEMENTATION_FROM_INDEX freezes the implementation session from a given
 * round onward, so the test can SIGKILL the CLI at a controlled point instead
 * of racing it to completion. The hang is bounded, not infinite, so an orphan
 * left by the kill self-terminates rather than lingering.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
const promptDirectory = process.env.STUB_PROMPT_DIRECTORY;
fs.mkdirSync(promptDirectory, { recursive: true });
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const HANG_MS = 20000;
function sleepThenExit() {
  // Bounded: a SIGKILL of the parent orphans this; the timer lets it die on its
  // own so no stray agent process survives the test.
  setTimeout(() => process.exit(0), HANG_MS);
}
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (!match) {
  // The scribe: no verdict file, its result text becomes the commit subject.
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
  return;
}
const verdictPath = match[1];
const stage = path.basename(verdictPath).replace(".verdict.json", "");
let index = 0;
while (fs.existsSync(path.join(promptDirectory, stage + "-" + index + ".txt"))) index += 1;
fs.writeFileSync(path.join(promptDirectory, stage + "-" + index + ".txt"), prompt);
let verdict;
if (stage === "implementation") {
  const hangFrom = process.env.STUB_HANG_IMPLEMENTATION_FROM_INDEX;
  if (hangFrom !== undefined && index >= Number(hangFrom)) {
    sleepThenExit();
    return;
  }
  fs.appendFileSync(path.join(process.cwd(), "feature.txt"), process.env.STUB_TAG + "-" + index + "\\n");
  verdict = { status: "done", summary: "implemented " + process.env.STUB_TAG };
} else if (stage === "code-review") {
  const feedback = process.env.STUB_REVIEW_FEEDBACK;
  verdict = feedback ? { verdict: "fail", feedback } : { verdict: "pass" };
} else if (stage === "integration") {
  verdict = { resolution: "clean" };
} else {
  verdict = { verdict: "pass" };
}
fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
fs.writeFileSync(verdictPath, JSON.stringify(verdict));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  stateDirectory: string;
  executableDirectory: string;
  promptDirectory: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-carry-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    projectRoot,
    home,
    jfdiHome,
    executableDirectory,
    promptDirectory: path.join(root, "prompts"),
    stateDirectory: path.join(jfdiHome, "projects", projectRoot.split(path.sep).join("-")),
  };
}

interface StubOptions {
  reviewFeedback?: string;
  hangImplementationFromIndex?: number;
  tag?: string;
  promptSubdirectory?: string;
}

function stubEnv(sandbox: Sandbox, options: StubOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_TAG: options.tag ?? "work",
    STUB_PROMPT_DIRECTORY: path.join(
      sandbox.promptDirectory,
      options.promptSubdirectory ?? "default",
    ),
    NO_COLOR: "1",
  };
  if (options.reviewFeedback !== undefined) env.STUB_REVIEW_FEEDBACK = options.reviewFeedback;
  if (options.hangImplementationFromIndex !== undefined)
    env.STUB_HANG_IMPLEMENTATION_FROM_INDEX = String(options.hangImplementationFromIndex);
  return env;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: StubOptions = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env: stubEnv(sandbox, options),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface LiveCli {
  child: ReturnType<typeof spawn>;
  output: () => string;
  exited: Promise<Ended>;
}

function spawnCli(sandbox: Sandbox, args: string[], options: StubOptions = {}): LiveCli {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: sandbox.projectRoot,
    env: stubEnv(sandbox, options),
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return {
    child,
    output: () => output,
    exited: new Promise<Ended>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
}

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

function readPrompt(sandbox: Sandbox, subdirectory: string, name: string): Promise<string> {
  return fs.readFile(path.join(sandbox.promptDirectory, subdirectory, name), "utf8");
}

function runHistoryPath(sandbox: Sandbox, ticketId: string, runNumber: number): string {
  return path.join(sandbox.stateDirectory, "runs", ticketId, `run-${runNumber}`, "history.json");
}

function readRunHistory(sandbox: Sandbox, ticketId: string, runNumber: number): Promise<string> {
  return fs.readFile(runHistoryPath(sandbox, ticketId, runNumber), "utf8").catch(() => "");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntil(isReady: () => Promise<boolean>, describe: () => string): Promise<void> {
  const deadline = Date.now() + KILL_DEADLINE_MS;
  // Terminates: the deadline shrinks the remaining time every pass.
  while (Date.now() < deadline) {
    if (await isReady()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(describe());
}

async function initProject(sandbox: Sandbox): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("feedback carry across a crash mid-retry", () => {
  const Run1Feedback = "original feedback from the first run";
  const Run2Feedback = "new feedback the retry itself produced";

  it(
    "resume after a crash between retry rounds still carries the original run's feedback",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Run 1: Code Review refuses every round, so the run burns its three
      // rounds and blocks — leaving its feedback persisted for the next
      // dispatch to inherit.
      const run1 = await runCli(sandbox, ["run", "Fix the carry"], {
        reviewFeedback: Run1Feedback,
        tag: "one",
        promptSubdirectory: "run1",
      });
      expect(run1.code).toBe(2);
      const ticketId = ticketIdOf(run1);

      // Run 2: inherits run 1's feedback, fails its own first round (persisting
      // the *combined* working set), then freezes in round 2 so the test can
      // kill it — a coordinator death between persisted retry rounds.
      const run2 = spawnCli(sandbox, ["run", "Fix the carry"], {
        reviewFeedback: Run2Feedback,
        hangImplementationFromIndex: 1,
        tag: "two",
        promptSubdirectory: "run2",
      });
      try {
        await waitUntil(
          async () => (await readRunHistory(sandbox, ticketId, 2)).includes(Run2Feedback),
          () => `run 2 never persisted its retry feedback. Output:\n${run2.output()}`,
        );
      } finally {
        run2.child.kill("SIGKILL");
      }
      const ended = await run2.exited;
      expect(ended.signal).toBe("SIGKILL");

      // The crash-time file is self-sufficient: reading it alone recovers both
      // the inherited feedback and the retry's own. This is what the fix added;
      // before it, run-2/history.json held only RUN2_FEEDBACK.
      const crashHistory = await readRunHistory(sandbox, ticketId, 2);
      expect(crashHistory).toContain(Run1Feedback);
      expect(crashHistory).toContain(Run2Feedback);

      // Run 3: resumes. It reads exactly one run back (run 2) — yet the original
      // run's feedback still reaches the agent's prompt, which is the whole
      // point. Its review now passes, so the run completes.
      const run3 = await runCli(sandbox, ["run", "Fix the carry"], {
        tag: "three",
        promptSubdirectory: "run3",
      });
      expect(run3.code).toBe(0);

      const resumedPrompt = await readPrompt(sandbox, "run3", "implementation-0.txt");
      expect(resumedPrompt).toContain(Run1Feedback);
      expect(resumedPrompt).toContain(Run2Feedback);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
