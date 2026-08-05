/**
 * Acceptance for resuming an interrupted run, driven through the built CLI.
 *
 * The unit tests cover the pieces (prepareResume, formatResumeSection, the
 * history file) with injected fixtures. What they cannot see is whether the
 * shipped artifact wires them together: whether the prompt that actually
 * reaches an agent session says "you are resuming", whether the checkpoint
 * commit really lands before the first session starts, and whether a restarted
 * coordinator really moves a stranded card. These drive `dist/index.js` in a
 * scratch repo under the OS temp dir with stub `claude` and `codex` binaries on
 * PATH, and assert on
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
import { afterEach, describe, expect, it } from "vitest";
import { git, isMergeInProgress, mergeTargetIntoBranch } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const PIPELINE_TIMEOUT_MS = 120_000;
/** How long a spawned coordinator gets to reach the state a test waits for. */
const COORDINATOR_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;
/**
 * How long a paused CLI must still be running to count as held. A process with
 * nothing referenced on its event loop exits within a tick, so this only has to
 * clear that by an obvious margin — and it is far short of any resume schedule,
 * so a CLI still alive here is held rather than merely between probes.
 */
const HOLD_PROOF_MS = 3_000;
/** A pause short enough that a test can wait out the real thing. */
const RESUME_SOON_MS = 50;

/**
 * The agent both stubbed CLIs play; it never talks to the network. Beyond
 * replaying stream-json and
 * writing the verdict its prompt names, it records two things the assertions
 * need: the full prompt text it was handed, and — for the implementation stage
 * — `git status --porcelain` as the session found the worktree, which is the
 * only way to observe "the agent started from a clean tree" from outside.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
// Claude passes the prompt after -p; Codex passes it last. One stub
// answers to both names, so a sandbox needs no second script.
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
// Codex reads a thread id (its absence is an outage) and infers success
// from a final agent message; Claude's parser ignores both lines.
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
// The scribe answers in its result text: the summary the session reported,
// which is what a real scribe turns into a subject line.
const scribedSummary = /## What the session said it did\\n\\n(.*)/.exec(prompt);
const resultText = prompt.includes("Write the commit message") && scribedSummary
  ? scribedSummary[1]
  : "done";
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }) + "\\n"));
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const promptDir = process.env.STUB_PROMPT_DIR;
const RESET_SECONDS_AHEAD = 3600;
// Provider-down modes: the session dies the way a real one does — a result
// line the harness classifies, no verdict file, nonzero exit.
function die(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result }) + "\\n");
  process.exit(1);
}
// Every spawn announces itself, so a test can prove the tool stopped spawning.
fs.mkdirSync(promptDir, { recursive: true });
fs.appendFileSync(path.join(promptDir, "spawns.log"), "spawn\\n");
if (process.env.STUB_MODE === "usage-limit") {
  die("Claude AI usage limit reached|" + (Math.floor(Date.now() / 1000) + RESET_SECONDS_AHEAD));
}
if (process.env.STUB_MODE === "needs-human") {
  die("API Error: Invalid API key · Please run /login");
}
if (process.env.STUB_MODE === "outage-once") {
  const marker = path.join(promptDir, "outage-used");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "1");
    die("API Error: Connection error.");
  }
}
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = path.basename(verdictPath).replace(".verdict.json", "");
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
    verdict = { status: "done", summary: "implemented " + process.env.STUB_TAG };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else if (stage === "code-review" && process.env.STUB_MODE === "review-fail") {
    verdict = { verdict: "fail", feedback: "the parser is wrong" };
  } else if (stage === "code-review" && process.env.STUB_MODE === "review-fail-round-1") {
    // This run's first review fails, later ones pass; the per-run prompt
    // directory's index is the round counter (one review session per round).
    verdict = index === 0 ? { verdict: "fail", feedback: "still the wrong parser" } : { verdict: "pass" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
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
  // Both CLIs the scaffolded config selects, played by the same script:
  // the default mix reviews on Codex and implements on Claude.
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
  // Polled while a coordinator is still starting up, so "not written yet" is
  // an ordinary answer: no events.
  const raw = await fs
    .readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8")
    .catch(() => "");
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

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * A CLI still running: `jfdi start` watches forever by design, and a paused
 * `jfdi run` holds until a human ends it, so both can only be observed from
 * the outside while they are alive.
 */
interface LiveCli {
  child: ReturnType<typeof spawn>;
  output: () => string;
  exited: Promise<Ended>;
}

function spawnCli(sandbox: Sandbox, args: string[], options: StubOptions = {}): LiveCli {
  const child = spawn(process.execPath, [cliPath, ...args], {
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
  return {
    child,
    output: () => output,
    exited: new Promise<Ended>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Poll until `isReady` holds. Bounded by a deadline, so a stuck CLI fails the test. */
async function waitUntil(isReady: () => Promise<boolean>, describe: () => string): Promise<void> {
  const deadline = Date.now() + COORDINATOR_TIMEOUT_MS;
  // Terminates: the deadline shrinks the remaining time every pass.
  while (Date.now() < deadline) {
    if (await isReady()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(describe());
}

/** Run the coordinator until `isReady` holds, then signal it down. */
async function runCoordinatorUntil(
  sandbox: Sandbox,
  isReady: () => Promise<boolean>,
  options: StubOptions = {},
): Promise<string> {
  const coordinator = spawnCli(sandbox, ["start"], options);
  try {
    await waitUntil(
      isReady,
      () => `coordinator never reached the expected state. Output:\n${coordinator.output()}`,
    );
    return coordinator.output();
  } finally {
    coordinator.child.kill("SIGTERM");
    await coordinator.exited;
  }
}

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
      expect(resumedPrompt).toContain("implemented first");
      expect(resumedPrompt).not.toContain("implemented second");
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
        hasAbortedMerge: false,
      });
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "sanitizes a worktree a killed run left dirty and mid-merge before the first session",
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

      // What a session killed mid-flight leaves behind: a conflicted merge and
      // edits that never got committed.
      await fs.writeFile(path.join(worktree, "README.md"), "branch version\n");
      await git(worktree, "commit", "-am", "branch edit");
      await fs.writeFile(path.join(sandbox.project, "README.md"), "main version\n");
      await git(sandbox.project, "commit", "-am", "main edit");
      expect((await mergeTargetIntoBranch(worktree, "main")).hasConflict).toBe(true);
      expect(await isMergeInProgress(worktree)).toBe(true);
      await fs.writeFile(path.join(worktree, "salvaged.txt"), "half-written\n");

      const second = await runCli(sandbox, ["run", "Add a greeting"], {
        tag: "second",
        promptSubdir: "run2",
      });
      expect(second.code).toBe(0);

      // The agent found a clean, committed tree — not a conflicted one.
      expect(await readPrompt(sandbox, "run2", "tree-at-first-session.txt")).toBe("");
      expect(await isMergeInProgress(worktree)).toBe(false);
      // The merge was undone, not resolved: the branch's own edit survived.
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
      expect(prompt).toContain("merge of `main` into this branch was aborted");

      // And the event stream records the recovery, not just the resume.
      const resumed = (await readEvents(sandbox)).filter((event) => event.type === "resumed");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.data).toMatchObject({
        hasCheckpointedChanges: true,
        hasAbortedMerge: true,
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

describe("coordinator startup", () => {
  it(
    "continues a card stranded in the in-progress column, without a board edit",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      // A coordinator died with this card in flight; nothing else is on the board.
      await putCardInColumn(sandbox, "In Progress", "- [ ] Half-finished thing");

      await runCoordinatorUntil(
        sandbox,
        async () => (await cardsInColumn(sandbox, "Ready to Merge")).length > 0,
      );

      // Picked back up where it stood — not flagged for the human to drag back.
      expect(await cardsInColumn(sandbox, "Ready to Merge")).toEqual(["- [ ] Half-finished thing"]);
      expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);
      expect(await fs.readdir(path.join(sandbox.promptDir, "default"))).toContain(
        "implementation-0.txt",
      );
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "resumes a blocked card once the human readies it again",
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

/**
 * The provider under the harness going down, driven through the shipped CLI.
 * The unit tests prove the classifier and the controller; only this can show
 * that a usage limit really stops the tool instead of draining the board, and
 * that stopping and restarting JFDI is not itself an event the board records.
 */
describe("a provider that is down", () => {
  async function hasPaused(sandbox: Sandbox): Promise<boolean> {
    return (await readEvents(sandbox)).some((event) => event.type === "harness_paused");
  }

  it(
    "pauses instead of blocking, and a restart picks the card back up",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      await putCardInColumn(sandbox, "Ready", "- [ ] Fix the parser");

      // Every session dies on a usage limit whose reset is an hour out, so the
      // pause outlives this coordinator.
      await runCoordinatorUntil(sandbox, () => hasPaused(sandbox), {
        stubMode: "usage-limit",
        promptSubdir: "down",
      });

      const paused = (await readEvents(sandbox)).filter((event) => event.type === "harness_paused");
      expect(paused[0]?.data?.kind).toBe("usage-limit");
      expect(typeof paused[0]?.data?.resumesAt).toBe("string");
      // Held where it stood: nothing blocked, nothing dispatched past the wall.
      expect(await cardsInColumn(sandbox, "In Progress")).toEqual(["- [ ] Fix the parser"]);
      expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);

      // Ctrl-C during the pause, restarted while the provider is still down:
      // it pauses again rather than treating the restart as progress.
      const pausesBefore = paused.length;
      await runCoordinatorUntil(
        sandbox,
        async () =>
          (await readEvents(sandbox)).filter((event) => event.type === "harness_paused").length >
          pausesBefore,
        { stubMode: "usage-limit", promptSubdir: "down-again" },
      );
      expect(await cardsInColumn(sandbox, "In Progress")).toEqual(["- [ ] Fix the parser"]);
      expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);

      // Restarted once the provider is healthy: the same card, still in the
      // in-progress column, runs to completion with no board edit by a human.
      await runCoordinatorUntil(
        sandbox,
        async () => (await cardsInColumn(sandbox, "Ready to Merge")).length > 0,
        { tag: "healthy", promptSubdir: "healthy" },
      );
      expect(await cardsInColumn(sandbox, "Ready to Merge")).toEqual(["- [ ] Fix the parser"]);
      expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);
      // Nothing was ever blocked for an infrastructure reason.
      expect((await readEvents(sandbox)).filter((event) => event.type === "blocked")).toEqual([]);
    },
    COORDINATOR_TIMEOUT_MS * 3,
  );

  /** How many sessions the stub was asked for, across every run in a sandbox. */
  async function spawnCount(sandbox: Sandbox, subdir: string): Promise<number> {
    const log = await fs
      .readFile(path.join(sandbox.promptDir, subdir, "spawns.log"), "utf8")
      .catch(() => "");
    return log.split("\n").filter(Boolean).length;
  }

  it(
    "waits for a human on a repair only a human can make, and probes nothing meanwhile",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      await putCardInColumn(sandbox, "Ready", "- [ ] Fix the parser");

      await runCoordinatorUntil(sandbox, () => hasPaused(sandbox), {
        stubMode: "needs-human",
        promptSubdir: "login",
      });

      // No reset time to offer and no retry worth making: the banner names the
      // repair, and the tool asks the human rather than hammering the provider.
      const paused = (await readEvents(sandbox)).filter((event) => event.type === "harness_paused");
      expect(paused).toHaveLength(1);
      expect(paused[0]?.data?.kind).toBe("needs-human");
      expect(paused[0]?.data?.resumesAt).toBeUndefined();
      expect(paused[0]?.data?.detail).toContain("run /login");
      expect(await spawnCount(sandbox, "login")).toBe(1);
      expect(await cardsInColumn(sandbox, "In Progress")).toEqual(["- [ ] Fix the parser"]);
      expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);

      // The human repairs the login and starts JFDI again — no board edit, and
      // the card it left in flight runs to completion.
      await runCoordinatorUntil(
        sandbox,
        async () => (await cardsInColumn(sandbox, "Ready to Merge")).length > 0,
        { tag: "repaired", promptSubdir: "repaired" },
      );
      expect(await cardsInColumn(sandbox, "Ready to Merge")).toEqual(["- [ ] Fix the parser"]);
      expect((await readEvents(sandbox)).filter((event) => event.type === "blocked")).toEqual([]);
    },
    COORDINATOR_TIMEOUT_MS * 2,
  );

  it(
    "keeps a needs-human pause alive with no TTY, where nothing else would hold it",
    async () => {
      // The pause with no resume instant is the one that has nothing of its
      // own to wait on, and redirected output means no TTY listening to stdin
      // either. If the pause does not hold the process open itself, the run is
      // abandoned mid-round — silently, since it looks like an ordinary exit.
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = spawnCli(sandbox, ["run", "Fix the parser"], {
        stubMode: "needs-human",
        promptSubdir: "held-run",
      });
      try {
        await waitUntil(
          () => hasPaused(sandbox),
          () => `jfdi run never paused. Output:\n${run.output()}`,
        );
        await sleep(HOLD_PROOF_MS);
        expect({ code: run.child.exitCode, signal: run.child.signalCode }).toEqual({
          code: null,
          signal: null,
        });

        // …and Ctrl-C still ends it: without a TTY there is no raw mode, so
        // the signal is a signal and nothing here swallows it.
        run.child.kill("SIGINT");
        const ended = await run.exited;
        expect(ended.signal ?? ended.code).toBeTruthy();
      } finally {
        run.child.kill("SIGKILL");
      }
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "keeps a paused coordinator alive with no TTY, its card still in flight",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      await putCardInColumn(sandbox, "Ready", "- [ ] Fix the parser");
      const coordinator = spawnCli(sandbox, ["start"], {
        stubMode: "needs-human",
        promptSubdir: "held-start",
      });
      try {
        await waitUntil(
          () => hasPaused(sandbox),
          () => `coordinator never paused. Output:\n${coordinator.output()}`,
        );
        await sleep(HOLD_PROOF_MS);
        // A coordinator that quits under its own pause stops watching the
        // board and drops every run it was holding.
        expect(coordinator.child.exitCode).toBe(null);
        expect(await cardsInColumn(sandbox, "In Progress")).toEqual(["- [ ] Fix the parser"]);
        expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);
      } finally {
        coordinator.child.kill("SIGTERM");
        await coordinator.exited;
      }
    },
    PIPELINE_TIMEOUT_MS,
  );

  /**
   * The other half of holding the event loop open: what a pause takes, it has
   * to give back. A keepalive that outlives its pause would not abandon a run
   * — it would strand a finished one, leaving `jfdi run` printing "Pipeline
   * passed" and never returning to the shell. Fake timer counts prove the
   * handle was cleared; only a real process proves nothing else holds it.
   */
  it(
    "lets the process exit again once the pause it was holding has resumed",
    async () => {
      const script = `
        const { PauseController } = await import(${JSON.stringify(path.join(repoRoot, "dist", "pause.js"))});
        const pause = new PauseController({ emit: () => undefined }, {
          outageStageRetryMs: [],
          probeMs: [${RESUME_SOON_MS}],
          usageLimitBufferMs: 0,
          maxWaitMs: 60_000,
        });
        await pause.holdAfterFailure({ kind: "usage-limit", resetsAtMs: null, detail: "spend cap" }, 1);
        console.log("resumed");
      `;
      const startedAtMs = Date.now();
      const { stdout } = await execFileAsync(process.execPath, [
        "--input-type=module",
        "-e",
        script,
      ]);

      expect(stdout).toContain("resumed");
      // Held for the pause and not a moment longer: a leaked handle would keep
      // this process alive until the test's own timeout killed it.
      expect(Date.now() - startedAtMs).toBeLessThan(HOLD_PROOF_MS);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "`jfdi run` holds and re-runs the same stage, at no cost in rounds",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const result = await runCli(sandbox, ["run", "Fix the parser"], {
        stubMode: "outage-once",
        promptSubdir: "run1",
      });
      expect(`${result.code} ${result.stderr}`).toBe("0 ");

      // The dead session was reported as harness trouble, not fed back as work.
      expect(result.stdout).toContain("harness outage");
      const prompt = await readPrompt(sandbox, "run1", "implementation-0.txt");
      expect(prompt).not.toContain("Feedback on earlier attempts");
      const rounds = (await readEvents(sandbox)).filter((event) => event.type === "round_start");
      expect(rounds).toHaveLength(1);
      expect(await cardsInColumn(sandbox, "Blocked")).toEqual([]);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
