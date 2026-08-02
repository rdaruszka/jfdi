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
import { type ChildProcess, execFile, spawn } from "node:child_process";
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
const SCENARIO_TIMEOUT_MS = 120_000;
/** Cap on every wait below — a condition that never holds fails, never hangs. */
const WAIT_TIMEOUT_MS = 40_000;
const WAIT_STEP_MS = 200;
/** How long the slow ticket's session holds the coordinator process open. */
const SLOW_SESSION_MS = 25_000;
/** Grace between SIGTERM and SIGKILL so a coordinator can kill its sessions. */
const SHUTDOWN_GRACE_MS = 500;

/**
 * A `claude` that never talks to the network: it replays two stream-json lines
 * and writes the verdict file its prompt names. A ticket whose text says
 * "slow" gets an implementation session that sits there, which is how these
 * tests keep the coordinator process alive while they act on it from outside.
 * The wait is inside this process, so killing the session ends it — no orphan.
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
  const ticketId = verdictPath.split("/runs/")[1].split("/")[0];
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
 * Spawn `jfdi start` and resolve once its initial board scan is done — the
 * banner is printed after `start()` resolves, so anything asserted afterwards
 * is asserted against a coordinator that has already looked at the board.
 */
async function startCoordinator(sandbox: Sandbox): Promise<Coordinator> {
  const child = spawn(process.execPath, [cliPath, "start"], {
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
  await waitFor(
    () => output.includes("watching the board"),
    () => `start never began watching: ${output}`,
  );
  return coordinator;
}

function stopCoordinator(coordinator: Coordinator): void {
  coordinator.child.kill("SIGTERM");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Poll a condition to a hard time cap; the message describes what never held. */
async function waitFor(
  isSatisfied: () => boolean | Promise<boolean>,
  describeFailure: () => string | Promise<string>,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isSatisfied()) return;
    await sleep(WAIT_STEP_MS);
  }
  throw new Error(`waited ${WAIT_TIMEOUT_MS}ms: ${await describeFailure()}`);
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

beforeAll(async () => {
  // Always rebuild: a stale dist/ would let these pass against old behavior.
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot });
}, BUILD_TIMEOUT_MS);

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
        () => "alpha never reached Ready to Merge",
      );
      const alphaId = await soleTicketId(sandbox, "Add feature alpha");

      // A second process approves it: merges, then deletes the branch — after
      // which nothing in git says the work landed. The coordinator is untouched.
      const merge = await runCli(sandbox, ["merge", alphaId]);
      expect(merge.code, merge.stderr).toBe(0);
      expect(await runCli(sandbox, ["merge", alphaId])).toMatchObject({ code: 1 });

      // No restart, no board edit: the running coordinator has to notice.
      await waitFor(
        async () => (await columnCards(sandbox, "Done")).some((c) => c.includes("alpha")),
        async () => `alpha never reached Done; board:\n${await readBoard(sandbox)}`,
      );
      expect(coordinator.isAlive()).toBe(true);

      expect(await columnCards(sandbox, "Done")).toContain("- [x] Add feature alpha");
      expect(await columnCards(sandbox, "Ready to Merge")).toEqual([]);
      expect((await statusTickets(sandbox))[alphaId]?.status).toBe("done");

      // Two processes on one stream: the merge is recorded by the one that did
      // it, the close by the one that noticed — in that order.
      const events = await readEvents(sandbox);
      const merged = events.filter((e) => e.type === "merged" && e.ticketId === alphaId);
      expect(merged).toHaveLength(2);
      const [byMerger, byCoordinator] = merged;
      expect(byMerger?.data?.note).toBeUndefined();
      expect(byCoordinator?.data?.note).toContain("merged outside the pipeline");
      expect(byCoordinator?.origin).not.toBe(byMerger?.origin);
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
        () => "beta never reached Ready to Merge",
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

      await waitFor(
        async () => (await statusTickets(sandbox))[betaId]?.status === "done",
        async () => `beta still ${(await statusTickets(sandbox))[betaId]?.status}`,
      );
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
      // The banner means the initial scan already ran; give the mtime poll a
      // couple of turns as well before believing the card was left alone.
      await sleep(WAIT_STEP_MS * 10);

      expect(await columnCards(sandbox, "Ready to Merge")).toEqual(["- [ ] Add feature gamma"]);
      expect(await columnCards(sandbox, "Done")).toEqual([]);
      expect(coordinator.output()).not.toContain("merged");

      stopCoordinator(coordinator);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
