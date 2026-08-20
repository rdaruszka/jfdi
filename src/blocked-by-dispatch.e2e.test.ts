/**
 * Acceptance for `jfdi run`'s blocked-by gate, exercised against the built CLI
 * (`dist/index.js`) in a scratch repo under the OS temp dir — the real artifact,
 * not `runTicketInline` in-process. Stub `claude`/`codex` on PATH replay a few
 * stream-json lines and write the verdict their prompt names; a stub that never
 * runs leaves no trace, which is how these prove a blocked run dispatched
 * nothing at all.
 *
 * Blocking means blocked on every path: a direct run refuses a ticket whose
 * `blocked-by` tickets are not in the done column, exiting non-zero and naming
 * them, and only `--force` overrides — spelled out, never implied by the id.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree; nothing here can
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

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const RUN_TIMEOUT_MS = 120_000;

/**
 * The agent both stubbed CLIs play. It never touches the network: replays the
 * stream-json a harness needs to see a session start and finish, records that
 * it ran (so a test can tell a dispatch from a skip), and answers the verdict
 * file its prompt names. Implementation commits, so later stages have a real
 * tree to gate. A skipped run never invokes this, so `ran.log` stays absent.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  fs.mkdirSync(process.env.CAPTURE_DIR, { recursive: true });
  fs.appendFileSync(process.env.CAPTURE_DIR + "/ran.log", stage + "\\n");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: [] };
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
  home: string;
  jfdiHome: string;
  binDir: string;
  captureDir: string;
  ticketsDirectory: string;
  boardPath: string;
}

const sandboxes: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-blockedby-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const captureDir = path.join(root, "capture");
  for (const dir of [project, home, binDir, captureDir]) await fs.mkdir(dir, { recursive: true });
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
  const sandbox: Sandbox = {
    root,
    project,
    home,
    jfdiHome,
    binDir,
    captureDir,
    ticketsDirectory: path.join(project, ".jfdi", "tickets"),
    boardPath: path.join(project, ".jfdi", "board.md"),
  };
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  return sandbox;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    CAPTURE_DIR: sandbox.captureDir,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function writeNote(sandbox: Sandbox, id: string, frontmatter: string): Promise<void> {
  await fs.writeFile(
    path.join(sandbox.ticketsDirectory, `${id}.md`),
    `---\n${frontmatter}\n---\n\n# ${id}\n\nSome work to do.\n`,
  );
}

/**
 * A board with `alpha` in the begin column and a `blocker` card parked in the
 * named column. Off `Done`, the blocker gates; in `Done`, it does not.
 */
async function writeBoardWithBlocker(sandbox: Sandbox, blockerColumn: string): Promise<void> {
  await fs.writeFile(
    sandbox.boardPath,
    `---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n- [ ] work on alpha [[alpha]]\n\n## In Progress\n\n## Done\n\n## ${blockerColumn}\n\n- [ ] the blocker [[blocker]]\n`,
  );
}

/** Whether the stub agent recorded a run — present only if the pipeline dispatched. */
async function agentRan(sandbox: Sandbox): Promise<boolean> {
  try {
    await fs.access(path.join(sandbox.captureDir, "ran.log"));
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("jfdi run — blocked-by gate (built CLI)", () => {
  it(
    "refuses a ticket whose blocker is not done, names it, and dispatches nothing",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "alpha", 'blocked-by:\n  - "[[blocker]]"');
      await writeBoardWithBlocker(sandbox, "Backlog");

      const result = await runCli(sandbox, ["run", "[[alpha]]"]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("blocked by blocker");
      expect(result.stderr).toContain("--force");
      // The gate fires before the pipeline: no agent session was ever spawned.
      expect(await agentRan(sandbox)).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "names a dangling blocker that has no card anywhere on the board",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "alpha", 'blocked-by:\n  - "[[ghost]]"');
      // Board holds alpha but no card for `ghost` — the link dangles.
      await fs.writeFile(
        sandbox.boardPath,
        "---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n- [ ] work on alpha [[alpha]]\n\n## Done\n",
      );

      const result = await runCli(sandbox, ["run", "[[alpha]]"]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("ghost (no card on the board)");
      expect(await agentRan(sandbox)).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "--force runs a blocked ticket anyway, still printing the blockers",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "alpha", 'blocked-by:\n  - "[[blocker]]"');
      await writeBoardWithBlocker(sandbox, "Backlog");

      const result = await runCli(sandbox, ["run", "--force", "[[alpha]]"]);

      expect(result.code).toBe(0);
      // The override is spelled out on the way past, not swallowed.
      expect(`${result.stdout}${result.stderr}`).toContain("blocker");
      expect(await agentRan(sandbox)).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "runs a ticket whose only blocker sits in Done, with no --force",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "alpha", 'blocked-by:\n  - "[[blocker]]"');
      await writeBoardWithBlocker(sandbox, "Done");

      const result = await runCli(sandbox, ["run", "[[alpha]]"]);

      expect(result.code).toBe(0);
      expect(await agentRan(sandbox)).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "dispatches a ticket whose note has no frontmatter at all exactly as before",
    async () => {
      const sandbox = await makeSandbox();
      // No frontmatter block whatsoever — the pre-blocked-by baseline.
      await fs.writeFile(
        path.join(sandbox.ticketsDirectory, "alpha.md"),
        "# alpha\n\nSome work to do.\n",
      );
      await fs.writeFile(
        sandbox.boardPath,
        "---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n- [ ] work on alpha [[alpha]]\n\n## Done\n",
      );

      const result = await runCli(sandbox, ["run", "[[alpha]]"]);

      expect(result.code).toBe(0);
      expect(await agentRan(sandbox)).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );
});
