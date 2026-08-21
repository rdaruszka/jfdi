/**
 * Acceptance for "malformed history.json blocks with a warning — never a silent
 * discard", driven through the built CLI.
 *
 * `history.json` is written atomically by the tool alone, so a parse failure or
 * an entry that violates the shape means an outside hand or a real bug — never
 * something to paper over with an empty history. The unit tests cover the loader
 * in isolation; this exercises the whole dispatch decision the ticket is about:
 * a re-dispatch that inherits a corrupt prior-run file must block the card with
 * an actionable comment and a runtime error event, spawn no agent session, and
 * stay blocked until a human fixes or deletes the file.
 *
 * It drives `dist/index.js` in a scratch repo under the OS temp dir with a stub
 * agent on PATH — no real agent CLI is ever spawned, and `JFDI_HOME`/`HOME`
 * point inside the scratch tree so nothing reaches the real `~/.jfdi`. "No
 * dispatch" is observed from outside the process as "the stub wrote no prompt
 * file for that run"; the block's recipe is observed in the ticket note.
 */
import { execFile } from "node:child_process";
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

/**
 * The agent both stubbed CLIs play. It replays the stream-json the harness
 * parses, records each prompt it was handed (so a test can assert what the agent
 * saw, and that it was invoked at all), and writes the verdict its prompt names.
 * STUB_REVIEW_FEEDBACK makes Code Review refuse (with that text) so a run burns
 * its rounds and blocks — persisting real feedback for the next dispatch to
 * inherit; without it review passes and the run completes.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
const promptDirectory = process.env.STUB_PROMPT_DIRECTORY;
fs.mkdirSync(promptDirectory, { recursive: true });
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
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
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-malformed-"));
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

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

function runDirectoryOf(sandbox: Sandbox, ticketId: string, runNumber: number): string {
  return path.join(sandbox.stateDirectory, "runs", ticketId, `run-${runNumber}`);
}

function historyPathOf(sandbox: Sandbox, ticketId: string, runNumber: number): string {
  return path.join(runDirectoryOf(sandbox, ticketId, runNumber), "history.json");
}

/** Notes live under the project's .jfdi/tickets (init --bare scaffolds it). */
function ticketNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.projectRoot, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
}

async function errorEvents(sandbox: Sandbox): Promise<Array<Record<string, unknown>>> {
  const raw = await fs
    .readFile(path.join(sandbox.stateDirectory, "events.jsonl"), "utf8")
    .catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === "error");
}

function promptFilesFor(sandbox: Sandbox, subdirectory: string): Promise<string[]> {
  return fs.readdir(path.join(sandbox.promptDirectory, subdirectory)).catch(() => [] as string[]);
}

async function initProject(sandbox: Sandbox): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("malformed feedback history blocks the re-dispatch", () => {
  it(
    "blocks with the recipe, dispatches nothing, and resumes once the file is repaired",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Run 1: absent history (first run) dispatches normally; Code Review
      // refuses every round, so the run burns its rounds and blocks, leaving
      // real feedback persisted in run-1/history.json for the next dispatch.
      const run1 = await runCli(sandbox, ["run", "Fix the history"], {
        reviewFeedback: "run-1 review feedback",
        tag: "one",
        promptSubdirectory: "run1",
      });
      expect(run1.code).toBe(2);
      const ticketId = ticketIdOf(run1);
      // Absent-file behavior unchanged: the first run really dispatched agents.
      expect(await promptFilesFor(sandbox, "run1")).toContain("implementation-0.txt");
      const run1History = historyPathOf(sandbox, ticketId, 1);
      expect(await fs.readFile(run1History, "utf8")).toContain("run-1 review feedback");

      // Corrupt the prior run's history with a shape violation: feedback is a
      // number, not a string. saveFeedbackHistory could never write this — only
      // an outside hand or a bug could.
      const offendingEntry = { run: 1, round: 1, source: "qa", feedback: 17 };
      await fs.writeFile(run1History, JSON.stringify([offendingEntry]));

      // Run 2: the malformed inherited file must stop the dispatch cold. Review
      // would pass here, but the run must never reach it.
      const run2 = await runCli(sandbox, ["run", "Fix the history"], {
        tag: "two",
        promptSubdirectory: "run2",
      });
      expect(run2.code).toBe(2);

      // Nothing was dispatched: the stub wrote no prompt for run 2.
      expect(await promptFilesFor(sandbox, "run2")).toEqual([]);
      // The next run directory was never created — re-dragging just re-blocks.
      await expect(fs.access(runDirectoryOf(sandbox, ticketId, 2))).rejects.toThrow();

      // Runtime-loud: an error event names the offending file.
      const errors = await errorEvents(sandbox);
      expect(errors.length).toBeGreaterThan(0);
      const errorData = errors.at(-1)?.data as Record<string, unknown> | undefined;
      expect(String(errorData?.filePath ?? errorData?.message)).toContain(run1History);

      // The block's comment carries the file, the offending content, and both
      // ways forward.
      const note = await ticketNote(sandbox, ticketId);
      expect(note).toContain(`Malformed feedback history at ${run1History}`);
      expect(note).toContain('"feedback": 17');
      expect(note).toContain("Fix the file to resume with its feedback intact");
      expect(note).toContain("delete it to deliberately resume without history");

      // Repair: replace the corrupt file with valid feedback items. This is the
      // "fix the file to resume with feedback intact" path.
      const repaired = [
        { run: 1, round: 1, source: "code-review", feedback: "REPAIR-A keep the public API" },
        { run: 1, round: 2, source: "qa", feedback: "REPAIR-B cover the resumed path" },
      ];
      await fs.writeFile(run1History, JSON.stringify(repaired));

      // Run 3: review passes now, so the run completes — and the resumed agent's
      // implementation prompt carries the full repaired history, intact.
      const run3 = await runCli(sandbox, ["run", "Fix the history"], {
        tag: "three",
        promptSubdirectory: "run3",
      });
      expect(run3.code).toBe(0);
      const resumedPrompt = await fs.readFile(
        path.join(sandbox.promptDirectory, "run3", "implementation-0.txt"),
        "utf8",
      );
      expect(resumedPrompt).toContain("REPAIR-A keep the public API");
      expect(resumedPrompt).toContain("REPAIR-B cover the resumed path");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "does not mistake a cleanly-finished run's empty history for corruption",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Run 1: block to obtain a prior run directory and the ticket id.
      const run1 = await runCli(sandbox, ["run", "Empty history"], {
        reviewFeedback: "run-1 review feedback",
        tag: "one",
        promptSubdirectory: "run1",
      });
      expect(run1.code).toBe(2);
      const ticketId = ticketIdOf(run1);

      // A finished run persists an empty array. That is a legitimate clean
      // hand-off, not a malformed file: the re-dispatch must proceed, not block.
      await fs.writeFile(historyPathOf(sandbox, ticketId, 1), "[]\n");

      const run2 = await runCli(sandbox, ["run", "Empty history"], {
        tag: "two",
        promptSubdirectory: "run2",
      });
      expect(run2.code).toBe(0);
      // It really ran: the agent was dispatched despite the empty prior history.
      expect(await promptFilesFor(sandbox, "run2")).toContain("implementation-0.txt");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
