/**
 * Acceptance for the coordinator's blocked-by-cycle refusal, exercised against
 * the built CLI (`dist/index.js start`) in a scratch repo under the OS temp dir
 * — the real long-running `jfdi start` process watching a real board, not the
 * `Coordinator` class in-process.
 *
 * A blocked-by loop can never reach Done, so the coordinator must refuse it
 * visibly: every member card moves to the Blocked column and every member's
 * ticket note gets one comment naming the loop and the way out. It must do this
 * once per episode — a board that already holds the refused loop is not
 * re-commented on each scan — and it must dispatch nothing (stub agents never
 * run, so `CAPTURE_DIR/ran.log` staying absent proves no session spawned).
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree; nothing here can
 * reach the real `~/.jfdi`.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findColumn, parseBoard } from "./board.js";
import { git } from "./git.js";
import { parseTicketNote } from "./ticket-note.js";
import { ticketIdFromCard } from "./util/ids.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const SCENARIO_TIMEOUT_MS = 60_000;
/** How long to wait for the coordinator to settle the board into its expected shape. */
const SETTLE_DEADLINE_MS = 30_000;
/** Extra scans to let elapse once settled, to prove the refusal does not repeat. */
const RESCAN_WINDOW_MS = 5_000;
const POLL_INTERVAL_MS = 250;

/** A stub that records every invocation, so an absent log proves no dispatch. */
const RECORDING_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync(process.env.CAPTURE_DIR, { recursive: true });
fs.appendFileSync(process.env.CAPTURE_DIR + "/ran.log", "ran\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
process.exit(0);
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  binDir: string;
  captureDir: string;
  ticketsDir: string;
  boardPath: string;
}

const sandboxes: string[] = [];
const running: ChildProcess[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-cycle-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const captureDir = path.join(root, "capture");
  for (const dir of [project, home, binDir, captureDir]) await fs.mkdir(dir, { recursive: true });
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(binDir, executable), RECORDING_STUB, { mode: 0o755 });
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
    ticketsDir: path.join(project, ".jfdi", "tickets"),
    boardPath: path.join(project, ".jfdi", "board.md"),
  };
  const init = await execFileAsync(process.execPath, [cliPath, "init", "--bare"], {
    cwd: project,
    env: envFor(sandbox),
  });
  expect(init.stderr).not.toContain("Error");
  return sandbox;
}

function envFor(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    CAPTURE_DIR: sandbox.captureDir,
  };
}

async function writeNote(sandbox: Sandbox, id: string, blockedBy: string[]): Promise<void> {
  const frontmatter =
    blockedBy.length === 0
      ? ""
      : `blocked-by:\n${blockedBy.map((target) => `  - "[[${target}]]"`).join("\n")}\n`;
  await fs.writeFile(
    path.join(sandbox.ticketsDir, `${id}.md`),
    `---\n${frontmatter}---\n\n# ${id}\n\nSome work to do.\n`,
  );
}

/** Board with the given ids as cards in the Ready (begin) column. */
async function writeReadyBoard(sandbox: Sandbox, ids: string[]): Promise<void> {
  const cards = ids.map((id) => `- [ ] ${id} [[${id}]]`).join("\n");
  await fs.writeFile(
    sandbox.boardPath,
    `---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n${cards}\n\n## In Progress\n\n## Done\n\n## Blocked\n\n## Ready to Merge\n\n## Inbox\n`,
  );
}

/** Ticket ids in a named board column, in board order. */
async function columnIds(sandbox: Sandbox, column: string): Promise<string[]> {
  const content = await fs.readFile(sandbox.boardPath, "utf8");
  return (findColumn(parseBoard(content), column)?.cards ?? []).map((card) =>
    ticketIdFromCard(card.text),
  );
}

/** The bodies of a ticket note's `## Comments` entries, in order. */
async function noteComments(sandbox: Sandbox, id: string): Promise<string[]> {
  const content = await fs.readFile(path.join(sandbox.ticketsDir, `${id}.md`), "utf8");
  return parseTicketNote(content).comments.map((comment) => comment.body);
}

async function agentRan(sandbox: Sandbox): Promise<boolean> {
  try {
    await fs.access(path.join(sandbox.captureDir, "ran.log"));
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Launch `jfdi start` (no TTY → plain streaming, runs until killed). */
function startCoordinator(sandbox: Sandbox): ChildProcess {
  const child = spawn(process.execPath, [cliPath, "start"], {
    cwd: sandbox.project,
    env: envFor(sandbox),
    stdio: "ignore",
  });
  running.push(child);
  return child;
}

async function stopCoordinator(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGINT");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** Poll `check` until it holds or the deadline passes; returns whether it held. */
async function waitUntil(check: () => Promise<boolean>): Promise<boolean> {
  const deadline = SETTLE_DEADLINE_MS / POLL_INTERVAL_MS;
  for (let attempt = 0; attempt < deadline; attempt += 1) {
    if (await check()) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((child) => stopCoordinator(child)));
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("jfdi start — blocked-by cycle refusal (built CLI)", () => {
  it(
    "moves both members of a two-ticket loop to Blocked, each note commented once",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "a", ["b"]);
      await writeNote(sandbox, "b", ["a"]);
      await writeReadyBoard(sandbox, ["a", "b"]);

      const coordinator = startCoordinator(sandbox);
      const settled = await waitUntil(
        async () => (await columnIds(sandbox, "Blocked")).length === 2,
      );
      expect(settled).toBe(true);
      // Let further scans elapse: a re-scan of the already-refused loop must not
      // append a second comment or re-move the cards.
      await delay(RESCAN_WINDOW_MS);
      await stopCoordinator(coordinator);

      expect(await columnIds(sandbox, "Ready")).toEqual([]);
      expect(await columnIds(sandbox, "Blocked")).toEqual(["a", "b"]);
      const message =
        "Blocked-by loop: a → b → a. A human must break the loop by removing one blocked-by link.";
      expect(await noteComments(sandbox, "a")).toEqual([message]);
      expect(await noteComments(sandbox, "b")).toEqual([message]);
      expect(await agentRan(sandbox)).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "moves all three members of a three-ticket loop to Blocked, each note commented once",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "a", ["b"]);
      await writeNote(sandbox, "b", ["c"]);
      await writeNote(sandbox, "c", ["a"]);
      await writeReadyBoard(sandbox, ["a", "b", "c"]);

      const coordinator = startCoordinator(sandbox);
      const settled = await waitUntil(
        async () => (await columnIds(sandbox, "Blocked")).length === 3,
      );
      expect(settled).toBe(true);
      await delay(RESCAN_WINDOW_MS);
      await stopCoordinator(coordinator);

      expect(await columnIds(sandbox, "Ready")).toEqual([]);
      expect(await columnIds(sandbox, "Blocked")).toEqual(["a", "b", "c"]);
      const message =
        "Blocked-by loop: a → b → c → a. A human must break the loop by removing one blocked-by link.";
      for (const id of ["a", "b", "c"]) {
        expect(await noteComments(sandbox, id)).toEqual([message]);
      }
      expect(await agentRan(sandbox)).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "releases a member once a human breaks the loop by removing a link",
    async () => {
      const sandbox = await makeSandbox();
      await writeNote(sandbox, "a", ["b"]);
      await writeNote(sandbox, "b", ["a"]);
      await writeReadyBoard(sandbox, ["a", "b"]);

      const coordinator = startCoordinator(sandbox);
      const blocked = await waitUntil(
        async () => (await columnIds(sandbox, "Blocked")).length === 2,
      );
      expect(blocked).toBe(true);

      // Both notes carry exactly the one loop comment before the link breaks.
      expect(await noteComments(sandbox, "a")).toHaveLength(1);
      expect(await noteComments(sandbox, "b")).toHaveLength(1);

      // Break the loop the way a human would: strip a's blocked-by link in
      // place, leaving the note's existing comment intact. a stays in Blocked
      // (the tool never drags cards out of Blocked), but it is no longer a cycle
      // member — the loop is not re-refused, so no fresh comment lands on either.
      const aNotePath = path.join(sandbox.ticketsDir, "a.md");
      const aNote = await fs.readFile(aNotePath, "utf8");
      await fs.writeFile(aNotePath, aNote.replace(/blocked-by:\n {2}- "\[\[b\]\]"\n/, ""));
      await delay(RESCAN_WINDOW_MS);
      await stopCoordinator(coordinator);

      // The loop is gone: neither card gains a second loop comment on later scans.
      expect(await noteComments(sandbox, "a")).toHaveLength(1);
      expect(await noteComments(sandbox, "b")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
