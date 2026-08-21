/**
 * Acceptance for the web ticket detail view, exercised against the built CLI
 * (`dist/index.js start --front-end web`) in a scratch repo under the OS temp
 * dir, with stub `claude`/`codex` binaries on PATH. This is the outside-in view a
 * human clicking a kanban card gets: it drives a real coordinator through a real
 * pipeline so the `/ticket-detail` endpoint is built from the pipeline's own
 * on-disk run logs (`runs/<ticket-id>/run-N/round-K/*.log.jsonl`), not a
 * hand-constructed fixture — proving the detail view's directory/round/continuation
 * assumptions match the layout the pipeline actually writes.
 *
 * Covered acceptance criteria the server-side endpoint can reach end-to-end:
 *   - A Done ticket's detail carries its description AND acceptance criteria, its
 *     folded comment trail (kept current), and the run's agent sessions as tabs in
 *     run order (Implementation, Code Review, QA), each holding the full session
 *     feed. The scribe (commit-message) session gets no tab.
 *   - A card still in Ready (never dispatched, held by blocked-by) shows no session
 *     history — the feed side is blank.
 *   - A Blocked ticket shows its recorded session history with the same tabs, and a
 *     continued stage extends its existing tab (code review folds rounds 1–3 into
 *     one tab) while a stage that restarts fresh each round gets a round-labeled tab
 *     (Implementation round 2, Implementation round 3).
 *   - The endpoint is read-only and rejects an unknown ticket id.
 *   - The page ships the split-screen scaffold and the scroll-follow behavior:
 *     follow the bottom while pinned there, hold position once scrolled up.
 *
 * The client-only scroll/tab interaction runs in the browser; only its shipped
 * source is asserted here (the same template-script convention the other web
 * tests use). `JFDI_HOME`/`HOME` always point inside the scratch tree and the stub
 * agents never touch the network — nothing here can reach the real `~/.jfdi` or a
 * real provider.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
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
const POLL_INTERVAL_MS = 100;

/**
 * The agent both stubbed CLIs play. It replays a couple of stream-json lines that
 * name the stage (so a test can prove the feed carries this session's own output),
 * writes the verdict file its prompt names, and — for implementation — commits so
 * there is a real change to review, gate, and merge. `failReview` makes code review
 * fail every round, driving the ticket to Blocked after the round cap. Never talks
 * to the network.
 */
function stubAgent(failReview: boolean): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
const verdictMatch = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const stage = verdictMatch ? verdictMatch[1].split("/").pop().replace(".verdict.json", "") : "scribe";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "FEED-" + stage + " first line\\nsecond line" }] } }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final message for " + stage } }) + "\\n"));
if (verdictMatch) {
  const verdictPath = verdictMatch[1];
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature " + Date.now() + "\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    try { execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() }); } catch (error) {}
    verdict = { status: "done", summary: "implemented the feature" };
  } else if (stage === "code-review") {
    verdict = ${failReview ? '{ verdict: "fail", feedback: "needs work" }' : '{ verdict: "pass" }'};
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
}

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
  boardPath: string;
  configPath: string;
  ticketsDirectory: string;
  stateFile: string;
}

const sandboxes: string[] = [];
const children: ChildProcess[] = [];

/** Dash-flatten the project root the way JFDI keys ~/.jfdi/projects/. */
function projectKey(absoluteProjectRoot: string): string {
  return absoluteProjectRoot.replace(/[/\\]/g, "-");
}

async function makeSandbox(failReview: boolean): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-detail-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const projectDirectory = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  const agent = stubAgent(failReview);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), agent, { mode: 0o755 });
  }

  await git(projectDirectory, "init", "-b", "main");
  await git(projectDirectory, "config", "user.email", "test@jfdi.local");
  await git(projectDirectory, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectDirectory, "README.md"), "product\n");
  await git(projectDirectory, "add", "-A");
  await git(projectDirectory, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  const sandbox: Sandbox = {
    root,
    projectRoot: projectDirectory,
    home,
    jfdiHome,
    executableDirectory,
    boardPath: path.join(projectDirectory, ".jfdi", "board.md"),
    configPath: path.join(projectDirectory, ".jfdi", "config.json"),
    ticketsDirectory: path.join(projectDirectory, ".jfdi", "tickets"),
    stateFile: path.join(jfdiHome, "projects", projectKey(projectDirectory), "state.json"),
  };
  const init = await execFileAsync(process.execPath, [cliPath, "init", "--bare"], {
    cwd: projectDirectory,
    env: envFor(sandbox),
  });
  expect(init.stderr).not.toContain("Error");
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

async function setAutoMerge(sandbox: Sandbox): Promise<void> {
  const config = JSON.parse(await fs.readFile(sandbox.configPath, "utf8")) as {
    integration: { mode: string };
  };
  config.integration.mode = "auto";
  await fs.writeFile(sandbox.configPath, JSON.stringify(config, null, 2));
}

async function writeTicket(sandbox: Sandbox, id: string, body: string): Promise<void> {
  await fs.writeFile(path.join(sandbox.ticketsDirectory, `${id}.md`), body);
}

async function seedReadyCard(sandbox: Sandbox, title: string, id: string): Promise<void> {
  const board = await fs.readFile(sandbox.boardPath, "utf8");
  await fs.writeFile(
    sandbox.boardPath,
    board.replace("## Ready\n", `## Ready\n\n- [ ] ${title} [[${id}]]\n`),
  );
}

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

interface TicketSnapshot {
  id: string;
  status: string;
}

async function readTickets(sandbox: Sandbox): Promise<TicketSnapshot[]> {
  const raw = await fs.readFile(sandbox.stateFile, "utf8").catch(() => null);
  if (raw === null) return [];
  const state = JSON.parse(raw) as { tickets?: Record<string, TicketSnapshot> };
  return Object.values(state.tickets ?? {});
}

async function waitForStatus(sandbox: Sandbox, id: string, statuses: string[]): Promise<void> {
  await waitFor(
    async () =>
      (await readTickets(sandbox)).some((t) => t.id === id && statuses.includes(t.status)),
    {
      timeoutMs: WAIT_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
      describe: () => `ticket ${id} to reach one of [${statuses.join(", ")}]`,
    },
  );
}

interface TicketDetail {
  title: string;
  description: string;
  comments: Array<{ label: string; timestamp: string; body: string }>;
  sessions: Array<{ key: string; label: string; content: string }>;
}

async function fetchDetail(url: string, ticketId: string): Promise<TicketDetail> {
  const response = await fetch(
    new URL(`ticket-detail?ticketId=${encodeURIComponent(ticketId)}`, url),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as TicketDetail;
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGINT");
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

describe("web ticket detail view (built CLI)", () => {
  it(
    "opens a merged ticket's detail with folded comments and stage tabs from real run logs, and shows no feed for an un-run Ready card",
    async () => {
      const sandbox = await makeSandbox(false);
      await setAutoMerge(sandbox);
      // A dispatched card that runs to Done, and a card held in Ready by a
      // blocker that never reaches Done — so it is on the board but never runs.
      await writeTicket(
        sandbox,
        "detail-ticket",
        "# Ship the detail view\n\nBuild the split screen.\n\n## Acceptance criteria\n\n- Clicking a card opens the detail.\n",
      );
      await writeTicket(
        sandbox,
        "waiting-ticket",
        '---\nblocked-by:\n  - "[[missing-blocker]]"\n---\n\n# Waiting work\n\nHeld until its blocker is done.\n',
      );
      // The blocker note exists but never reaches the Done column, so blocked-by
      // gating keeps waiting-ticket in Ready. It is not itself carded on the board.
      await writeTicket(sandbox, "missing-blocker", "# Blocker\n\nNever moved to Done.\n");
      await seedReadyCard(sandbox, "Ship the detail view", "detail-ticket");
      await seedReadyCard(sandbox, "Waiting work", "waiting-ticket");

      const { child, stdout } = startCli(sandbox, ["start", "--front-end", "web"]);
      const url = await waitForUrl(stdout);

      // The page ships the split-screen scaffold, the return-to-board control, and
      // the scroll-follow behavior (client-only interaction, asserted at its source).
      const markup = await (await fetch(url)).text();
      expect(markup).toContain('id="ticket-detail"');
      expect(markup).toContain('id="board-return"');
      expect(markup).toContain('id="session-tabs"');
      expect(markup).toContain('id="feed-output"');
      expect(markup).toContain("isFeedAtBottom(feed)");
      expect(markup).toContain(
        "feed.scrollTop = shouldFollow ? feed.scrollHeight : previousScrollTop",
      );

      await waitForStatus(sandbox, "detail-ticket", ["done"]);

      const detail = await fetchDetail(url, "detail-ticket");
      // Ticket side: title, description AND its acceptance criteria section.
      expect(detail.title).toBe("Ship the detail view");
      expect(detail.description).toContain("Build the split screen.");
      expect(detail.description).toContain("## Acceptance criteria");
      expect(detail.description).toContain("- Clicking a card opens the detail.");
      // The comment trail is the folded phase comments the run appended.
      expect(detail.comments.map((comment) => comment.label)).toEqual([
        "JFDI started",
        "Implementation round 1 complete",
        "Code Review round 1 complete",
        "QA round 1 complete",
        "Integration complete",
      ]);

      // Feed side: one tab per stage session in run order; round 1 carries no round
      // suffix. The scribe (commit-message) session gets no tab.
      expect(detail.sessions.map((session) => session.label)).toEqual([
        "Implementation",
        "Code Review",
        "QA",
      ]);
      // Each tab holds its own session's full feed, mapped from the provider log.
      const byLabel = Object.fromEntries(detail.sessions.map((s) => [s.label, s.content]));
      expect(byLabel.Implementation).toContain("FEED-implementation first line\nsecond line");
      expect(byLabel["Code Review"]).toContain("FEED-code-review first line");
      expect(byLabel.QA).toContain("FEED-qa first line");
      // No scribe output leaked into any tab.
      expect(JSON.stringify(detail.sessions)).not.toContain("FEED-scribe");
      expect(JSON.stringify(detail.sessions)).not.toContain("final message for scribe");

      // The Ready (blocked-by) card is on the board but never ran: blank feed.
      await waitForStatus(sandbox, "waiting-ticket", ["waiting", "ready"]);
      const waiting = await fetchDetail(url, "waiting-ticket");
      expect(waiting.title).toBe("Waiting work");
      expect(waiting.sessions).toEqual([]);

      // The endpoint is read-only and refuses an unknown ticket id.
      const unknown = await fetch(new URL("ticket-detail?ticketId=nope", url));
      expect(unknown.status).toBe(404);
      const post = await fetch(new URL("ticket-detail?ticketId=detail-ticket", url), {
        method: "POST",
      });
      expect(post.status).toBe(405);

      await stopChild(child);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "shows a Blocked ticket's recorded history: a continued stage folds into one tab, a fresh-each-round stage gets round-labeled tabs",
    async () => {
      // Code review fails every round, so the ticket exhausts the round cap and
      // lands in Blocked with three rounds of recorded sessions.
      const sandbox = await makeSandbox(true);
      await writeTicket(
        sandbox,
        "blocked-ticket",
        "# Never passes review\n\nCode review keeps failing.\n\n## Acceptance criteria\n\n- Impossible here.\n",
      );
      await seedReadyCard(sandbox, "Never passes review", "blocked-ticket");

      const { child, stdout } = startCli(sandbox, ["start", "--front-end", "web"]);
      const url = await waitForUrl(stdout);

      await waitForStatus(sandbox, "blocked-ticket", ["blocked", "failed"]);

      const detail = await fetchDetail(url, "blocked-ticket");
      // Implementation restarts fresh each round → a round-labeled tab per round.
      // Code review is continued in rounds 2 and 3 → all three rounds fold into its
      // single round-1 tab (matching how the comment trail folds a continued stage).
      expect(detail.sessions.map((session) => session.label)).toEqual([
        "Implementation",
        "Code Review",
        "Implementation round 2",
        "Implementation round 3",
      ]);
      const codeReview = detail.sessions.find((session) => session.label === "Code Review");
      if (codeReview === undefined) throw new Error("expected a Code Review tab");
      // The one Code Review tab carries every round's output, not just the latest.
      expect(codeReview.content.match(/FEED-code-review first line/g)?.length).toBe(3);
      // Fresh implementation rounds stay in their own tabs, each with its own feed.
      const roundTwo = detail.sessions.find(
        (session) => session.label === "Implementation round 2",
      );
      expect(roundTwo?.content).toContain("FEED-implementation first line");

      await stopChild(child);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
