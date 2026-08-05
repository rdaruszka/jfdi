/**
 * Acceptance for `jfdi run` keeping a matching board card in step.
 *
 * `jfdi run` used to be strictly boardless; now, when the ticket it is running
 * has a card on the board, the run walks that card through the same columns the
 * coordinator would. These tests drive the built CLI (`dist/index.js`) in a
 * scratch repo under the OS temp dir with stub `claude` and `codex` binaries on
 * PATH, so they
 * cover the whole wiring — config-driven board path, card lookup, the atomic
 * symlink-preserving writes — from the outside, the way a human running the
 * command sees it.
 *
 * The board is asserted with a parser written here rather than the product's
 * own `parseBoard`, so a change in how JFDI reads a board cannot make these
 * agree with it by construction.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * The agent both stubbed CLIs play; it never talks to the network. It replays
 * two stream-json lines and writes the verdict file its prompt names; the
 * implementation stage also
 * commits, so there is a real commit to review, gate and merge.
 *
 * Four env hooks let a test act *during* the implementation stage, which is
 * the only moment the card is expected to sit in the in-progress column:
 * `STUB_SNAPSHOT` copies the board aside, `STUB_MOVE_CARD_TO` and
 * `STUB_DELETE_CARD` play a human dragging or deleting the card, and
 * `STUB_ESCALATE` blocks the run.
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

/** Move the card line to just under another column heading, as a human would. */
function dragCard(boardPath, cardLine, toColumn) {
  const lines = fs.readFileSync(boardPath, "utf8").split("\\n").filter((l) => l !== cardLine);
  const at = lines.findIndex((l) => l.trim() === "## " + toColumn);
  if (at === -1) throw new Error("no column " + toColumn);
  lines.splice(at + 1, 0, cardLine);
  fs.writeFileSync(boardPath, lines.join("\\n"));
}

if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    if (process.env.STUB_SNAPSHOT) fs.copyFileSync(process.env.STUB_BOARD, process.env.STUB_SNAPSHOT);
    if (process.env.STUB_MOVE_CARD_TO) dragCard(process.env.STUB_BOARD, process.env.STUB_CARD_LINE, process.env.STUB_MOVE_CARD_TO);
    if (process.env.STUB_DELETE_CARD) {
      const kept = fs.readFileSync(process.env.STUB_BOARD, "utf8").split("\\n").filter((l) => l !== process.env.STUB_CARD_LINE);
      fs.writeFileSync(process.env.STUB_BOARD, kept.join("\\n"));
    }
    if (process.env.STUB_ESCALATE) {
      verdict = { status: "escalate", question: "which store?", recommendation: "sqlite" };
    } else {
      fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
      execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
      execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
      verdict = { status: "done", summary: "implemented" };
    }
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

const TICKET_ID = "alpha-feature";
const CARD_LINE = `- [ ] Add feature alpha [[${TICKET_ID}]]`;

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

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-card-e2e-"));
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
  const sandbox: Sandbox = {
    root,
    project,
    home,
    jfdiHome,
    stateDir: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
    binDir,
    boardPath: path.join(project, ".jfdi", "board.md"),
  };
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  await fs.writeFile(
    path.join(project, ".jfdi", "tickets", `${TICKET_ID}.md`),
    `# Alpha feature\n\nAdd the alpha feature.\n`,
  );
  return sandbox;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: { stubEnv?: Record<string, string> } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_BOARD: sandbox.boardPath,
    STUB_CARD_LINE: CARD_LINE,
    ...options.stubEnv,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Run the ticket the board card points at. */
function runTicket(
  sandbox: Sandbox,
  options: { stubEnv?: Record<string, string> } = {},
): Promise<CliResult> {
  return runCli(sandbox, ["run", `[[${TICKET_ID}]]`], options);
}

/**
 * Column name → card lines, parsed independently of the product's own parser.
 * Deliberately dumb: `## ` opens a column, `- [ ]`/`- [x]` is a card.
 */
function columnsOf(board: string): Map<string, string[]> {
  const columns = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of board.split("\n")) {
    if (line.startsWith("## ")) {
      current = [];
      columns.set(line.slice(3).trim(), current);
    } else if (/^- \[[ x]\] /.test(line) && current) {
      current.push(line.trim());
    }
  }
  return columns;
}

async function boardColumns(boardPath: string): Promise<Map<string, string[]>> {
  return columnsOf(await fs.readFile(boardPath, "utf8"));
}

/**
 * Every column that holds at least one card, as `Column: card` lines — the
 * whole placement, so an assertion also fails on a card left or duplicated
 * somewhere it should not be.
 */
function occupied(columns: Map<string, string[]>): string[] {
  return [...columns].flatMap(([column, cards]) => cards.map((card) => `${column}: ${card}`));
}

async function seedCard(sandbox: Sandbox, column: string): Promise<void> {
  const board = await fs.readFile(sandbox.boardPath, "utf8");
  await fs.writeFile(
    sandbox.boardPath,
    board.replace(`## ${column}\n`, `## ${column}\n\n${CARD_LINE}\n`),
  );
}

async function cardMoves(sandbox: Sandbox): Promise<Array<{ from: string; to: string }>> {
  const stream = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return stream
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; data: { from: string; to: string } })
    .filter((event) => event.type === "card_moved")
    .map((event) => ({ from: event.data.from, to: event.data.to }));
}

async function setMode(sandbox: Sandbox, mode: "auto" | "on-approval"): Promise<void> {
  const configPath = path.join(sandbox.project, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    integration: { mode: string };
  };
  config.integration.mode = mode;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("jfdi run moves the matching card", () => {
  it(
    "on-approval: parks the card in Ready to Merge, having held it In Progress",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await seedCard(sandbox, "Ready");
      const midRun = path.join(sandbox.root, "mid-run.md");

      const run = await runTicket(sandbox, { stubEnv: { STUB_SNAPSHOT: midRun } });
      expect(run.code).toBe(0);

      // While the pipeline was running the card was in the in-progress column…
      expect(occupied(columnsOf(await fs.readFile(midRun, "utf8")))).toEqual([
        `In Progress: ${CARD_LINE}`,
      ]);
      // …and the passing outcome parks it in Ready to Merge, nowhere else.
      expect(occupied(await boardColumns(sandbox.boardPath))).toEqual([
        `Ready to Merge: ${CARD_LINE}`,
      ]);
      expect(await cardMoves(sandbox)).toEqual([
        { from: "Ready", to: "In Progress" },
        { from: "In Progress", to: "Ready to Merge" },
      ]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "auto: checks the card off in Done once the branch is merged",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "auto");
      await seedCard(sandbox, "Ready");

      expect((await runTicket(sandbox)).code).toBe(0);

      expect(occupied(await boardColumns(sandbox.boardPath))).toEqual([
        `Done: ${CARD_LINE.replace("- [ ]", "- [x]")}`,
      ]);
      // The pipeline's own commit, subject-prefixed with the ticket id.
      expect(await git(sandbox.project, "log", "--oneline", "main")).toContain("alpha-feature:");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "parks the card in Blocked when the run escalates",
    async () => {
      const sandbox = await makeSandbox();
      await seedCard(sandbox, "Ready");

      const run = await runTicket(sandbox, { stubEnv: { STUB_ESCALATE: "1" } });
      expect(run.code).toBe(2);

      expect(occupied(await boardColumns(sandbox.boardPath))).toEqual([`Blocked: ${CARD_LINE}`]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "parks the card in Blocked when the run throws",
    async () => {
      const sandbox = await makeSandbox();
      await seedCard(sandbox, "Ready");
      // An unmergeable target branch makes worktree creation throw mid-run; the
      // card must not be stranded In Progress by a crash.
      const configPath = path.join(sandbox.project, ".jfdi", "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        integration: { target_branch: string };
      };
      config.integration.target_branch = "no-such-branch";
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const run = await runTicket(sandbox);
      expect(run.code).toBe(1);

      expect(occupied(await boardColumns(sandbox.boardPath))).toEqual([`Blocked: ${CARD_LINE}`]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "tolerates a human moving the card while the run is in flight",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await seedCard(sandbox, "Ready");

      const run = await runTicket(sandbox, { stubEnv: { STUB_MOVE_CARD_TO: "Blocked" } });
      expect(run.code).toBe(0);

      // Found where the human left it and parked on the outcome — not duplicated.
      expect(occupied(await boardColumns(sandbox.boardPath))).toEqual([
        `Ready to Merge: ${CARD_LINE}`,
      ]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "does not resurrect a card the human deleted mid-run",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await seedCard(sandbox, "Ready");

      const run = await runTicket(sandbox, { stubEnv: { STUB_DELETE_CARD: "1" } });
      expect(run.code).toBe(0);

      // The board is the human's document: a card they removed stays removed.
      expect(occupied(await boardColumns(sandbox.boardPath))).toEqual([]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "creates the outcome columns a sparse board is missing",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await fs.writeFile(
        sandbox.boardPath,
        `---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n${CARD_LINE}\n`,
      );

      expect((await runTicket(sandbox)).code).toBe(0);

      const columns = await boardColumns(sandbox.boardPath);
      expect([...columns.keys()]).toEqual(
        expect.arrayContaining(["Ready", "In Progress", "Blocked", "Ready to Merge", "Done"]),
      );
      expect(occupied(columns)).toEqual([`Ready to Merge: ${CARD_LINE}`]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "writes through a symlinked board without replacing the link",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await seedCard(sandbox, "Ready");
      // Reproduce the vault setup: the board is a symlink out of the repo.
      const vault = path.join(sandbox.root, "vault");
      await fs.mkdir(vault);
      const realBoard = path.join(vault, "board.md");
      await fs.rename(sandbox.boardPath, realBoard);
      await fs.symlink(realBoard, sandbox.boardPath);

      expect((await runTicket(sandbox)).code).toBe(0);

      expect((await fs.lstat(sandbox.boardPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(sandbox.boardPath)).toBe(realBoard);
      expect(occupied(await boardColumns(realBoard))).toEqual([`Ready to Merge: ${CARD_LINE}`]);
      // The temp file of the atomic write must not be left behind in the vault.
      expect(await fs.readdir(vault)).toEqual(["board.md"]);
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("jfdi run stays boardless when no card matches", () => {
  it(
    "leaves a board holding no matching card byte-identical",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      const board = await fs.readFile(sandbox.boardPath, "utf8");
      const other = board.replace("## Ready\n", "## Ready\n\n- [ ] Something else [[beta]]\n");
      await fs.writeFile(sandbox.boardPath, other);

      expect((await runTicket(sandbox)).code).toBe(0);

      expect(await fs.readFile(sandbox.boardPath, "utf8")).toBe(other);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "never dispatches from — or touches — a card sitting in the Inbox",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await seedCard(sandbox, "Inbox");
      const before = await fs.readFile(sandbox.boardPath, "utf8");

      expect((await runTicket(sandbox)).code).toBe(0);

      expect(await fs.readFile(sandbox.boardPath, "utf8")).toBe(before);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "runs with no board file at all and creates none",
    async () => {
      const sandbox = await makeSandbox();
      await setMode(sandbox, "on-approval");
      await fs.rm(sandbox.boardPath);

      const run = await runTicket(sandbox);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`jfdi merge ${TICKET_ID}`);

      await expect(fs.access(sandbox.boardPath)).rejects.toThrow();
    },
    PIPELINE_TIMEOUT_MS,
  );
});
