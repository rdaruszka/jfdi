/**
 * End-to-end acceptance for re-entering integration on a card that comes back
 * to the begin column.
 *
 * Two failure modes are pinned here, both derived from the ticket rather than
 * the diff:
 *  - a worktree left mid-rebase by an integration that gave up must not make
 *    the next attempt die on "rebase already in progress" — the stale rebase is
 *    aborted, losslessly, and integration proceeds on its merits;
 *  - the begin-column shortcut that treats a saved report as an approval must
 *    only fire while the branch still points at the commit that was signed off;
 *    a branch that moved gets the pipeline, not a silent merge of stale work.
 *
 * Everything drives the built CLI (`dist/index.js`) in a scratch repo under the
 * OS temp dir, with a stub `claude` on PATH whose behavior is steered by a
 * control file (so it can change between coordinator scans). `JFDI_HOME`/`HOME`
 * always point inside the scratch tree — nothing here can reach the real
 * `~/.jfdi`.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const BUILD_TIMEOUT_MS = 180_000;
const SCENARIO_TIMEOUT_MS = 180_000;
/** How long one coordinator scan gets to reach the state a scenario waits for. */
const COORDINATOR_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 200;
/** Let the coordinator finish its last board write before the process is killed. */
const SETTLE_MS = 400;

const CARD_TEXT = "Add a feature";
const CARD_LINE = `- [ ] ${CARD_TEXT}`;

/**
 * A `claude` that never talks to the network. It replays two stream-json lines,
 * writes the verdict file its prompt names, and appends each stage it served to
 * `STUB_TRACE` so a test can count pipeline re-runs. `STUB_CONTROL` is re-read
 * on every invocation: `integration: "resolve"` finishes the conflicted rebase,
 * anything else walks away and leaves it in progress.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const controlPath = process.env.STUB_CONTROL;
const control = controlPath && fs.existsSync(controlPath)
  ? JSON.parse(fs.readFileSync(controlPath, "utf8"))
  : {};
const run = (args) => execFileSync("git", args, { cwd: process.cwd() });
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  fs.appendFileSync(process.env.STUB_TRACE, stage + "\\n");
  let verdict;
  if (stage === "implementation") {
    const body = control.feature || "v1";
    fs.writeFileSync(process.cwd() + "/feature.txt", body + "\\n");
    if (run(["status", "--porcelain"]).toString().trim()) {
      run(["add", "-A"]);
      run(["commit", "-m", "implement " + body]);
    }
    verdict = { status: "done", summary: "implemented " + body };
  } else if (stage === "integration") {
    if (control.integration === "resolve") {
      fs.writeFileSync(process.cwd() + "/feature.txt", "reconciled\\n");
      run(["add", "-A"]);
      run(["-c", "core.editor=true", "rebase", "--continue"]);
      verdict = { resolution: "clean", notes: "kept both sides" };
    } else {
      verdict = { resolution: "clean", notes: "walked away mid-rebase" };
    }
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
  stateDir: string;
  binDir: string;
  controlPath: string;
  tracePath: string;
  boardPath: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-reentry-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "claude"), STUB_CLAUDE, { mode: 0o755 });

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  const tracePath = path.join(root, "trace.txt");
  await fs.writeFile(tracePath, "");
  return {
    root,
    project,
    home,
    jfdiHome,
    binDir,
    controlPath: path.join(root, "control.json"),
    tracePath,
    boardPath: path.join(project, ".jfdi", "board.md"),
    stateDir: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
  };
}

function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_CONTROL: sandbox.controlPath,
    STUB_TRACE: sandbox.tracePath,
    NO_COLOR: "1",
  };
}

interface CliResult {
  code: number;
  output: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env: sandboxEnv(sandbox),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `jfdi start` until the board reaches `isSettled`, then stop it. The
 * coordinator is a watcher, so nothing else ends it: the whole process group is
 * killed once the scenario's outcome is on the board (or the wait times out, in
 * which case the collected output explains the failing assertion that follows).
 */
async function runCoordinatorUntil(
  sandbox: Sandbox,
  isSettled: (board: string) => boolean,
): Promise<string> {
  const child = spawn(process.execPath, [cliPath, "start"], {
    cwd: sandbox.project,
    env: sandboxEnv(sandbox),
    detached: true,
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const deadline = Date.now() + COORDINATOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isSettled(await readBoard(sandbox))) break;
    // The coordinator can end on its own; give the board one last look.
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(POLL_INTERVAL_MS);
  }
  await sleep(SETTLE_MS);
  if (child.exitCode === null && child.signalCode === null) {
    // Negative pid: the stub sessions are in the same group and must not outlive it.
    try {
      process.kill(-(child.pid ?? 0), "SIGKILL");
    } catch {
      // Already gone between the check and the signal — nothing to stop.
    }
  }
  await exited;
  return output;
}

function readBoard(sandbox: Sandbox): Promise<string> {
  return fs.readFile(sandbox.boardPath, "utf8");
}

/** The cards a column holds, as raw lines. */
function columnCards(board: string, column: string): string[] {
  const sections = board.split(/^## /m);
  const section = sections.find((part) => part.startsWith(`${column}\n`));
  if (section === undefined) throw new Error(`no column "${column}" on the board`);
  return section
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- ["));
}

/** A human dragging a card: plain text editing, the way Obsidian would leave it. */
async function moveCardTo(sandbox: Sandbox, column: string): Promise<void> {
  const board = await readBoard(sandbox);
  const withoutCard = board
    .split("\n")
    .filter((line) => !line.includes(CARD_TEXT))
    .join("\n");
  const placed = withoutCard.replace(`## ${column}\n`, `## ${column}\n${CARD_LINE}\n`);
  expect(placed, `column "${column}" not found on the board`).not.toBe(withoutCard);
  await fs.writeFile(sandbox.boardPath, placed);
}

async function seedBoardCard(sandbox: Sandbox): Promise<void> {
  await moveCardTo(sandbox, "Ready");
}

async function stagesRun(sandbox: Sandbox, stage: string): Promise<number> {
  const trace = await fs.readFile(sandbox.tracePath, "utf8");
  return trace.split("\n").filter((line) => line === stage).length;
}

async function ticketIdOf(sandbox: Sandbox): Promise<string> {
  const runs = await fs.readdir(path.join(sandbox.stateDir, "runs"));
  expect(runs).toHaveLength(1);
  const [ticketId] = runs;
  if (!ticketId) throw new Error("no run directory under the state dir");
  return ticketId;
}

async function savedReportCommit(sandbox: Sandbox, ticketId: string): Promise<string> {
  const raw = await fs.readFile(
    path.join(sandbox.stateDir, "runs", ticketId, "report.json"),
    "utf8",
  );
  return (JSON.parse(raw) as { commit: string }).commit;
}

async function isMidRebase(sandbox: Sandbox, ticketId: string): Promise<boolean> {
  const entries = await fs.readdir(path.join(sandbox.project, ".git", "worktrees", ticketId));
  return entries.includes("rebase-merge") || entries.includes("rebase-apply");
}

async function setControl(sandbox: Sandbox, control: Record<string, string>): Promise<void> {
  await fs.writeFile(sandbox.controlPath, JSON.stringify(control));
}

/** Scaffold, seed one card, and take it through the pipeline to Ready to Merge. */
async function runToMergeReady(sandbox: Sandbox): Promise<string> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  await seedBoardCard(sandbox);
  const output = await runCoordinatorUntil(
    sandbox,
    (board) => columnCards(board, "Ready to Merge").length === 1,
  );
  expect(columnCards(await readBoard(sandbox), "Ready to Merge"), output).toHaveLength(1);
  return await ticketIdOf(sandbox);
}

/** A commit on the target branch that collides with what the branch built. */
async function collideOnTarget(sandbox: Sandbox): Promise<void> {
  await fs.writeFile(path.join(sandbox.project, "feature.txt"), "main version\n");
  await git(sandbox.project, "add", "-A");
  await git(sandbox.project, "commit", "-m", "collide on main");
}

/**
 * Anything that would tell a user the re-entry tripped over its own leftovers —
 * git says "already a rebase-merge directory", the tool would say "rebase
 * already in progress"; neither is a reason a human can act on.
 */
function mentionsStaleRebase(text: string): boolean {
  return /rebase (already )?in progress|no rebase in progress|rebase-merge|rebase-apply/i.test(
    text,
  );
}

beforeAll(async () => {
  // Always rebuild: a stale dist/ would let these pass against old behavior.
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot });
}, BUILD_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("re-entering integration from the begin column", () => {
  it(
    "aborts the rebase a previous integration abandoned and merges on the retry",
    async () => {
      const sandbox = await makeSandbox();
      await setControl(sandbox, { integration: "abandon" });
      const ticketId = await runToMergeReady(sandbox);
      await collideOnTarget(sandbox);

      // First re-dispatch: the integration agent walks away from the conflict.
      await moveCardTo(sandbox, "Ready");
      const abandoned = await runCoordinatorUntil(
        sandbox,
        (board) => columnCards(board, "Blocked").length === 1,
      );
      expect(columnCards(await readBoard(sandbox), "Blocked"), abandoned).toHaveLength(1);
      expect(await isMidRebase(sandbox, ticketId)).toBe(true);
      // Aborting has to be lossless, so the branch must still be where the
      // sign-off left it — a rebase only moves the ref once it completes.
      expect(await git(sandbox.project, "rev-parse", `jfdi/${ticketId}`)).toBe(
        await savedReportCommit(sandbox, ticketId),
      );

      // Second re-dispatch onto that mid-rebase worktree: the stale rebase is
      // cleared and this behaves like any other conflicted integration.
      await setControl(sandbox, { integration: "resolve" });
      await moveCardTo(sandbox, "Ready");
      const retried = await runCoordinatorUntil(
        sandbox,
        (board) => columnCards(board, "Done").length === 1,
      );

      expect(columnCards(await readBoard(sandbox), "Done"), retried).toEqual([
        `- [x] ${CARD_TEXT}`,
      ]);
      expect(mentionsStaleRebase(abandoned + retried)).toBe(false);
      const note = await fs.readFile(
        path.join(sandbox.project, ".jfdi", "tickets", `${ticketId}.md`),
        "utf8",
      );
      expect(mentionsStaleRebase(note)).toBe(false);
      expect(await git(sandbox.project, "log", "--oneline", "main")).toContain("implement v1");
      expect(await git(sandbox.project, "show", "main:feature.txt")).toBe("reconciled");
      // The work was integrated, not rebuilt: implementation ran exactly once.
      expect(await stagesRun(sandbox, "implementation")).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps every branch commit when it aborts a stale rebase",
    async () => {
      const sandbox = await makeSandbox();
      await setControl(sandbox, { integration: "abandon" });
      const ticketId = await runToMergeReady(sandbox);
      const signedOff = await savedReportCommit(sandbox, ticketId);
      await collideOnTarget(sandbox);

      const blocked = await runCli(sandbox, ["merge", ticketId]);
      expect(blocked.code).toBe(2);
      expect(await isMidRebase(sandbox, ticketId)).toBe(true);

      // The human takes the colliding commit back off the target instead of
      // resolving in the worktree; the retry must find the branch intact.
      await git(sandbox.project, "reset", "--hard", "HEAD~1");

      const merged = await runCli(sandbox, ["merge", ticketId]);
      expect(merged.code, merged.output).toBe(0);
      expect(mentionsStaleRebase(blocked.output + merged.output)).toBe(false);
      // No conflict left, so no second integration agent: exactly the one that
      // abandoned. The signed-off commit itself is what landed.
      expect(await stagesRun(sandbox, "integration")).toBe(1);
      expect(await git(sandbox.project, "rev-parse", "main")).toBe(signedOff);
      expect(await git(sandbox.project, "show", "main:feature.txt")).toBe("v1");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "re-runs the pipeline instead of merging a branch that moved past its sign-off",
    async () => {
      const sandbox = await makeSandbox();
      await setControl(sandbox, { integration: "resolve", feature: "v1" });
      const ticketId = await runToMergeReady(sandbox);
      const signedOff = await savedReportCommit(sandbox, ticketId);

      // A human commits on the branch after the sign-off and drags the card
      // back expecting fresh work — not a silent merge of what was reviewed.
      const worktree = path.join(sandbox.project, ".jfdi", "worktrees", ticketId);
      await fs.writeFile(path.join(worktree, "by-hand.txt"), "human edit\n");
      await git(worktree, "add", "-A");
      await git(worktree, "commit", "-m", "human edit");
      expect(await git(sandbox.project, "rev-parse", `jfdi/${ticketId}`)).not.toBe(signedOff);

      await setControl(sandbox, { integration: "resolve", feature: "v2" });
      await moveCardTo(sandbox, "Ready");
      const output = await runCoordinatorUntil(
        sandbox,
        (board) => columnCards(board, "Ready to Merge").length === 1,
      );

      // The pipeline ran again, and nothing was merged behind the human's back.
      expect(await stagesRun(sandbox, "implementation"), output).toBe(2);
      expect(await git(sandbox.project, "log", "--oneline", "main")).not.toContain("implement");
      expect(columnCards(await readBoard(sandbox), "Done")).toHaveLength(0);
      expect(columnCards(await readBoard(sandbox), "Ready to Merge")).toHaveLength(1);
      // The fresh run re-signed the branch as it now stands.
      expect(await savedReportCommit(sandbox, ticketId)).toBe(
        await git(sandbox.project, "rev-parse", `jfdi/${ticketId}`),
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "still skips straight to integration when the branch matches its sign-off",
    async () => {
      const sandbox = await makeSandbox();
      await setControl(sandbox, { integration: "resolve" });
      const ticketId = await runToMergeReady(sandbox);
      const signedOff = await savedReportCommit(sandbox, ticketId);

      await moveCardTo(sandbox, "Ready");
      const output = await runCoordinatorUntil(
        sandbox,
        (board) => columnCards(board, "Done").length === 1,
      );

      // Approval, not a rebuild: no second pipeline, and the exact commit the
      // reviews signed off on is what reached the target branch.
      expect(await stagesRun(sandbox, "implementation"), output).toBe(1);
      expect(await git(sandbox.project, "rev-parse", "main")).toBe(signedOff);
      expect(columnCards(await readBoard(sandbox), "Done")).toEqual([`- [x] ${CARD_TEXT}`]);
      expect(await git(sandbox.project, "branch", "--list", `jfdi/${ticketId}`)).toBe("");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
