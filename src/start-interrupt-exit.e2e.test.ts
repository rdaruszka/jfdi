/**
 * End-to-end acceptance for the `jfdi start` symptom of jfdi-hangs-on-exit: a
 * single Ctrl-C shuts the tool down and returns the shell prompt — no second
 * Ctrl-C, no manual kill.
 *
 * The bug only shows with work in flight. Ink's own Ctrl-C handling unmounts the
 * TUI but neither stops the coordinator nor exits; with a live agent session
 * holding the event loop open, the process then sits there until a second Ctrl-C
 * reaches the signal handler. The fix takes Ctrl-C away from Ink
 * (`exitOnCtrlC: false`), routes the raw-mode keypress through coordinator
 * shutdown, and terminates once cleanup has run.
 *
 * So this test keeps `jfdi start` busy with a slow ticket, sends exactly one
 * Ctrl-C byte on the TUI's stdin, and asserts the process exits with the
 * interrupt code inside a bound. `spawnTtyCli` presents pipes to Ink as a
 * terminal; the built artifact is exercised, and the stub agents never touch the
 * network. `JFDI_HOME`/`HOME` stay inside the scratch tree.
 */
import { type ChildProcess, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { spawnTtyCli, waitFor } from "./test-helpers.js";
import { EXIT_SIGINT } from "./util/exit-codes.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(projectRoot, "dist", "index.js");

const SCENARIO_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 40_000;
const WAIT_STEP_MS = 200;
/** Long enough that the slow session is still in flight when Ctrl-C lands. */
const SLOW_SESSION_MS = 30_000;
/** Cap on the wait for the process to exit after one Ctrl-C — a hang fails here. */
const EXIT_AFTER_INTERRUPT_MS = 15_000;

/**
 * The agent both stubbed CLIs play. It replays a couple of stream-json lines and
 * writes the verdict its prompt names; a ticket whose text says "slow" gets an
 * implementation session that blocks in-process, which is how this test keeps
 * the coordinator alive with a live child to interrupt over.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  const ticketId = process.cwd().split("/").pop();
  let verdict;
  if (stage === "implementation") {
    if (/slow/i.test(prompt)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLOW_MS || "0"));
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
  projectRoot: string;
  home: string;
  jfdiHome: string;
  stateDirectory: string;
  executableDirectory: string;
  boardPath: string;
}

const sandboxes: string[] = [];
const running: ChildProcess[] = [];

function expectedProjectKey(root: string): string {
  return root.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-interrupt-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    projectRoot,
    home,
    jfdiHome,
    stateDirectory: path.join(jfdiHome, "projects", expectedProjectKey(projectRoot)),
    executableDirectory,
    boardPath: path.join(projectRoot, ".jfdi", "board.md"),
  };
}

function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_SLOW_MS: String(SLOW_SESSION_MS),
  };
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env: sandboxEnv(sandbox),
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "" };
  }
}

async function seedBegin(sandbox: Sandbox, cardText: string): Promise<void> {
  const board = await fs.readFile(sandbox.boardPath, "utf8");
  await fs.writeFile(
    sandbox.boardPath,
    board.replace("## Ready\n", `## Ready\n\n- [ ] ${cardText}\n`),
  );
}

async function runningTicketCount(sandbox: Sandbox): Promise<number> {
  const status = await runCli(sandbox, ["status", "--json"]);
  if (status.code !== 0) return 0;
  const snapshot = JSON.parse(status.stdout) as { tickets: Record<string, { status: string }> };
  return Object.values(snapshot.tickets).filter((ticket) => ticket.status === "running").length;
}

afterEach(async () => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("a single Ctrl-C exits jfdi start with work in flight", () => {
  it(
    "shuts down and returns the interrupt code on one Ctrl-C, no second signal",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      await seedBegin(sandbox, "Add a slow feature");

      const child = spawnTtyCli(cliPath, ["start"], {
        cwd: sandbox.projectRoot,
        env: sandboxEnv(sandbox),
      });
      running.push(child);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      // Wait until the TUI is up and the slow session is actually in flight —
      // an idle coordinator has no live handle and the bug would not show.
      await waitFor(() => output.includes("JFDI"), {
        timeoutMs: WAIT_TIMEOUT_MS,
        intervalMs: WAIT_STEP_MS,
        describe: () => `start never rendered its TUI: ${output}`,
      });
      await waitFor(async () => (await runningTicketCount(sandbox)) > 0, {
        timeoutMs: WAIT_TIMEOUT_MS,
        intervalMs: WAIT_STEP_MS,
        describe: () => "the slow session never reached running",
      });

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      // Exactly one Ctrl-C — raw mode delivers it as this byte, not a signal.
      child.stdin?.write("\x03");

      const outcome = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), EXIT_AFTER_INTERRUPT_MS),
        ),
      ]);

      expect(outcome, "a single Ctrl-C did not exit jfdi start").not.toBe("timeout");
      // Signal-convention exit code for SIGINT: cleanup ran, then the process left.
      expect(outcome).toMatchObject({ code: EXIT_SIGINT });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
