/**
 * Acceptance for the TTY-only requirement of `jfdi start`, exercised against the
 * built CLI (`dist/index.js start`) in a scratch repo under the OS temp dir.
 *
 * The default `jfdi start` front end is the live Ink TUI, which cannot draw
 * without a terminal. When stdout is redirected (a pipe, not a TTY) it must
 * refuse: a non-zero exit and an actionable message on stderr, and — critically —
 * it must dispatch nothing. It never silently falls back to the web front end; that
 * selection must be explicit in config or on the CLI. The refusal lands before
 * any session is spawned, so a stub agent that
 * records every invocation staying silent (`CAPTURE_DIRECTORY/ran.log` absent) proves
 * no dispatch, and the begin-column card sitting untouched proves the board
 * was never mutated.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree; nothing here can
 * reach the real `~/.jfdi`, and the stub guarantees no real agent CLI is spawned.
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

const SCENARIO_TIMEOUT_MS = 60_000;
const REFUSAL_MESSAGE = "jfdi start requires a terminal (TTY); it renders a live TUI";

/** A stub that records every invocation, so an absent log proves no dispatch. */
const RECORDING_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync(process.env.CAPTURE_DIRECTORY, { recursive: true });
fs.appendFileSync(process.env.CAPTURE_DIRECTORY + "/ran.log", "ran\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
process.exit(0);
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
  captureDirectory: string;
  boardPath: string;
}

const sandboxes: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-tty-refusal-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  const captureDirectory = path.join(root, "capture");
  for (const directory of [projectRoot, home, executableDirectory, captureDirectory])
    await fs.mkdir(directory, { recursive: true });
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), RECORDING_STUB, { mode: 0o755 });
  }

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  const sandbox: Sandbox = {
    root,
    projectRoot,
    home,
    jfdiHome,
    executableDirectory,
    captureDirectory,
    boardPath: path.join(projectRoot, ".jfdi", "board.md"),
  };
  const init = await execFileAsync(process.execPath, [cliPath, "init", "--bare"], {
    cwd: projectRoot,
    env: envFor(sandbox),
  });
  expect(init.stderr).not.toContain("Error");
  return sandbox;
}

function envFor(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    CAPTURE_DIRECTORY: sandbox.captureDirectory,
  };
}

/** Board with one card in the Ready (begin) column. */
async function writeReadyBoard(sandbox: Sandbox, card: string): Promise<void> {
  await fs.writeFile(
    sandbox.boardPath,
    `---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n${card}\n\n## In Progress\n\n## Done\n\n## Blocked\n\n## Ready to Merge\n\n## Inbox\n`,
  );
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the built CLI with stdout/stderr as pipes — the default `spawn` stdio,
 * which presents no TTY to the child, exactly the redirected-output case.
 */
async function runCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | null; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("jfdi start — non-TTY refusal (built CLI)", () => {
  it(
    "refuses redirected output non-zero, on stderr, and dispatches nothing",
    async () => {
      const sandbox = await makeSandbox();
      await writeReadyBoard(sandbox, "- [ ] Fix the parser");

      const result = await runCli(["start"], { cwd: sandbox.projectRoot, env: envFor(sandbox) });

      // Non-zero exit with the actionable message on stderr (not stdout).
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(REFUSAL_MESSAGE);
      expect(result.stdout).toBe("");

      // Dispatched nothing: no agent session spawned, and the begin-column card
      // is untouched — the coordinator never even read the board.
      expect(await fileExists(path.join(sandbox.captureDirectory, "ran.log"))).toBe(false);
      const board = await fs.readFile(sandbox.boardPath, "utf8");
      expect(board).toContain("## Ready\n\n- [ ] Fix the parser");
      expect(board).toContain("## In Progress\n\n##");

      // No run state was written — the refusal precedes any event stream.
      const projectHome = path.join(sandbox.jfdiHome, "projects");
      expect(await fileExists(projectHome)).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "refuses before building context — a non-repo directory still gets the TTY message",
    async () => {
      // The TTY check must run before `buildContext`, so an environment where
      // context-building would itself fail (no git repo) must still surface the
      // TTY refusal — not a 'not a repo' error shadowing it.
      const bareDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-tty-norepo-e2e-"));
      sandboxes.push(bareDirectory);
      const env = { ...process.env, JFDI_HOME: path.join(bareDirectory, ".jfdi") };

      const result = await runCli(["start"], { cwd: bareDirectory, env });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(REFUSAL_MESSAGE);
      expect(result.stderr).not.toContain("repo");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
