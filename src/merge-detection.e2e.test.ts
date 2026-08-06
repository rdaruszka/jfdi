/**
 * End-to-end acceptance for a running coordinator noticing merges it did not
 * perform, and card moves it did not make.
 *
 * The unit tests drive the `Coordinator` class directly with an injected event
 * log, so they cannot see the part that actually has to work in the field: two
 * JFDI *processes* sharing one project's `events.jsonl`, one of them long-lived.
 * These tests spawn the built `jfdi start` in a scratch repo, act on it from
 * outside — `jfdi merge` in a second process, a hand edit of the board — and
 * assert on what a user sees: the board file, `jfdi status`, and the event
 * stream every renderer (the TUI included) is a pure function of.
 *
 * Keeping `jfdi start` alive long enough to be acted on takes a card in flight:
 * a "slow" ticket whose stub session holds open. Without it the process has no
 * live handle and exits as soon as the board is quiet.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
 */
import { type ChildProcess, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { spawnTtyCli, waitFor } from "./test-helpers.js";
// The card-to-ticket-id rule is the product's own; a test that reimplemented
// it would be pinning its own copy, not the one the coordinator looks up.
import { ticketIdFromCard } from "./util/ids.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const SCENARIO_TIMEOUT_MS = 120_000;
/** Cap on every wait below — a condition that never holds fails, never hangs. */
const WAIT_TIMEOUT_MS = 40_000;
const WAIT_STEP_MS = 200;
/** How long the slow ticket's session holds the coordinator process open. */
const SLOW_SESSION_MS = 25_000;
/** Grace between SIGTERM and SIGKILL so a coordinator can kill its sessions. */
const SHUTDOWN_GRACE_MS = 500;

/**
 * The agent both stubbed CLIs play; it never talks to the network. It replays
 * two stream-json lines and writes the verdict file its prompt names. A ticket whose text says
 * "slow" gets an implementation session that sits there, which is how these
 * tests keep the coordinator process alive while they act on it from outside.
 * The wait is inside this process, so killing the session ends it — no orphan.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
// Claude passes the prompt after -p; Codex passes it last. One stub
// answers to both names, so a sandbox needs no second script.
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
// Codex reads a thread id (its absence is an outage) and infers success
// from a final agent message; Claude's parser ignores both lines.
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  // The verdict path lives in the worktree (\`.jfdi/worktrees/<ticket-id>/\`),
  // so the ticket id is the worktree directory's own name.
  const ticketId = process.cwd().split("/").pop();
  let verdict;
  if (stage === "implementation") {
    if (/slow/i.test(prompt)) {
      const slowMs = Number(process.env.STUB_SLOW_MS || "0");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slowMs);
    }
    fs.writeFileSync(process.cwd() + "/" + ticketId + ".txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement " + ticketId], { cwd: process.cwd() });
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
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
  boardPath: string;
}

const sandboxes: string[] = [];
const running: ChildProcess[] = [];

/** Dash-flattened project root, derived here rather than from the module under test. */
function expectedProjectKey(projectRoot: string): string {
  return projectRoot.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-merge-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
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
    stateDir: path.join(jfdiHome, "projects", expectedProjectKey(project)),
    binDir,
    boardPath: path.join(project, ".jfdi", "board.md"),
  };
}

function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_SLOW_MS: String(SLOW_SESSION_MS),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env: sandboxEnv(sandbox),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

interface Coordinator {
  child: ChildProcess;
  isAlive: () => boolean;
  output: () => string;
}

/**
 * Spawn `jfdi start` and resolve once its live TUI renders. Each scenario's
 * board or event condition proves the coordinator completed the relevant scan.
 */
async function startCoordinator(sandbox: Sandbox): Promise<Coordinator> {
  const child = spawnTtyCli(cliPath, ["start"], {
    cwd: sandbox.project,
    env: sandboxEnv(sandbox),
  });
  running.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const coordinator: Coordinator = {
    child,
    isAlive: () => child.exitCode === null && child.signalCode === null,
    output: () => output,
  };
  await waitFor(() => output.includes("JFDI"), {
    timeoutMs: WAIT_TIMEOUT_MS,
    intervalMs: WAIT_STEP_MS,
    describe: () => `start never rendered its TUI: ${output}`,
  });
  return coordinator;
}

function stopCoordinator(coordinator: Coordinator): void {
  coordinator.child.kill("SIGTERM");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

interface RecordedEvent {
  ts: string;
  type: string;
  ticketId?: string;
  origin?: string;
  data?: Record<string, unknown>;
}

async function readEvents(sandbox: Sandbox): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedEvent);
}

function readBoard(sandbox: Sandbox): Promise<string> {
  return fs.readFile(sandbox.boardPath, "utf8");
}

/** The card lines under one column heading, in board order. */
async function columnCards(sandbox: Sandbox, column: string): Promise<string[]> {
  const board = await readBoard(sandbox);
  const section = board.split(`## ${column}\n`)[1] ?? "";
  return section
    .split("\n## ")[0]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ["));
}

async function statusTickets(sandbox: Sandbox): Promise<Record<string, { status: string }>> {
  const status = await runCli(sandbox, ["status", "--json"]);
  expect(status.code, status.stderr).toBe(0);
  const snapshot = JSON.parse(status.stdout) as { tickets: Record<string, { status: string }> };
  return snapshot.tickets;
}

/** Put cards in the begin column of a freshly scaffolded board. */
async function seedBegin(sandbox: Sandbox, cardTexts: string[]): Promise<void> {
  const board = await readBoard(sandbox);
  const cards = cardTexts.map((text) => `- [ ] ${text}`).join("\n");
  await fs.writeFile(sandbox.boardPath, board.replace("## Ready\n", `## Ready\n\n${cards}\n`));
}

/**
 * A report.json on record for a card that never ran in this sandbox, naming
 * the commit its reviews signed off on — the state a run leaves behind.
 */
async function writeReport(sandbox: Sandbox, cardText: string, commit: string): Promise<void> {
  const runDir = path.join(sandbox.stateDir, "runs", ticketIdFromCard(cardText));
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify({
      summary: "signed off",
      decisions: [],
      observations: [],
      testsAdded: "",
      rounds: 1,
      commit,
    }),
  );
}

/** The id of the only ticket the coordinator has run so far. */
async function soleTicketId(sandbox: Sandbox, cardText: string): Promise<string> {
  const tickets = await statusTickets(sandbox);
  const match = Object.keys(tickets).find((id) => id.startsWith(slugPrefix(cardText)));
  if (!match) throw new Error(`no ticket for "${cardText}" in ${Object.keys(tickets).join(", ")}`);
  return match;
}

function slugPrefix(cardText: string): string {
  return cardText.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

afterEach(async () => {
  // SIGTERM first — `jfdi start` kills its live sessions on the way out, so a
  // stub session does not outlive the sandbox it was working in. A test that
  // failed mid-flight never reached its own stop; SIGKILL is only the backstop.
  for (const child of running) child.kill("SIGTERM");
  await sleep(SHUTDOWN_GRACE_MS);
  for (const child of running.splice(0)) child.kill("SIGKILL");
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("a running coordinator and merges it did not perform", () => {
  it(
    "closes the card and converges when another process merges the ticket",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      await seedBegin(sandbox, ["Add feature alpha", "Add a slow feature"]);

      const coordinator = await startCoordinator(sandbox);
      await waitFor(
        async () => (await columnCards(sandbox, "Ready to Merge")).some((c) => c.includes("alpha")),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: WAIT_STEP_MS,
          describe: () => "alpha never reached Ready to Merge",
        },
      );
      const alphaId = await soleTicketId(sandbox, "Add feature alpha");

      // A second process approves it: merges, then deletes the branch — after
      // which nothing in git says the work landed. The coordinator is untouched.
      const merge = await runCli(sandbox, ["merge", alphaId]);
      expect(merge.code, merge.stderr).toBe(0);
      expect(await runCli(sandbox, ["merge", alphaId])).toMatchObject({ code: 1 });

      // The merge command is a board writer too: it closes its own card, and
      // the running coordinator — which can also notice merges it did not
      // perform — must converge on the same board without duplicating anything.
      await waitFor(
        async () => (await columnCards(sandbox, "Done")).some((c) => c.includes("alpha")),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: WAIT_STEP_MS,
          describe: async () => `alpha never reached Done; board:\n${await readBoard(sandbox)}`,
        },
      );
      expect(coordinator.isAlive()).toBe(true);

      expect(await columnCards(sandbox, "Done")).toContain("- [x] Add feature alpha");
      expect(await columnCards(sandbox, "Ready to Merge")).toEqual([]);
      expect((await statusTickets(sandbox))[alphaId]?.status).toBe("done");

      // Two processes on one stream: the merge and the close are both the
      // merger's; the coordinator, seeing the card already settled, adds nothing.
      const events = await readEvents(sandbox);
      const merged = events.filter((e) => e.type === "merged" && e.ticketId === alphaId);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.data?.note).toBeUndefined();
      expect(events.some((e) => e.type === "card_moved" && e.ticketId === alphaId)).toBe(true);

      stopCoordinator(coordinator);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "acknowledges a card the human drags out of Ready to Merge",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      await seedBegin(sandbox, ["Add feature beta", "Add a slow feature"]);

      const coordinator = await startCoordinator(sandbox);
      await waitFor(
        async () => (await columnCards(sandbox, "Ready to Merge")).some((c) => c.includes("beta")),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: WAIT_STEP_MS,
          describe: () => "beta never reached Ready to Merge",
        },
      );
      const betaId = await soleTicketId(sandbox, "Add feature beta");
      expect((await statusTickets(sandbox))[betaId]?.status).toBe("merge-ready");

      // The human drags the card to Done in their editor — the approval answered
      // on the board, with nothing told to JFDI.
      const board = await readBoard(sandbox);
      const card = "- [ ] Add feature beta\n";
      await fs.writeFile(
        sandbox.boardPath,
        board.replace(card, "").replace("## Done\n", `## Done\n${card}`),
      );

      await waitFor(async () => (await statusTickets(sandbox))[betaId]?.status === "done", {
        timeoutMs: WAIT_TIMEOUT_MS,
        intervalMs: WAIT_STEP_MS,
        describe: async () => `beta still ${(await statusTickets(sandbox))[betaId]?.status}`,
      });
      expect(coordinator.isAlive()).toBe(true);

      const closing = (await readEvents(sandbox)).filter(
        (e) => e.type === "done" && e.ticketId === betaId,
      );
      expect(closing).toHaveLength(1);
      expect(closing[0]?.data?.note).toContain("Done");
      // Only the dragged card was answered: nothing closed the ticket still in flight.
      const slowId = await soleTicketId(sandbox, "Add a slow feature");
      expect((await statusTickets(sandbox))[slowId]?.status).toBe("running");

      stopCoordinator(coordinator);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "closes the card when the human merges the branch by hand and deletes it",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      await seedBegin(sandbox, ["Add feature epsilon", "Add a slow feature"]);

      const coordinator = await startCoordinator(sandbox);
      await waitFor(
        async () =>
          (await columnCards(sandbox, "Ready to Merge")).some((c) => c.includes("epsilon")),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: WAIT_STEP_MS,
          describe: () => "epsilon never reached Ready to Merge",
        },
      );
      const epsilonId = await soleTicketId(sandbox, "Add feature epsilon");

      // The human approves it the other way: no `jfdi merge`, just git. Nothing
      // writes a `merged` event, and the tidy-up removes the branch that would
      // otherwise prove the work landed.
      await git(sandbox.project, "worktree", "remove", "--force", `.jfdi/worktrees/${epsilonId}`);
      await git(sandbox.project, "merge", "--no-ff", "-m", "merge by hand", `jfdi/${epsilonId}`);
      await git(sandbox.project, "branch", "-D", `jfdi/${epsilonId}`);

      // Touch the board so the mtime poll runs a scan, as saving it would.
      const now = new Date();
      await fs.utimes(sandbox.boardPath, now, now);

      await waitFor(
        async () => (await columnCards(sandbox, "Done")).some((c) => c.includes("epsilon")),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: WAIT_STEP_MS,
          describe: async () => `epsilon never reached Done; board:\n${await readBoard(sandbox)}`,
        },
      );
      expect(coordinator.isAlive()).toBe(true);

      expect(await columnCards(sandbox, "Done")).toContain("- [x] Add feature epsilon");
      expect(await columnCards(sandbox, "Ready to Merge")).toEqual([]);
      expect((await statusTickets(sandbox))[epsilonId]?.status).toBe("done");

      // Exactly one closing event: the sweep must not keep re-closing the card.
      const merged = (await readEvents(sandbox)).filter(
        (e) => e.type === "merged" && e.ticketId === epsilonId,
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]?.data?.note).toContain("merged outside the pipeline");

      stopCoordinator(coordinator);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "leaves a Ready-to-Merge card alone when nothing records a merge",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      // A card waiting for approval whose branch is missing and whose work never
      // landed: a deleted branch is not by itself evidence of a merge.
      const board = await readBoard(sandbox);
      await fs.writeFile(
        sandbox.boardPath,
        board.replace("## Ready to Merge\n", "## Ready to Merge\n\n- [ ] Add feature gamma\n"),
      );

      const coordinator = await startCoordinator(sandbox);
      // Give the initial scan and the mtime poll a couple of turns before
      // believing the card was left alone.
      await sleep(WAIT_STEP_MS * 10);

      expect(await columnCards(sandbox, "Ready to Merge")).toEqual(["- [ ] Add feature gamma"]);
      expect(await columnCards(sandbox, "Done")).toEqual([]);
      expect(coordinator.output()).not.toContain("\x1b[32mmerged\x1b[0m");

      stopCoordinator(coordinator);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "asks git about the sign-off commit without trusting the report or stalling on it",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      // Two cards waiting for approval, each with a report on record and no
      // branch left, and one card waiting to be dispatched behind them.
      const board = await readBoard(sandbox);
      await fs.writeFile(
        sandbox.boardPath,
        board
          .replace(
            "## Ready to Merge\n",
            "## Ready to Merge\n\n- [ ] Add feature ghost\n- [ ] Add feature sidetrack\n",
          )
          .replace("## Ready\n", "## Ready\n\n- [ ] Add feature zulu\n"),
      );
      // sidetrack's sign-off commit is real but never reached the target;
      // ghost's is a sha git cannot resolve at all, which `git merge-base` errors
      // on rather than answering. Neither is evidence that the work landed.
      await git(sandbox.project, "checkout", "-b", "sidetrack");
      await fs.writeFile(path.join(sandbox.project, "side.txt"), "side\n");
      await git(sandbox.project, "add", "-A");
      await git(sandbox.project, "commit", "-m", "side work");
      const parked = (await git(sandbox.project, "rev-parse", "HEAD")).trim();
      await git(sandbox.project, "checkout", "main");
      await writeReport(sandbox, "Add feature ghost", "d".repeat(40));
      await writeReport(sandbox, "Add feature sidetrack", parked);

      const coordinator = await startCoordinator(sandbox);
      // The scan that swept those two also has a card to dispatch: an
      // unanswerable question must not take the rest of the scan down with it.
      await waitFor(
        async () => (await columnCards(sandbox, "Ready to Merge")).some((c) => c.includes("zulu")),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: WAIT_STEP_MS,
          describe: async () => `zulu never ran; board:\n${await readBoard(sandbox)}`,
        },
      );

      expect(await columnCards(sandbox, "Ready to Merge")).toEqual(
        expect.arrayContaining(["- [ ] Add feature ghost", "- [ ] Add feature sidetrack"]),
      );
      expect(await columnCards(sandbox, "Done")).toEqual([]);
      const events = await readEvents(sandbox);
      expect(events.filter((e) => e.type === "merged")).toEqual([]);
      expect(events.filter((e) => e.type === "error")).toEqual([]);

      stopCoordinator(coordinator);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
