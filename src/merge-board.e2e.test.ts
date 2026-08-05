/**
 * Acceptance for `jfdi merge` doing its own board bookkeeping.
 *
 * `jfdi merge` used to integrate without ever touching the board: the code
 * landed, the branch went away, and the card sat in Ready to Merge forever
 * because nothing else notices a merge the coordinator did not perform. These
 * tests pin the bookkeeping from the outside — they drive `dist/index.js` in a
 * scratch repo under the OS temp dir and assert on what a human sees: the
 * board file, the `card_moved` event, and the exit code.
 *
 * The board here is a **symlink into a vault directory**, the way a real
 * project links it into Obsidian. That is deliberate: a board write that
 * renames onto the link instead of its target would replace the link with a
 * private copy and silently split the tool's board from the human's, and a
 * test on a plain file could never catch it.
 *
 * No stage agent runs in any of these — the branches are pre-built and the
 * gate is either empty or a shell builtin — but stub `claude` and `codex`
 * binaries sit on PATH
 * so a regression that reaches for a session fails loudly instead of calling
 * the real CLI. `JFDI_HOME`/`HOME` always point inside the scratch tree.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { JfdiEvent } from "./events.js";
import { createWorktree, git } from "./git.js";
import { worktreesDir } from "./pipeline.js";
import { ticketIdFromCard } from "./util/ids.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

/** Any stage session is a regression here; make it an obvious, loud failure. */
const STUB_AGENT = `#!/bin/sh
echo "no stage agent should run during jfdi merge" >&2
exit 97
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
  /** The real board file; `.jfdi/board.md` is only a symlink pointing here. */
  vaultBoardPath: string;
  jfdiDir: string;
}

const sandboxes: string[] = [];

/** Dash-flattened absolute path, derived here rather than from the module under test. */
function expectedProjectKey(projectRoot: string): string {
  return projectRoot.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-merge-board-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const vault = path.join(root, "vault");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  await fs.mkdir(vault);
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
    vaultBoardPath: path.join(vault, "board.md"),
    jfdiDir: path.join(project, ".jfdi"),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
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

/** Build board markdown from an ordered column -> card-lines mapping. */
function boardMarkdown(columns: Array<[string, string[]]>): string {
  const lines = ["---", "", "kanban-plugin: board", "", "---", ""];
  for (const [name, cards] of columns) {
    lines.push(`## ${name}`, "", ...cards, "");
  }
  return lines.join("\n");
}

/** Scaffold `.jfdi/`, then relink the board to the vault copy and commit. */
async function setUpProject(
  sandbox: Sandbox,
  board: string,
  configOverrides: Record<string, unknown> = {},
): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  await fs.writeFile(sandbox.vaultBoardPath, board);
  const boardLink = path.join(sandbox.jfdiDir, "board.md");
  await fs.rm(boardLink);
  await fs.symlink(sandbox.vaultBoardPath, boardLink);
  if (Object.keys(configOverrides).length > 0) {
    const configPath = path.join(sandbox.jfdiDir, "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(configPath, JSON.stringify({ ...config, ...configOverrides }, null, 2));
  }
  // The target branch must be clean, or the fast-forward refuses to run.
  await git(sandbox.project, "add", "-A");
  await git(sandbox.project, "commit", "-m", "scaffold");
}

/** A ticket branch with one commit, in the worktree `jfdi merge` looks for. */
async function makeTicketBranch(sandbox: Sandbox, ticketId: string): Promise<string> {
  const worktree = await createWorktree(
    sandbox.project,
    worktreesDir(sandbox.jfdiDir),
    ticketId,
    "main",
  );
  await fs.writeFile(path.join(worktree.path, `${ticketId}.txt`), "work\n");
  await git(worktree.path, "add", "-A");
  await git(worktree.path, "commit", "-m", `work for ${ticketId}`);
  return worktree.path;
}

function readBoard(sandbox: Sandbox): Promise<string> {
  return fs.readFile(sandbox.vaultBoardPath, "utf8");
}

/** Card lines under a column heading, in board order. */
function cardsUnder(board: string, columnName: string): string[] {
  const lines = board.split("\n");
  const start = lines.indexOf(`## ${columnName}`);
  if (start === -1) throw new Error(`column "${columnName}" not on the board`);
  const cards: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith("## ")) break;
    if (line.startsWith("- [")) cards.push(line);
  }
  return cards;
}

async function readEvents(sandbox: Sandbox): Promise<JfdiEvent[]> {
  const raw = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JfdiEvent);
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("jfdi merge closes out its own card", () => {
  it("moves the card from Ready to Merge to Done, checked off, through the board symlink", async () => {
    const sandbox = await makeSandbox();
    const card = "- [ ] Ship the widget [[ship-the-widget]]";
    await setUpProject(
      sandbox,
      boardMarkdown([
        ["Ready", []],
        ["In Progress", []],
        ["Ready to Merge", [card]],
        ["Blocked", []],
        ["Done", []],
      ]),
    );
    await makeTicketBranch(sandbox, "ship-the-widget");

    const merge = await runCli(sandbox, ["merge", "ship-the-widget"]);
    expect(merge.code).toBe(0);

    // The code landed…
    expect(await git(sandbox.project, "log", "--oneline", "main")).toContain(
      "work for ship-the-widget",
    );
    // …and so did the bookkeeping.
    const board = await readBoard(sandbox);
    expect(cardsUnder(board, "Ready to Merge")).toEqual([]);
    expect(cardsUnder(board, "Done")).toEqual(["- [x] Ship the widget [[ship-the-widget]]"]);

    // The write followed the link instead of replacing it with a private copy.
    const boardLink = path.join(sandbox.jfdiDir, "board.md");
    expect((await fs.lstat(boardLink)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(boardLink)).toBe(sandbox.vaultBoardPath);

    // The renderers only ever see the event stream, so the move must be in it.
    const moved = (await readEvents(sandbox)).filter((event) => event.type === "card_moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]?.ticketId).toBe("ship-the-widget");
    expect(moved[0]?.data).toMatchObject({ from: "Ready to Merge", to: "Done" });
  });

  it("closes the card for a branch the human already merged by hand", async () => {
    // The reported failure: the branch is already contained in the target, so
    // integration short-circuits to `already-merged` and never merges anything.
    // The card still has to move.
    const sandbox = await makeSandbox();
    const card = "- [ ] Hand merged [[hand-merged]]";
    await setUpProject(
      sandbox,
      boardMarkdown([
        ["Ready", []],
        ["In Progress", []],
        ["Ready to Merge", [card]],
        ["Blocked", []],
        ["Done", []],
      ]),
    );
    const worktreePath = await makeTicketBranch(sandbox, "hand-merged");
    await git(sandbox.project, "merge", "--ff-only", "jfdi/hand-merged");
    // The human cleaned up after themselves, too.
    await git(sandbox.project, "worktree", "remove", "--force", worktreePath);

    const merge = await runCli(sandbox, ["merge", "hand-merged"]);
    expect(merge.code).toBe(0);
    expect(merge.stdout).toContain("already");

    const board = await readBoard(sandbox);
    expect(cardsUnder(board, "Ready to Merge")).toEqual([]);
    expect(cardsUnder(board, "Done")).toEqual(["- [x] Hand merged [[hand-merged]]"]);
  });

  it("finds the card wherever it sits and checks it off without duplicating it", async () => {
    // A human who dragged the card to Done ahead of the merge must not end up
    // with two copies of it.
    const sandbox = await makeSandbox();
    await setUpProject(
      sandbox,
      boardMarkdown([
        ["Ready", []],
        ["In Progress", ["- [ ] Mid drag [[mid-drag]]"]],
        ["Ready to Merge", []],
        ["Blocked", []],
        ["Done", ["- [ ] Pre parked [[pre-parked]]"]],
      ]),
    );
    await makeTicketBranch(sandbox, "mid-drag");
    await makeTicketBranch(sandbox, "pre-parked");

    expect((await runCli(sandbox, ["merge", "mid-drag"])).code).toBe(0);
    expect((await runCli(sandbox, ["merge", "pre-parked"])).code).toBe(0);

    const board = await readBoard(sandbox);
    expect(cardsUnder(board, "In Progress")).toEqual([]);
    // Order within the column is incidental; presence exactly once is not.
    expect([...cardsUnder(board, "Done")].sort()).toEqual([
      "- [x] Mid drag [[mid-drag]]",
      "- [x] Pre parked [[pre-parked]]",
    ]);
  });

  it("moves the card to Blocked and leaves the target untouched when integration blocks", async () => {
    const sandbox = await makeSandbox();
    const card = "- [ ] Fails the gate [[fails-the-gate]]";
    await setUpProject(
      sandbox,
      boardMarkdown([
        ["Ready", []],
        ["In Progress", []],
        ["Ready to Merge", [card]],
        ["Blocked", []],
        ["Done", []],
      ]),
      { gate: [{ name: "check", cmd: "exit 1" }] },
    );
    await makeTicketBranch(sandbox, "fails-the-gate");

    const merge = await runCli(sandbox, ["merge", "fails-the-gate"]);
    expect(merge.code).toBe(2);

    expect(await git(sandbox.project, "log", "--oneline", "main")).not.toContain(
      "work for fails-the-gate",
    );
    const board = await readBoard(sandbox);
    expect(cardsUnder(board, "Ready to Merge")).toEqual([]);
    // Unchecked: blocked work is not finished work.
    expect(cardsUnder(board, "Blocked")).toEqual([card]);
  });

  it("honours the configured column names rather than the defaults", async () => {
    const sandbox = await makeSandbox();
    await setUpProject(
      sandbox,
      boardMarkdown([
        ["Ready", []],
        ["In Progress", []],
        ["Ready to Merge", ["- [ ] Renamed columns [[renamed-columns]]"]],
        ["Held", []],
        ["Shipped", []],
      ]),
      {
        board: {
          path: ".jfdi/board.md",
          columns: {
            begin: "Ready",
            inProgress: "In Progress",
            done: "Shipped",
            blocked: "Held",
            readyToMerge: "Ready to Merge",
            inbox: "Inbox",
          },
        },
      },
    );
    await makeTicketBranch(sandbox, "renamed-columns");

    expect((await runCli(sandbox, ["merge", "renamed-columns"])).code).toBe(0);

    const board = await readBoard(sandbox);
    expect(cardsUnder(board, "Shipped")).toEqual(["- [x] Renamed columns [[renamed-columns]]"]);
  });

  it("matches a bare card by its derived ticket id", async () => {
    // Cards without a wikilink get a slug-plus-hash id; the merge command has
    // to recognise its own card through the same derivation.
    const sandbox = await makeSandbox();
    const cardText = "Tidy up the logs";
    const ticketId = ticketIdFromCard(cardText);
    await setUpProject(
      sandbox,
      boardMarkdown([
        ["Ready", []],
        ["In Progress", []],
        ["Ready to Merge", [`- [ ] ${cardText}`]],
        ["Blocked", []],
        ["Done", []],
      ]),
    );
    await makeTicketBranch(sandbox, ticketId);

    expect((await runCli(sandbox, ["merge", ticketId])).code).toBe(0);

    expect(cardsUnder(await readBoard(sandbox), "Done")).toEqual([`- [x] ${cardText}`]);
  });

  it("merges a ticket with no card on the board, leaving the board byte-identical", async () => {
    const sandbox = await makeSandbox();
    const board = boardMarkdown([
      ["Ready", []],
      ["In Progress", []],
      ["Ready to Merge", ["- [ ] Something else [[other-ticket]]"]],
      ["Blocked", []],
      ["Done", []],
    ]);
    await setUpProject(sandbox, board);
    await makeTicketBranch(sandbox, "cardless-ticket");

    expect((await runCli(sandbox, ["merge", "cardless-ticket"])).code).toBe(0);

    expect(await git(sandbox.project, "log", "--oneline", "main")).toContain(
      "work for cardless-ticket",
    );
    expect(await readBoard(sandbox)).toBe(board);
    const moved = (await readEvents(sandbox)).filter((event) => event.type === "card_moved");
    expect(moved).toEqual([]);
  });

  it("still merges when the destination column is missing, leaving the board as-is", async () => {
    // The board is the human's document: a column they renamed or deleted
    // must degrade to a logged error, never to a lost merge.
    const sandbox = await makeSandbox();
    const card = "- [ ] No such column [[no-such-column]]";
    const board = boardMarkdown([
      ["Ready", []],
      ["In Progress", []],
      ["Ready to Merge", [card]],
      ["Blocked", []],
    ]);
    await setUpProject(sandbox, board, {
      board: {
        path: ".jfdi/board.md",
        columns: {
          begin: "Ready",
          inProgress: "In Progress",
          done: "Nowhere",
          blocked: "Blocked",
          readyToMerge: "Ready to Merge",
          inbox: "Inbox",
        },
      },
    });
    await makeTicketBranch(sandbox, "no-such-column");

    const merge = await runCli(sandbox, ["merge", "no-such-column"]);
    expect(merge.code).toBe(0);

    expect(await git(sandbox.project, "log", "--oneline", "main")).toContain(
      "work for no-such-column",
    );
    expect(await readBoard(sandbox)).toBe(board);
    const events = await readEvents(sandbox);
    expect(events.filter((event) => event.type === "card_moved")).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.type === "error" && String(event.data?.message ?? "").includes("could not move"),
      ),
    ).toBe(true);
  });
});
