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
 *   - The status surface remains read-only while the page exposes its dedicated
 *     settings control; a POST to any other route is rejected.
 *   - A card seeded in the begin column is dispatched, run, and merged while the
 *     coordinator works, and every transition streams live to a connected client
 *     over Server-Sent Events with no manual refresh (board name, target branch,
 *     and kanban column).
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

/**
 * Hand-add keys the typed panel does not model at several depths — a top-level
 * key, one nested inside `integration`, an extra field on a gate entry, and one
 * on a stage entry — mirroring a config co-edited by hand or another tool. These
 * must survive a load-edit-save round trip through the panel unchanged.
 */
async function addUnmodeledConfigKeys(sandbox: Sandbox): Promise<void> {
  const config = JSON.parse(await fs.readFile(sandbox.configPath, "utf8")) as {
    integration: Record<string, unknown>;
    gate: unknown[];
    stages: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  config.handAddedTopLevel = { note: "keep me" };
  config.integration.futureFlag = "preserve";
  config.gate = [{ name: "test", command: "pnpm test", timeoutSeconds: 42 }];
  config.stages.implementation = { ...config.stages.implementation, experimentalTuning: 7 };
  await fs.writeFile(sandbox.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function seedReadyCard(sandbox: Sandbox): Promise<void> {
  const board = await fs.readFile(sandbox.boardPath, "utf8");
  await fs.writeFile(sandbox.boardPath, board.replace("## Ready\n", `## Ready\n\n${CARD_LINE}\n`));
}

/** Rewrite the whole board file (a human co-editing it in Obsidian). */
async function writeBoard(sandbox: Sandbox, content: string): Promise<void> {
  await fs.writeFile(sandbox.boardPath, content);
}

/** Drop every card line naming this ticket — a human removing the card. */
async function removeCard(sandbox: Sandbox, ticketId: string): Promise<void> {
  const board = await fs.readFile(sandbox.boardPath, "utf8");
  const kept = board
    .split("\n")
    .filter((line) => !line.includes(`[[${ticketId}]]`))
    .join("\n");
  await fs.writeFile(sandbox.boardPath, kept);
}

async function writeNote(sandbox: Sandbox, id: string, frontmatter: string): Promise<void> {
  await fs.writeFile(
    path.join(sandbox.projectRoot, ".jfdi", "tickets", `${id}.md`),
    `---\n${frontmatter}\n---\n\n# ${id}\n\nWork for ${id}.\n`,
  );
}

function anyColumnHasTicket(payload: WebPayload, ticketId: string): boolean {
  return payload.columns.some((column) => column.cards.some((card) => card.id === ticketId));
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
  columns: Array<{ name: string; cards: Array<{ id: string; title: string }> }>;
}

function columnHasTicket(payload: WebPayload, columnName: string, ticketId: string): boolean {
  return (
    payload.columns
      .find((column) => column.name === columnName)
      ?.cards.some((card) => card.id === ticketId) ?? false
  );
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
    "serves a loopback page, streams a live run, and frees the port on SIGINT",
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

      // The page names JFDI and exposes only the dedicated settings write surface.
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const markup = await page.text();
      expect(markup).toContain("JFDI");
      expect(markup).toContain('id="settings-open"');
      expect(markup).toContain('id="settings-save"');

      // Every route outside the settings panel remains read-only.
      const writeAttempt = await fetch(url, { method: "POST" });
      expect(writeAttempt.status).toBe(405);

      // Follow the live feed and watch the seeded card go from dispatched to
      // merged while the coordinator works — no refresh, one open connection.
      const stream = followEventStream(url);

      const loadedResponse = await fetch(new URL("settings", url));
      const loaded = (await loadedResponse.json()) as {
        config: Record<string, unknown>;
        revision: string;
      };
      const beforeInvalidSave = await fs.readFile(sandbox.configPath, "utf8");
      const invalidResponse = await fetch(new URL("settings", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...loaded.config, maxConcurrent: 0 },
          revision: loaded.revision,
        }),
      });
      expect(invalidResponse.status).toBe(400);
      expect((await invalidResponse.json()) as { error: string }).toMatchObject({
        error: "maxConcurrent must be a positive integer",
      });
      expect(await fs.readFile(sandbox.configPath, "utf8")).toBe(beforeInvalidSave);

      const externalConfig = { ...loaded.config, maxConcurrent: 5 };
      await fs.writeFile(sandbox.configPath, `${JSON.stringify(externalConfig, null, 2)}\n`);
      const staleResponse = await fetch(new URL("settings", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...loaded.config, maxConcurrent: 3 },
          revision: loaded.revision,
        }),
      });
      expect(staleResponse.status).toBe(409);
      expect((await staleResponse.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("changed on disk"),
      });
      expect(JSON.parse(await fs.readFile(sandbox.configPath, "utf8"))).toMatchObject({
        maxConcurrent: 5,
      });

      const reloaded = (await (await fetch(new URL("settings", url))).json()) as typeof loaded;
      const savedResponse = await fetch(new URL("settings", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...reloaded.config, maxConcurrent: 3 },
          revision: reloaded.revision,
        }),
      });
      expect(savedResponse.status).toBe(200);
      expect(JSON.parse(await fs.readFile(sandbox.configPath, "utf8"))).toMatchObject({
        maxConcurrent: 3,
      });

      await waitFor(
        () =>
          stream.payloads.some((payload) =>
            ["Implementation", "Code Review", "QA", "Integration"].some((column) =>
              columnHasTicket(payload, column, TICKET_ID),
            ),
          ),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${TICKET_ID} in a running column`,
        },
      );
      await waitFor(
        () => stream.payloads.some((payload) => columnHasTicket(payload, "Done", TICKET_ID)),
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

  it(
    "surfaces an undispatched begin-column card in Ready, then holds it in Ready to Merge until a human approves (on-approval mode)",
    async () => {
      // Default integration mode is on-approval — no setAutoMerge here.
      const sandbox = await makeSandbox();

      const { child, stdout } = startCli(sandbox, ["start", "--front-end", "web"]);
      const url = await waitForUrl(stdout);

      // Connect the live feed BEFORE any card exists, so the Ready surfacing must
      // arrive by stream alone — proving the begin-column card is visible in
      // derived state without the front end ever reading board.md (invariant 1).
      const stream = followEventStream(url);

      // On-approval mode presents the Ready to Merge column.
      await waitFor(
        () =>
          stream.payloads.some((payload) =>
            payload.columns.some((column) => column.name === "Ready to Merge"),
          ),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => "a payload exposing the Ready to Merge column in on-approval mode",
        },
      );

      // Add the card now, with a client already listening.
      await seedReadyCard(sandbox);

      // It shows in Ready before it ever runs — the coordinator surfaced the
      // begin-column card through the event stream.
      await waitFor(
        () => stream.payloads.some((payload) => columnHasTicket(payload, "Ready", TICKET_ID)),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${TICKET_ID} in Ready before dispatch`,
        },
      );

      // It runs through the pipeline and, in on-approval mode, comes to rest in
      // Ready to Merge rather than auto-merging.
      await waitFor(
        () =>
          stream.payloads.some((payload) => columnHasTicket(payload, "Ready to Merge", TICKET_ID)),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${TICKET_ID} waiting in Ready to Merge`,
        },
      );

      // At rest in Ready to Merge, it has NOT reached Done — it is genuinely
      // waiting for a human, unlike the auto-mode run above.
      const waitingPayload = stream.payloads[stream.payloads.length - 1];
      expect(waitingPayload && columnHasTicket(waitingPayload, "Done", TICKET_ID)).toBe(false);

      // A human approves by removing the card (merged by hand); the coordinator's
      // approval sweep marks the ticket done and the view moves it to Done.
      await removeCard(sandbox, TICKET_ID);
      await waitFor(
        () => stream.payloads.some((payload) => columnHasTicket(payload, "Done", TICKET_ID)),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${TICKET_ID} in Done after approval`,
        },
      );

      await stream.stop();
      const exit = waitForExit(child);
      child.kill("SIGINT");
      await exit;
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps a blocked-by begin-column card in Ready and drops it when the card leaves the board",
    async () => {
      const sandbox = await makeSandbox();
      const BlockedId = "needs-blocker";
      const BlockerId = "the-blocker";
      await writeNote(sandbox, BlockedId, `blocked-by:\n  - "[[${BlockerId}]]"`);
      await writeNote(sandbox, BlockerId, "id: the-blocker");

      const { child, stdout } = startCli(sandbox, ["start", "--front-end", "web"]);
      const url = await waitForUrl(stdout);
      const stream = followEventStream(url);

      // A begin-column card whose blocker is not Done never dispatches, but it is
      // still awaiting dispatch — so it belongs in Ready, not Blocked. The blocker
      // sits in a non-begin column (Backlog), so it is not itself surfaced.
      await writeBoard(
        sandbox,
        `---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n- [ ] blocked work [[${BlockedId}]]\n\n## In Progress\n\n## Done\n\n## Blocked\n\n## Ready to Merge\n\n## Backlog\n\n- [ ] the blocker [[${BlockerId}]]\n\n## Inbox\n`,
      );

      await waitFor(
        () => stream.payloads.some((payload) => columnHasTicket(payload, "Ready", BlockedId)),
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () => `a streamed payload showing ${BlockedId} waiting in Ready`,
        },
      );

      // It never dispatched: a blocked card stays out of every running column.
      const seenPayload = stream.payloads[stream.payloads.length - 1];
      for (const runningColumn of ["Implementation", "Code Review", "QA", "Integration"]) {
        expect(seenPayload && columnHasTicket(seenPayload, runningColumn, BlockedId)).toBe(false);
      }

      // Remove the still-undispatched card from the board; it must vanish from the
      // view (ready_removed drops it from derived state). Assert on the LATEST
      // payload — a plain `.some(absent)` is trivially true of the initial empty
      // payload and would prove nothing.
      await removeCard(sandbox, BlockedId);
      await waitFor(
        () => {
          const latest = stream.payloads[stream.payloads.length - 1];
          return latest !== undefined && !anyColumnHasTicket(latest, BlockedId);
        },
        {
          timeoutMs: WAIT_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
          describe: () =>
            `the latest streamed payload no longer showing ${BlockedId} in any column`,
        },
      );

      await stream.stop();
      const exit = waitForExit(child);
      child.kill("SIGINT");
      await exit;
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "edits config through typed panel fields: refusals name the offending option, and hand-added keys survive a save",
    async () => {
      // A config co-edited by hand carries keys the typed panel does not model.
      const sandbox = await makeSandbox();
      await addUnmodeledConfigKeys(sandbox);
      const original = await fs.readFile(sandbox.configPath, "utf8");

      const { child, stdout } = startCli(sandbox, ["start", "--front-end", "web"]);
      const url = await waitForUrl(stdout);

      // GET exposes an editableConfig the typed controls bind to. Every unmodeled
      // key is present at its original depth, while the typed `config` view drops
      // the keys the panel does not know about (the gate entry's extra field).
      const loaded = (await (await fetch(new URL("settings", url))).json()) as {
        config: { gate: Array<Record<string, unknown>> };
        editableConfig: {
          handAddedTopLevel: unknown;
          integration: Record<string, unknown>;
          gate: Array<Record<string, unknown>>;
          stages: Record<string, Record<string, unknown>>;
          [key: string]: unknown;
        };
        revision: string;
      };
      expect(loaded.editableConfig.handAddedTopLevel).toEqual({ note: "keep me" });
      expect(loaded.editableConfig.integration.futureFlag).toBe("preserve");
      expect(loaded.editableConfig.gate[0]).toMatchObject({ timeoutSeconds: 42 });
      expect(loaded.editableConfig.stages.implementation).toMatchObject({ experimentalTuning: 7 });
      // The typed shape the pipeline consumes never carries the unmodeled key.
      expect(loaded.config.gate[0]).not.toHaveProperty("timeoutSeconds");

      // A validation refusal for each kind of typed control names the exact field
      // the panel would highlight — numeric, constrained enum (top-level and a
      // per-stage harness), a nested board column, and a variable-length gate
      // entry — not merely a message line.
      const refusals: Array<[Record<string, unknown>, string]> = [
        [{ ...loaded.editableConfig, maxConcurrent: 0 }, "maxConcurrent"],
        [{ ...loaded.editableConfig, pipeline: { maxRounds: 0 } }, "pipeline.maxRounds"],
        [
          {
            ...loaded.editableConfig,
            integration: { ...loaded.editableConfig.integration, mode: "sometimes" },
          },
          "integration.mode",
        ],
        [{ ...loaded.editableConfig, permissions: { mode: "yolo" } }, "permissions.mode"],
        [{ ...loaded.editableConfig, frontEnd: "gui" }, "frontEnd"],
        [
          {
            ...loaded.editableConfig,
            stages: {
              ...loaded.editableConfig.stages,
              qa: { ...loaded.editableConfig.stages.qa, harness: "gemini" },
            },
          },
          "stages.qa.harness",
        ],
        [
          {
            ...loaded.editableConfig,
            board: {
              ...(loaded.editableConfig.board as Record<string, unknown>),
              columns: {
                ...(loaded.editableConfig.board as { columns: Record<string, unknown> }).columns,
                begin: "",
              },
            },
          },
          "board.columns.begin",
        ],
        [{ ...loaded.editableConfig, gate: [{ name: "test" }] }, "gate[0].command"],
      ];
      for (const [config, field] of refusals) {
        const response = await fetch(new URL("settings", url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config, revision: loaded.revision }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()) as { field: string }).toMatchObject({ field });
      }
      // Every refusal staged nothing: the file on disk is byte-for-byte untouched.
      expect(await fs.readFile(sandbox.configPath, "utf8")).toBe(original);

      // A valid edit through one typed field saves and applies, and every
      // hand-added key round-trips to disk unchanged.
      const saved = await fetch(new URL("settings", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...loaded.editableConfig, maxConcurrent: 4 },
          revision: loaded.revision,
        }),
      });
      expect(saved.status).toBe(200);
      const onDisk = JSON.parse(await fs.readFile(sandbox.configPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(onDisk).toMatchObject({
        maxConcurrent: 4,
        handAddedTopLevel: { note: "keep me" },
        integration: { futureFlag: "preserve" },
        gate: [{ timeoutSeconds: 42 }],
        stages: { implementation: { experimentalTuning: 7 } },
      });

      // The now-consumed revision is stale; a second save with it is refused.
      const stale = await fetch(new URL("settings", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...loaded.editableConfig, maxConcurrent: 9 },
          revision: loaded.revision,
        }),
      });
      expect(stale.status).toBe(409);

      const exit = waitForExit(child);
      child.kill("SIGINT");
      const result = await exit;
      expect(result.code).toBe(EXIT_SIGINT);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
