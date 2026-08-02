/**
 * End-to-end acceptance for run state living outside the project checkout.
 *
 * These drive the built CLI (`dist/index.js`) in a scratch repo under the OS
 * temp dir with a stub `claude` on PATH, so they cover the wiring the unit
 * tests inject past: buildContext deriving the state directory, and every
 * consumer (pipeline, coordinator entry points, status, logs, merge) agreeing
 * on it. `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here
 * can reach the real `~/.jfdi`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

/**
 * A `claude` that never talks to the network: it replays two stream-json lines
 * and writes the verdict file its prompt names. The implementation stage also
 * commits, so the pipeline has a real commit to review, gate and merge.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
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

interface Sandbox {
  root: string;
  project: string;
  /** Stands in for the user's home: `JFDI_HOME` points at `<home>/.jfdi`. */
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
}

const sandboxes: string[] = [];

/**
 * The path key JFDI is expected to use, derived here from first principles
 * (dash-flattened absolute path) rather than from the module under test.
 * `realpath` because git reports the resolved root — /tmp is a symlink on macOS.
 */
function expectedProjectKey(projectRoot: string): string {
  return projectRoot.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(path.join(project, "sub"), { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "claude"), STUB_CLAUDE, { mode: 0o755 });

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await fs.writeFile(path.join(project, "sub", "unit.txt"), "unit\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    project,
    home,
    jfdiHome,
    stateDir: path.join(jfdiHome, "projects", expectedProjectKey(project)),
    binDir,
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI. `useJfdiHomeEnv: false` exercises the ~/.jfdi default. */
async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: { cwd?: string; useJfdiHomeEnv?: boolean } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
  };
  if (options.useJfdiHomeEnv === false) delete env.JFDI_HOME;
  else env.JFDI_HOME = sandbox.jfdiHome;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? sandbox.project,
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

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  // Always rebuild: a stale dist/ would let these pass against old behavior.
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot });
}, 180_000);

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("run state under ~/.jfdi/projects/<project-key>", () => {
  it("keeps runs, events and the snapshot out of the project and worktrees in it", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
    // Scaffolding alone must not seed state files inside the project.
    expect(await listDir(path.join(sandbox.project, ".jfdi"))).not.toContain("events.jsonl");

    const run = await runCli(sandbox, ["run", "Add a greeting"]);
    expect(run.code).toBe(0);
    const ticketId = ticketIdOf(run);

    // Everything the run produced lives under the home-directory state dir…
    const roundDir = path.join(sandbox.stateDir, "runs", ticketId, "run-1", "round-1");
    expect(await listDir(roundDir)).toEqual(
      expect.arrayContaining([
        "implementation.verdict.json",
        "code-review.verdict.json",
        "qa.verdict.json",
        "implementation.log.jsonl",
      ]),
    );
    expect(await pathExists(path.join(sandbox.stateDir, "events.jsonl"))).toBe(true);
    expect(await pathExists(path.join(sandbox.stateDir, "state.json"))).toBe(true);
    expect(await pathExists(path.join(sandbox.stateDir, "runs", ticketId, "report.json"))).toBe(
      true,
    );

    // …and nothing put them back inside the project's .jfdi/ — or the worktree's.
    const projectJfdi = path.join(sandbox.project, ".jfdi");
    for (const stateEntry of ["runs", "events.jsonl", "state.json"]) {
      expect(await listDir(projectJfdi)).not.toContain(stateEntry);
      expect(await listDir(path.join(projectJfdi, "worktrees", ticketId, ".jfdi"))).not.toContain(
        stateEntry,
      );
    }

    // Worktree creation and location are unchanged.
    const worktree = path.join(projectJfdi, "worktrees", ticketId);
    expect(await pathExists(path.join(worktree, "feature.txt"))).toBe(true);

    // status and logs read the same place the pipeline wrote.
    const status = await runCli(sandbox, ["status", "--json"]);
    expect(status.code).toBe(0);
    const snapshot = JSON.parse(status.stdout) as {
      tickets: Record<string, { status: string }>;
    };
    expect(snapshot.tickets[ticketId]?.status).toBe("merge-ready");

    const logs = await runCli(sandbox, ["logs", ticketId]);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("implementation.log.jsonl");
    expect(logs.stdout).toContain("stub");

    // merge picks up the saved report from the state dir and integrates.
    const merge = await runCli(sandbox, ["merge", ticketId]);
    expect(merge.code).toBe(0);
    const log = await git(sandbox.project, "log", "--oneline", "main");
    expect(log).toContain("implement");
  }, 120_000);

  it("falls back to ~/.jfdi when JFDI_HOME is unset", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"], { useJfdiHomeEnv: false })).code).toBe(0);
    const run = await runCli(sandbox, ["run", "Add a farewell"], { useJfdiHomeEnv: false });
    expect(run.code).toBe(0);

    // sandbox.stateDir is <home>/.jfdi/projects/<key> — reached without the override.
    expect(await pathExists(path.join(sandbox.stateDir, "state.json"))).toBe(true);
    expect(await listDir(path.join(sandbox.project, ".jfdi"))).not.toContain("state.json");
  }, 120_000);

  it("keys state on the project root, not the working directory it was invoked from", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
    const subdirectory = path.join(sandbox.project, "sub");
    const run = await runCli(sandbox, ["run", "Add a logo"], { cwd: subdirectory });
    expect(run.code).toBe(0);
    const ticketId = ticketIdOf(run);

    // One project, one key — no second directory keyed on the subdirectory.
    expect(await listDir(path.join(sandbox.jfdiHome, "projects"))).toEqual([
      expectedProjectKey(sandbox.project),
    ]);
    // And a consumer invoked from elsewhere in the tree finds that same state.
    const status = await runCli(sandbox, ["status", "--json"], { cwd: subdirectory });
    const snapshot = JSON.parse(status.stdout) as { tickets: Record<string, unknown> };
    expect(Object.keys(snapshot.tickets)).toEqual([ticketId]);
  }, 120_000);
});
