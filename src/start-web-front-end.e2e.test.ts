/**
 * Acceptance for the web front end of `jfdi start`, exercised against the built
 * CLI (`dist/index.js start`) in a scratch repo under the OS temp dir, with stub
 * `claude`/`codex` binaries on PATH — the outside-in view a human opening the
 * printed URL in a browser gets.
 *
 * Unlike the default terminal front end (which refuses without a TTY, covered by
 * start-tty-refusal.e2e.test.ts), the web front end is meant to run headless:
 * these scenarios launch it with plain pipes (no TTY) precisely to prove it does.
 * They cover the acceptance criteria the unit tests cannot reach end-to-end:
 *
 *   - `--front-end web` and the config `frontEnd: "web"` setting each select the
 *     web front end for a real coordinator, and the CLI path prints its URL.
 *   - The URL binds loopback only (`127.0.0.1`), so the server is reachable only
 *     from the local machine by default.
 *   - The served page is read-only: a POST is rejected and the markup carries no
 *     button/form/input control.
 *   - A card seeded in the begin column is dispatched, run, and merged while the
 *     coordinator works, and every transition streams live to a connected client
 *     over Server-Sent Events with no manual refresh — the same picture the TUI
 *     renders (board name, target branch, per-ticket status).
 *   - Stopping `jfdi start` (SIGINT / SIGTERM) stops the web server, exits with
 *     the signal's conventional code, and frees the port it was bound to.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree, and the stub agents
 * never touch the network — nothing here can reach the real `~/.jfdi` or a real
 * provider.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { waitFor } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

const projectRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(projectRoot, "dist", "index.js");

const SCENARIO_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

/**
 * The agent both stubbed CLIs play. It replays a couple of stream-json lines and
 * writes the verdict file its prompt names; the implementation stage also commits
 * so there is a real commit to review, gate, and merge. Never talks to the
 * network — the same shape run-card-moves.e2e uses, trimmed to what a passing run
 * needs.
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

const TICKET_ID = "watch-web";
const CARD_LINE = `- [ ] Watch via web [[${TICKET_ID}]]`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
  boardPath: string;
  configPath: string;
}

const sandboxes: string[] = [];
const children: ChildProcess[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-web-e2e-"));
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
  const sandbox: Sandbox = {
    root,
    projectRoot,
    home,
    jfdiHome,
    executableDirectory,
    boardPath: path.join(projectRoot, ".jfdi", "board.md"),
    configPath: path.join(projectRoot, ".jfdi", "config.json"),
  };
  const init = await execFileAsync(process.execPath, [cliPath, "init", "--bare"], {
    cwd: projectRoot,
    env: envFor(sandbox),
  });
  expect(init.stderr).not.toContain("Error");
  await fs.writeFile(
    path.join(projectRoot, ".jfdi", "tickets", `${TICKET_ID}.md`),
    `# Watch via web\n\nAdd the feature the web front end will show being built.\n`,
  );
  return sandbox;
}

function envFor(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
  };
}

/** Auto merge so a passing run lands the branch and the ticket reaches "done". */
async function setAutoMerge(sandbox: Sandbox): Promise<void> {
  const config = JSON.parse(await fs.readFile(sandbox.configPath, "utf8")) as {
    integration: { mode: string };
    frontEnd?: string;
  };
  config.integration.mode = "auto";
  await fs.writeFile(sandbox.configPath, JSON.stringify(config, null, 2));
}

async function setConfigFrontEnd(sandbox: Sandbox, frontEnd: string): Promise<void> {
  const config = JSON.parse(await fs.readFile(sandbox.configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.frontEnd = frontEnd;
  await fs.writeFile(sandbox.configPath, JSON.stringify(config, null, 2));
}

async function seedReadyCard(sandbox: Sandbox): Promise<void> {
  const board = await fs.readFile(sandbox.boardPath, "utf8");
  await fs.writeFile(sandbox.boardPath, board.replace("## Ready\n", `## Ready\n\n${CARD_LINE}\n`));
}

/**
 * Launch the built CLI with plain pipes — no TTY presented to the child, exactly
 * the headless case the web front end must serve. Captures stdout so a test can
 * wait for the printed URL.
 */
function startCli(sandbox: Sandbox, args: string[]): { child: ChildProcess; stdout: () => string } {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: sandbox.projectRoot,
    env: envFor(sandbox),
  });
  children.push(child);
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", () => undefined);
  return { child, stdout: () => stdout };
}

/** Wait for the "JFDI web front end: <url>" line and return the parsed URL. */
async function waitForUrl(stdout: () => string): Promise<string> {
  let url = "";
  await waitFor(
    () => {
      const match = /JFDI web front end: (http:\/\/\S+)/.exec(stdout());
      if (match?.[1]) url = match[1];
      return url !== "";
    },
    {
      timeoutMs: WAIT_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
      describe: () => `the web front end URL on stdout, got: ${JSON.stringify(stdout())}`,
    },
  );
  return url;
}

interface WebPayload {
  boardName: string;
  targetBranch: string;
  view: {
    state: { tickets: Record<string, { status: string; stage: string | null; round: number }> };
  };
}

/**
 * Follow the Server-Sent Events stream, pushing each decoded `data:` payload into
 * a growing array a test can poll — the browser's live feed, observed from Node.
 */
function followEventStream(url: string): {
  payloads: WebPayload[];
  stop: () => Promise<void>;
} {
  const payloads: WebPayload[] = [];
  const controller = new AbortController();
  const pump = (async () => {
    const response = await fetch(new URL("events", url), { signal: controller.signal });
    if (response.body === null) throw new Error("web event stream has no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) payloads.push(JSON.parse(dataLine.slice("data: ".length)) as WebPayload);
        boundary = buffer.indexOf("\n\n");
      }
    }
  })().catch((error: unknown) => {
    // Abort during teardown is expected; anything else is surfaced by a stalled
    // assertion waiting on payloads that never arrive.
    if (!controller.signal.aborted) throw error;
  });
  return {
    payloads,
    stop: async () => {
      controller.abort();
      await pump;
    },
  };
}

/** True once the port accepts a fresh loopback bind — i.e. it has been freed. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("jfdi start --front-end web (built CLI)", () => {
  it(
    "serves a read-only loopback page, streams a live run, and frees the port on SIGINT",
    async () => {
      const sandbox = await makeSandbox();
      await setAutoMerge(sandbox);
      await seedReadyCard(sandbox);

      const { child, stdout } = startCli(sandbox, ["start", "--front-end", "web"]);
      const url = await waitForUrl(stdout);

      // Loopback only: the printed URL binds 127.0.0.1, so the server is
      // reachable only from the local machine by default.
      expect(new URL(url).hostname).toBe("127.0.0.1");
      const port = Number(new URL(url).port);

      // The page is served and read-only: it names JFDI and carries no control.
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const markup = await page.text();
      expect(markup).toContain("JFDI");
      expect(markup).not.toMatch(/<(?:button|form|input)\b/);

      // A write attempt is rejected — the surface offers no actions.
      const writeAttempt = await fetch(url, { method: "POST" });
      expect(writeAttempt.status).toBe(405);

      // Follow the live feed and watch the seeded card go from dispatched to
      // merged while the coordinator works — no refresh, one open connection.
      const stream = followEventStream(url);
      await waitFor(
        () => stream.payloads.some((p) => p.view.state.tickets[TICKET_ID]?.status === "running"),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${TICKET_ID} running`,
        },
      );
      await waitFor(
        () => stream.payloads.some((p) => p.view.state.tickets[TICKET_ID]?.status === "done"),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${TICKET_ID} done (auto-merged)`,
        },
      );

      // The streamed picture matches the TUI's: board name and target branch.
      const latest = stream.payloads[stream.payloads.length - 1];
      expect(latest?.boardName).toBe("board.md");
      expect(latest?.targetBranch).toBe("main");

      await stream.stop();

      // Stopping jfdi start stops the web server: the process exits with the
      // SIGINT convention and the port it held is freed.
      const exit = waitForExit(child);
      child.kill("SIGINT");
      const result = await exit;
      // The graceful handler ran (exit code 130) rather than a default signal
      // kill — that is what closes the server before the process leaves.
      expect(result.code).toBe(EXIT_SIGINT);
      await waitFor(() => portIsFree(port), {
        timeoutMs: WAIT_TIMEOUT_MS,
        intervalMs: POLL_INTERVAL_MS,
        describe: () => `port ${port} to be free after shutdown`,
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "honors the config frontEnd:web setting headless with no CLI option, and stops on SIGTERM",
    async () => {
      const sandbox = await makeSandbox();
      await setConfigFrontEnd(sandbox, "web");

      // No --front-end option: the config setting alone selects the web front
      // end, which — unlike the terminal default — runs without a TTY.
      const { child, stdout } = startCli(sandbox, ["start"]);
      const url = await waitForUrl(stdout);
      expect(new URL(url).hostname).toBe("127.0.0.1");
      const port = Number(new URL(url).port);

      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("JFDI");

      const exit = waitForExit(child);
      child.kill("SIGTERM");
      const result = await exit;
      // Graceful SIGTERM handler ran (exit code 143), closing the web server.
      expect(result.code).toBe(EXIT_SIGTERM);
      await waitFor(() => portIsFree(port), {
        timeoutMs: WAIT_TIMEOUT_MS,
        intervalMs: POLL_INTERVAL_MS,
        describe: () => `port ${port} to be free after shutdown`,
      });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
