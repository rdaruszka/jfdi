/**
 * Acceptance for resuming an interrupted run, driven through the built CLI.
 *
 * The unit tests cover the pieces (prepareResume, formatResumeSection, the
 * history file) with injected fixtures. What they cannot see is whether the
 * shipped artifact wires them together: whether the prompt that actually
 * reaches an agent session says "you are resuming", whether the checkpoint
 * commit really lands before the first session starts, and whether a restarted
 * coordinator really moves a stranded card. These drive `dist/index.js` in a
 * scratch repo under the OS temp dir with a stub `claude` on PATH and assert on
 * what an agent, a renderer or a human can observe from outside the process.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`, and the stub guarantees no real agent CLI is spawned.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { git, isRebaseInProgress, rebaseOnto } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const BUILD_TIMEOUT_MS = 180_000;
const PIPELINE_TIMEOUT_MS = 120_000;
/** How long a spawned coordinator gets to reach the state a test waits for. */
const COORDINATOR_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;

/**
 * A `claude` that never talks to the network. Beyond replaying stream-json and
 * writing the verdict its prompt names, it records two things the assertions
 * need: the full prompt text it was handed, and — for the implementation stage
 * — `git status --porcelain` as the session found the worktree, which is the
 * only way to observe "the agent started from a clean tree" from outside.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = path.basename(verdictPath).replace(".verdict.json", "");
  const promptDir = process.env.STUB_PROMPT_DIR;
  fs.mkdirSync(promptDir, { recursive: true });
  let index = 0;
  while (fs.existsSync(path.join(promptDir, stage + "-" + index + ".txt"))) index += 1;
  fs.writeFileSync(path.join(promptDir, stage + "-" + index + ".txt"), prompt);
  let verdict;
  if (stage === "implementation") {
    if (index === 0) {
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd() }).toString();
      fs.writeFileSync(path.join(promptDir, "tree-at-first-session.txt"), status);
    }
    // Unique content per attempt, so every round has something real to commit.
    fs.appendFileSync(path.join(process.cwd(), "feature.txt"), process.env.STUB_TAG + "-" + index + "\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement " + process.env.STUB_TAG], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented" };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else if (stage === "code-review" && process.env.STUB_MODE === "review-fail") {
    verdict = { verdict: "fail", feedback: "the parser is wrong" };
  } else if (stage === "code-review" && process.env.STUB_MODE === "review-fail-round-1") {
    const round = Number(/round-(\\d+)/.exec(verdictPath)[1]);
    verdict = round === 1 ? { verdict: "fail", feedback: "still the wrong parser" } : { verdict: "pass" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
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
  /** Where the stub drops one file per prompt it was handed. */
  promptDir: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-resume-"));
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

interface StubOptions {
  /** "review-fail" makes Code Review refuse every round, so the run burns its rounds. */
  stubMode?: string;
  /** Distinguishes one dispatch's commits from another's in the branch log. */
  tag?: string;
  /** Subdirectory of promptDir this invocation records into. */
  promptSubdir?: string;
}

function stubEnv(sandbox: Sandbox, options: StubOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_MODE: options.stubMode ?? "pass",
    STUB_TAG: options.tag ?? "work",
    STUB_PROMPT_DIR: path.join(sandbox.promptDir, options.promptSubdir ?? "default"),
    NO_COLOR: "1",
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
  options: StubOptions = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
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

function readPrompt(sandbox: Sandbox, subdir: string, name: string): Promise<string> {
  return fs.readFile(path.join(sandbox.promptDir, subdir, name), "utf8");
}

interface RecordedEvent {
  type: string;
  ticketId?: string;
  data?: Record<string, unknown>;
}

async function readEvents(sandbox: Sandbox): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

function boardPath(sandbox: Sandbox): string {
  return path.join(sandbox.project, ".jfdi", "board.md");
}

function worktreePath(sandbox: Sandbox, ticketId: string): string {
  return path.join(sandbox.project, ".jfdi", "worktrees", ticketId);
}

/** The card lines under one board column heading, in order. */
async function cardsInColumn(sandbox: Sandbox, column: string): Promise<string[]> {
  const content = await fs.readFile(boardPath(sandbox), "utf8");
  const sections = content.split(/^## /m).slice(1);
  const section = sections.find((part) => part.startsWith(`${column}\n`));
  if (section === undefined) throw new Error(`no "${column}" column on the board`);
  return section
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- ["))
    .map((line) => line.trim());
}

async function initProject(sandbox: Sandbox): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
}

async function putCardInColumn(sandbox: Sandbox, column: string, card: string): Promise<void> {
  const content = await fs.readFile(boardPath(sandbox), "utf8");
  await fs.writeFile(
    boardPath(sandbox),
    content.replace(`## ${column}\n`, `## ${column}\n\n${card}\n`),
  );
}

/**
 * Run the coordinator until `isReady` holds, then stop it. `jfdi start` watches
 * forever by design, so the only way to observe it from a test is to spawn it,
 * wait on the state it is supposed to produce, and signal it down. The loop is
 * bounded by a deadline, so a coordinator that never gets there fails the test
 * instead of hanging the suite.
 */
async function runCoordinatorUntil(
  sandbox: Sandbox,
  isReady: () => Promise<boolean>,
  options: StubOptions = {},
): Promise<string> {
  const child = spawn(process.execPath, [cliPath, "start"], {
    cwd: sandbox.project,
    env: stubEnv(sandbox, options),
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const deadline = Date.now() + COORDINATOR_TIMEOUT_MS;
    // Terminates: the deadline shrinks the remaining time every pass.
    while (Date.now() < deadline) {
      if (await isReady()) return output;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`coordinator never reached the expected state. Output:\n${output}`);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
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

describe("resuming an interrupted run", () => {
  it(
    "re-dispatch tells the agent it is resuming, what the branch holds, and why the last run failed",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Run 1: Code Review refuses every round, so the ticket dies mid-pipeline
      // with three commits of partial work on its branch.
      const first = await runCli(sandbox, ["run", "Fix the parser"], {
        stubMode: "review-fail",
        tag: "first",
        promptSubdir: "run1",
      });
      expect(first.code).toBe(2);
      const ticketId = ticketIdOf(first);

      // A first dispatch is not a resume: nothing on the branch to continue.
      const freshPrompt = await readPrompt(sandbox, "run1", "implementation-0.txt");
      expect(freshPrompt).not.toContain("Resuming an interrupted attempt");
      expect(freshPrompt).not.toContain("Feedback on earlier attempts");

      // Run 2: the same card dispatched again, failing its own first round so
      // there is a second round to inspect as well.
      const second = await runCli(sandbox, ["run", "Fix the parser"], {
        stubMode: "review-fail-round-1",
        tag: "second",
        promptSubdir: "run2",
      });
      expect(second.code).toBe(0);

      const resumedPrompt = await readPrompt(sandbox, "run2", "implementation-0.txt");
      expect(resumedPrompt).toContain("Resuming an interrupted attempt");
      expect(resumedPrompt).toContain("3 commits of partial work");
      expect(resumedPrompt).toContain("do not start over");
      // The summary is of the real branch, not a stock sentence.
      expect(resumedPrompt).toContain("implement first");
      expect(resumedPrompt).not.toContain("implement second");
      // …and the previous run's unanswered feedback, attributed to its run.
      expect(resumedPrompt).toContain("the parser is wrong");
      expect(resumedPrompt).toContain("Run 1, round 1 — code review");
      expect(resumedPrompt).toContain("Run 1, round 3 — code review");

      // Round 2 of the resumed run is not itself a resume: it works on commits
      // this run just made, so repeating the (now stale) branch summary would
      // tell the agent to stop redoing work it has not done yet.
      const secondRound = await readPrompt(sandbox, "run2", "implementation-1.txt");
      expect(secondRound).not.toContain("Resuming an interrupted attempt");
      // Its own round's feedback still reaches it, alongside what it inherited.
      expect(secondRound).toContain("still the wrong parser");
      expect(secondRound).toContain("Run 1, round 1 — code review");

      // The event stream says so too, so a renderer can show it.
      const resumed = (await readEvents(sandbox)).filter((event) => event.type === "resumed");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.ticketId).toBe(ticketId);
      expect(resumed[0]?.data).toMatchObject({
        commitCount: 3,
        hasCheckpointedChanges: false,
        hasAbortedRebase: false,
      });
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "sanitizes a worktree a killed run left dirty and mid-rebase before the first session",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const first = await runCli(sandbox, ["run", "Add a greeting"], {
        tag: "first",
        promptSubdir: "run1",
      });
      expect(first.code).toBe(0);
      const ticketId = ticketIdOf(first);
      const worktree = worktreePath(sandbox, ticketId);

      // What a session killed mid-flight leaves behind: a conflicted rebase and
      // edits that never got committed.
      await fs.writeFile(path.join(worktree, "README.md"), "branch version\n");
      await git(worktree, "commit", "-am", "branch edit");
      await fs.writeFile(path.join(sandbox.project, "README.md"), "main version\n");
      await git(sandbox.project, "commit", "-am", "main edit");
      expect((await rebaseOnto(worktree, "main")).hasConflict).toBe(true);
      expect(await isRebaseInProgress(worktree)).toBe(true);
      await fs.writeFile(path.join(worktree, "salvaged.txt"), "half-written\n");

      const second = await runCli(sandbox, ["run", "Add a greeting"], {
        tag: "second",
        promptSubdir: "run2",
      });
      expect(second.code).toBe(0);

      // The agent found a clean, committed tree — not a conflicted one.
      expect(await readPrompt(sandbox, "run2", "tree-at-first-session.txt")).toBe("");
      expect(await isRebaseInProgress(worktree)).toBe(false);
      // The rebase was undone, not resolved: the branch's own edit survived.
      expect(await fs.readFile(path.join(worktree, "README.md"), "utf8")).toBe("branch version\n");
      // The uncommitted work was salvaged, not discarded.
      expect(await fs.readFile(path.join(worktree, "salvaged.txt"), "utf8")).toBe("half-written\n");
      const checkpointed = await git(
        worktree,
        "log",
        "--format=%s",
        "--grep",
        "recovered from interrupted run",
      );
      expect(checkpointed).toContain(`jfdi(${ticketId}): recovered from interrupted run`);

      // The prompt says what was done to the tree on the agent's behalf.
      const prompt = await readPrompt(sandbox, "run2", "implementation-0.txt");
      expect(prompt).toContain("recovered from interrupted run");
      expect(prompt).toContain("rebase onto `main` was aborted");

      // And the event stream records the recovery, not just the resume.
      const resumed = (await readEvents(sandbox)).filter((event) => event.type === "resumed");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.data).toMatchObject({
        hasCheckpointedChanges: true,
        hasAbortedRebase: true,
      });
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "does not announce a resume for a ticket whose work is already merged",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const first = await runCli(sandbox, ["run", "Add a farewell"], {
        tag: "first",
        promptSubdir: "run1",
      });
      expect(first.code).toBe(0);
      const ticketId = ticketIdOf(first);
      expect((await runCli(sandbox, ["merge", ticketId], { promptSubdir: "merge" })).code).toBe(0);

      const second = await runCli(sandbox, ["run", "Add a farewell"], {
        tag: "second",
        promptSubdir: "run2",
      });
      expect(second.code).toBe(0);

      // Nothing is ahead of the target, so there is nothing to continue: a
      // false resume would tell the agent to build on work already shipped.
      const prompt = await readPrompt(sandbox, "run2", "implementation-0.txt");
      expect(prompt).not.toContain("Resuming an interrupted attempt");
      expect((await readEvents(sandbox)).some((event) => event.type === "resumed")).toBe(false);
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("coordinator startup sweep", () => {
  it(
    "moves a card stranded in the in-progress column to Blocked, with an event, and dispatches nothing",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      // A coordinator died with this card in flight; nothing else is on the board.
      await putCardInColumn(sandbox, "In Progress", "- [ ] Half-finished thing");

      const output = await runCoordinatorUntil(
        sandbox,
        async () => (await cardsInColumn(sandbox, "Blocked")).length > 0,
      );

      expect(await cardsInColumn(sandbox, "Blocked")).toEqual(["- [ ] Half-finished thing"]);
      expect(await cardsInColumn(sandbox, "In Progress")).toEqual([]);
      const blocked = (await readEvents(sandbox)).filter((event) => event.type === "blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.data?.reason).toBe(
        "orphaned by a coordinator restart — no run was active",
      );
      // Swept, not silently re-run behind the human's back.
      expect(output).toContain("orphaned by a coordinator restart");
      await expect(fs.readdir(path.join(sandbox.promptDir, "default"))).rejects.toThrow();
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "resumes a swept card once the human readies it again",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      await putCardInColumn(sandbox, "Ready", "- [ ] Fix the parser");

      // First coordinator: Code Review refuses, so the run burns its rounds and
      // the card lands in Blocked with partial work on its branch.
      await runCoordinatorUntil(
        sandbox,
        async () => (await cardsInColumn(sandbox, "Blocked")).length > 0,
        { stubMode: "review-fail", tag: "first", promptSubdir: "run1" },
      );

      // The human reads the note and readies the card again.
      const board = await fs.readFile(boardPath(sandbox), "utf8");
      await fs.writeFile(
        boardPath(sandbox),
        board
          .replace("- [ ] Fix the parser\n", "")
          .replace("## Ready\n", "## Ready\n\n- [ ] Fix the parser\n"),
      );

      const output = await runCoordinatorUntil(
        sandbox,
        async () => (await cardsInColumn(sandbox, "Ready to Merge")).length > 0,
        { tag: "second", promptSubdir: "run2" },
      );

      expect(output).toContain("resuming");
      const prompt = await readPrompt(sandbox, "run2", "implementation-0.txt");
      expect(prompt).toContain("Resuming an interrupted attempt");
      expect(prompt).toContain("3 commits of partial work");
      expect(prompt).toContain("the parser is wrong");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
