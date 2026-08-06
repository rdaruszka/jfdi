/**
 * Acceptance for run-directory allocation surviving a mid-sequence deletion,
 * driven through the built CLI.
 *
 * The ticket: `nextRunDir` derived the next run number from the *count* of
 * `run-<n>` directories, not their maximum. Delete `run-2` while `run-1` and
 * `run-3` exist and the next dispatch reused `run-3` — colliding with a
 * directory that still holds history and verdict files, overwriting the only
 * artifact class the state directory otherwise treats as append-forever, and
 * making `previous` point at the deleted `run-2` so prior history read empty.
 *
 * This drives `dist/index.js` in a scratch repo under the OS temp dir with a
 * stub agent on PATH. It runs a full dispatch (creating `run-1`), then plants a
 * `run-3` directory with sentinel artifacts and NO `run-2` — exactly the gap a
 * manual deletion leaves — and dispatches again. It asserts the new run lands
 * in `run-3 + 1` = `run-4`, that `run-3`'s planted history and verdict survive
 * byte-for-byte (the overwrite the ticket names), and that the fresh
 * implementation prompt carries `run-3`'s feedback (`previous` resolved to the
 * max, not the missing `run-2`).
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here reaches
 * the real `~/.jfdi`, and the stub guarantees no real agent CLI is spawned.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * The agent both stubbed CLIs play. It replays the stream-json the harness
 * parses, records each prompt it was handed under STUB_PROMPT_DIR, and writes
 * the verdict its prompt names. The implementation stage appends STUB_TAG so a
 * re-dispatch of the same ticket commits genuinely new content (the branch
 * already holds the prior run's commit), letting the second run pass cleanly.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const promptDir = process.env.STUB_PROMPT_DIR;
if (promptDir) fs.mkdirSync(promptDir, { recursive: true });
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (!match) {
  // The scribe: no verdict file, its result text becomes the commit subject.
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
  return;
}
const verdictPath = match[1];
const stage = path.basename(verdictPath).replace(".verdict.json", "");
if (promptDir) {
  let index = 0;
  while (fs.existsSync(path.join(promptDir, stage + "-" + index + ".txt"))) index += 1;
  fs.writeFileSync(path.join(promptDir, stage + "-" + index + ".txt"), prompt);
}
let verdict;
if (stage === "implementation") {
  fs.appendFileSync(path.join(process.cwd(), "feature.txt"), (process.env.STUB_TAG || "work") + "\\n");
  execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
  execFileSync("git", ["commit", "-m", "implement " + (process.env.STUB_TAG || "work")], { cwd: process.cwd() });
  verdict = { status: "done", summary: "implemented " + (process.env.STUB_TAG || "work") };
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
  project: string;
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
  promptDir: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-runmax-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(binDir, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    project,
    home,
    jfdiHome,
    binDir,
    promptDir: path.join(root, "prompts"),
    stateDir: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: { tag?: string; promptSubdir?: string } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_TAG: options.tag ?? "work",
    STUB_PROMPT_DIR: path.join(sandbox.promptDir, options.promptSubdir ?? "default"),
    NO_COLOR: "1",
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env,
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

function runsBase(sandbox: Sandbox, ticketId: string): string {
  return path.join(sandbox.stateDir, "runs", ticketId);
}

async function readdirSorted(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("run-directory allocation across a deleted middle run", () => {
  const PlantedRun3Feedback = "planted-run-3-review-feedback-sentinel";

  it(
    "allocates max index plus one, never overwriting a surviving run directory",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // Run 1: a full clean dispatch. This is the only way to learn the ticket
      // id and gives us a genuine run-1 on disk.
      const run1 = await runCli(sandbox, ["run", "Fix the widget alignment"], {
        tag: "one",
        promptSubdir: "run1",
      });
      expect(run1.code).toBe(0);
      const ticketId = ticketIdOf(run1);
      const base = runsBase(sandbox, ticketId);
      expect(await readdirSorted(base)).toContain("run-1");

      // Simulate a manual deletion in the middle of a longer sequence: plant a
      // run-3 that still holds append-forever artifacts, with NO run-2. The bug
      // would number the next dispatch by count (2 dirs → run-3) and collide.
      const run3 = path.join(base, "run-3");
      const run3History = path.join(run3, "history.json");
      const run3Verdict = path.join(run3, "round-1", "code-review.verdict.json");
      await fs.mkdir(path.join(run3, "round-1"), { recursive: true });
      await fs.writeFile(
        run3History,
        JSON.stringify([
          { run: 3, round: 1, source: "code-review", feedback: PlantedRun3Feedback },
        ]),
      );
      await fs.writeFile(run3Verdict, JSON.stringify({ verdict: "fail", feedback: "old run-3" }));
      const historyBefore = await fs.readFile(run3History, "utf8");
      const verdictBefore = await fs.readFile(run3Verdict, "utf8");

      // Run 2: re-dispatch the same ticket with the gap present.
      const run2 = await runCli(sandbox, ["run", "Fix the widget alignment"], {
        tag: "two",
        promptSubdir: "run2",
      });
      expect(run2.code).toBe(0);

      // The new run takes max(1, 3) + 1 = 4 — it does not reuse run-3.
      expect(await readdirSorted(base)).toEqual(
        expect.arrayContaining(["run-1", "run-3", "run-4"]),
      );
      expect(await fs.readdir(base)).not.toContain("run-2");

      // The surviving run-3 artifacts are untouched — the overwrite the ticket
      // names does not happen.
      expect(await fs.readFile(run3History, "utf8")).toBe(historyBefore);
      expect(await fs.readFile(run3Verdict, "utf8")).toBe(verdictBefore);

      // The new session's verdicts landed in run-4, not on top of run-3.
      expect(await fs.readdir(path.join(base, "run-4", "round-1"))).toContain(
        "implementation.verdict.json",
      );

      // `previous` resolved to the highest surviving index (run-3), not the
      // deleted run-2: run-3's feedback reaches the fresh implementation prompt.
      const implementationPrompt = await fs.readFile(
        path.join(sandbox.promptDir, "run2", "implementation-0.txt"),
        "utf8",
      );
      expect(implementationPrompt).toContain(PlantedRun3Feedback);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
