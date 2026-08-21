/**
 * End-to-end acceptance for gate output being persisted to the run directory.
 *
 * Derived from the ticket, not the diff. Before this change the gate's combined
 * stdout+stderr was collected in memory, cut to a 20k tail, and dropped on every
 * path — in-round gate-fix attempts left no durable copy at all, so a
 * red-then-green round lost every failing transcript. The acceptance criteria:
 *
 *   1. Every gate execution leaves its full output on disk under the run
 *      directory, and a red-then-green round retains the red transcript(s).
 *   2. The excerpt quoted into the fix prompt names the on-disk log location.
 *   3. Integration's own gate run persists the same way.
 *
 * Everything drives the built CLI (`dist/index.js`) in a scratch repo under the
 * OS temp dir, with stub `claude` and `codex` binaries on PATH.
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
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

const SCENARIO_TIMEOUT_MS = 180_000;

/**
 * The agent both stubbed CLIs play; it never talks to the network. The first
 * implementation session commits `feature.txt` only, so the red gate (which
 * wants `gate-ok.txt`) fails; a gate-fix continuation — recognised by the
 * "Mechanical gate failed" feedback in its prompt — writes `gate-ok.txt` so the
 * next gate run goes green. A gate-fix session also dumps its full prompt to
 * `JFDI_GATEFIX_PROMPT_DUMP` so the test can assert the feedback named the log.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    const isGateFix = /Mechanical gate failed/.test(prompt);
    if (isGateFix) {
      fs.writeFileSync(process.cwd() + "/gate-ok.txt", "ok\\n");
      if (process.env.JFDI_GATEFIX_PROMPT_DUMP) fs.writeFileSync(process.env.JFDI_GATEFIX_PROMPT_DUMP, prompt);
    } else {
      fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    }
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "impl"], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented" };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

/**
 * The gate the scratch project runs: red until the fix session drops
 * `gate-ok.txt`. It writes distinct, greppable text on each side so the test
 * can tell a persisted red transcript from a green one.
 */
const RED_MARKER = "RED_TRANSCRIPT";
const GREEN_MARKER = "GREEN_TRANSCRIPT";
const GATE_COMMAND = `if test -f gate-ok.txt; then echo ${GREEN_MARKER}; else echo ${RED_MARKER} >&2; exit 1; fi`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  stateDirectory: string;
  executableDirectory: string;
  promptDump: string;
}

const sandboxes: string[] = [];

function expectedProjectKey(projectRoot: string): string {
  return projectRoot.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-gatelog-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
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
    stateDirectory: path.join(jfdiHome, "projects", expectedProjectKey(projectRoot)),
    executableDirectory,
    promptDump: path.join(root, "gatefix-prompt.txt"),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    JFDI_GATEFIX_PROMPT_DUMP: sandbox.promptDump,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env,
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

/** Force the scratch project's gate to the red-then-green command. */
async function setGate(sandbox: Sandbox): Promise<void> {
  const configPath = path.join(sandbox.projectRoot, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    gate: Array<{ name: string; command: string }>;
  };
  config.gate = [{ name: "check", command: GATE_COMMAND }];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("gate output persisted to the run directory", () => {
  it(
    "keeps every gate transcript on disk through a red-then-green round and names it in the fix prompt",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      await setGate(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      const roundDirectory = path.join(
        sandbox.stateDirectory,
        "runs",
        ticketId,
        "run-1",
        "round-1",
      );

      // Criterion 1: the red gate-fix attempt AND the green one both left their
      // full transcripts on disk — the failing one was not discarded when the
      // round went green.
      const redLog = await fs.readFile(
        path.join(roundDirectory, "gate-implementation-1.log"),
        "utf8",
      );
      const greenLog = await fs.readFile(
        path.join(roundDirectory, "gate-implementation-2.log"),
        "utf8",
      );
      expect(redLog).toContain(RED_MARKER);
      expect(redLog).not.toContain(GREEN_MARKER);
      expect(greenLog).toContain(GREEN_MARKER);
      expect(greenLog).not.toContain(RED_MARKER);

      // Criterion 2: the feedback the fix session actually received named the
      // on-disk log by its real path, and that path resolves to the red log.
      const fixPrompt = await fs.readFile(sandbox.promptDump, "utf8");
      const named = /Full output: `([^`]+)`/.exec(fixPrompt);
      expect(named?.[1]).toBe(path.join(roundDirectory, "gate-implementation-1.log"));
      expect(fixPrompt).toContain(RED_MARKER);

      expect(run.stdout).toContain("ready to merge");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "persists the integration gate's own transcript under the integration run directory",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      await setGate(sandbox);

      const run = await runCli(sandbox, ["run", "Ship a change"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(0);

      // Criterion 3: the clean-merge gate the coordinator reran before landing
      // left its transcript in the integration run directory — green here,
      // because the merged tree carries gate-ok.txt.
      const integrationLog = await fs.readFile(
        path.join(
          sandbox.stateDirectory,
          "runs",
          ticketId,
          "integration",
          "gate-clean-merge-1.log",
        ),
        "utf8",
      );
      expect(integrationLog).toContain(GREEN_MARKER);

      expect(await git(sandbox.projectRoot, "log", "--oneline", "main")).toContain(`${ticketId}:`);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
