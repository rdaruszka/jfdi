/**
 * End-to-end acceptance for `jfdi logs <ticket>` recursive log discovery.
 *
 * Drives the built CLI (`dist/index.js`) in a scratch repo under the OS temp
 * dir, with a runs tree fabricated by hand under the home-directory state dir —
 * no pipeline runs, so no stub agents are needed. This pins the observable
 * behavior the `logs-readdir-string-coercion` ticket claims is unchanged after
 * dropping the redundant `String()` coercion: the latest run only, recursive
 * discovery into nested round directories, `.log.jsonl` extension filtering
 * (verdict files ignored), the integration directory, and lexicographic sort.
 * `JFDI_HOME`/`HOME` always point inside the scratch tree.
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

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

interface Sandbox {
  projectRoot: string;
  jfdiHome: string;
  stateDirectory: string;
}

/** Dash-flattened absolute path, derived here rather than from the module under test. */
function expectedProjectKey(projectRoot: string): string {
  return projectRoot.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-logs-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const projectRoot = path.join(root, "project");
  const jfdiHome = path.join(root, "home", ".jfdi");
  await fs.mkdir(projectRoot, { recursive: true });
  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");
  return {
    projectRoot,
    jfdiHome,
    stateDirectory: path.join(jfdiHome, "projects", expectedProjectKey(projectRoot)),
  };
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, JFDI_HOME: sandbox.jfdiHome };
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

async function writeFileTree(base: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(base, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents);
  }
}

describe("jfdi logs recursive discovery over the built CLI", () => {
  it("prints only the latest run's .log.jsonl files, recursively and sorted", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

    const runs = path.join(sandbox.stateDirectory, "runs", "my-ticket");
    await writeFileTree(runs, {
      // An earlier run: numeric sort must pick run-2 over run-1, so this is skipped.
      "run-1/round-1/stale.log.jsonl": "stale-run",
      // Latest run: nested round directories exercise recursive discovery.
      "run-2/round-1/nested/a.log.jsonl": "alpha",
      "run-2/round-1/z.log.jsonl": "zeta",
      "run-2/round-2/m.log.jsonl": "mid",
      // A non-log sibling the extension filter must drop.
      "run-2/round-1/implementation.verdict.json": "not-a-log",
      // Integration logs are appended after the latest run's own logs.
      "integration/i.log.jsonl": "integ",
    });

    const logs = await runCli(sandbox, ["logs", "my-ticket"]);
    expect(logs.code).toBe(0);

    // Latest run only: the stale run-1 log never appears.
    expect(logs.stdout).not.toContain("stale-run");
    expect(logs.stdout).not.toContain("run-1");
    // The verdict file is filtered out by extension.
    expect(logs.stdout).not.toContain("not-a-log");
    // All latest-run logs plus integration are printed with their contents.
    for (const contents of ["alpha", "zeta", "mid", "integ"]) {
      expect(logs.stdout).toContain(contents);
    }

    // Headers appear in per-directory lexicographic order: nested sorts before
    // its sibling ("nested/a" < "z"), round-1 before round-2, then integration.
    const headerOrder = logs.stdout
      .split("\n")
      .filter((line) => line.startsWith("====="))
      .map((line) => line.replace(/=/g, "").trim());
    expect(headerOrder).toEqual([
      path.join("runs", "my-ticket", "run-2", "round-1", "nested", "a.log.jsonl"),
      path.join("runs", "my-ticket", "run-2", "round-1", "z.log.jsonl"),
      path.join("runs", "my-ticket", "run-2", "round-2", "m.log.jsonl"),
      path.join("runs", "my-ticket", "integration", "i.log.jsonl"),
    ]);
  }, 60_000);

  it("exits 1 with a clear message when the ticket has no runs directory", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

    const logs = await runCli(sandbox, ["logs", "never-dispatched"]);
    expect(logs.code).toBe(1);
    expect(logs.stderr).toContain('no runs recorded for ticket "never-dispatched"');
  }, 60_000);
});
