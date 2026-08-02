import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findColumn, parseBoard } from "../board.js";
import { createWorktree, git } from "../git.js";
import { worktreesDir } from "../pipeline.js";
import { commitFile, type Fixture, makeFixture } from "../test-helpers.js";
import { mergeCommand } from "./merge.js";

const TICKET_ID = "ship-the-thing";

/** The card the coordinator parked in Ready to Merge, awaiting `jfdi merge`. */
const CARD = `- [ ] Ship the thing [[${TICKET_ID}]]`;

function board(readyToMerge: string[], inProgress: string[] = []): string {
  return [
    "---",
    "",
    "kanban-plugin: board",
    "",
    "---",
    "",
    "## Ready",
    "",
    "## In Progress",
    "",
    ...inProgress,
    "",
    "## Ready to Merge",
    "",
    ...readyToMerge,
    "",
    "## Blocked",
    "",
    "## Done",
    "",
  ].join("\n");
}

/** The command narrates to the console; these tests assert on the board instead. */
function silence(): void {
  // Deliberately drops the message.
}

let fixture: Fixture;
let originalCwd: string;
let originalJfdiHome: string | undefined;

async function writeBoard(content: string): Promise<void> {
  await fs.writeFile(path.join(fixture.jfdiDir, "board.md"), content);
}

async function readColumns(): Promise<ReturnType<typeof parseBoard>> {
  return parseBoard(await fs.readFile(path.join(fixture.jfdiDir, "board.md"), "utf8"));
}

function cardsIn(columns: ReturnType<typeof parseBoard>, name: string): string[] {
  return (findColumn(columns, name)?.cards ?? []).map((card) => card.raw);
}

/** A ticket branch with one commit, in the worktree `jfdi merge` expects to find. */
async function makeTicketBranch(): Promise<void> {
  const worktree = await createWorktree(
    fixture.repo,
    worktreesDir(fixture.jfdiDir),
    TICKET_ID,
    "main",
  );
  await commitFile(worktree.path, "thing.txt", "the thing\n", "implement the thing");
}

beforeEach(async () => {
  fixture = await makeFixture();
  originalCwd = process.cwd();
  originalJfdiHome = process.env.JFDI_HOME;
  // Run state stays inside the fixture, not the shared test home.
  process.env.JFDI_HOME = path.join(fixture.root, "jfdi-home");
  process.chdir(fixture.repo);
  vi.spyOn(console, "log").mockImplementation(silence);
  vi.spyOn(console, "error").mockImplementation(silence);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  if (originalJfdiHome === undefined) delete process.env.JFDI_HOME;
  else process.env.JFDI_HOME = originalJfdiHome;
  await fixture.cleanup();
});

describe("mergeCommand board bookkeeping", () => {
  it("moves the merged ticket's card to Done and checks it off", async () => {
    await writeBoard(board([CARD]));
    await makeTicketBranch();

    expect(await mergeCommand(TICKET_ID)).toBe(0);

    expect(await git(fixture.repo, "log", "--oneline", "main")).toContain("implement the thing");
    const columns = await readColumns();
    expect(cardsIn(columns, "Ready to Merge")).toEqual([]);
    expect(cardsIn(columns, "Done")).toEqual([`- [x] Ship the thing [[${TICKET_ID}]]`]);
  });

  it("finds the card wherever a human left it", async () => {
    await writeBoard(board([], [CARD]));
    await makeTicketBranch();

    expect(await mergeCommand(TICKET_ID)).toBe(0);

    const columns = await readColumns();
    expect(cardsIn(columns, "In Progress")).toEqual([]);
    expect(cardsIn(columns, "Done")).toEqual([`- [x] Ship the thing [[${TICKET_ID}]]`]);
  });

  it("moves the card to Blocked when integration blocks", async () => {
    await fs.writeFile(
      path.join(fixture.jfdiDir, "config.json"),
      JSON.stringify({ gate: [{ name: "check", cmd: "exit 1" }] }),
    );
    await writeBoard(board([CARD]));
    await makeTicketBranch();

    expect(await mergeCommand(TICKET_ID)).toBe(2);

    expect(await git(fixture.repo, "log", "--oneline", "main")).not.toContain(
      "implement the thing",
    );
    const columns = await readColumns();
    expect(cardsIn(columns, "Ready to Merge")).toEqual([]);
    expect(cardsIn(columns, "Blocked")).toEqual([CARD]);
  });

  it("merges a ticket with no matching card, leaving the board untouched", async () => {
    const unrelated = board(["- [ ] Something else [[other-ticket]]"]);
    await writeBoard(unrelated);
    await makeTicketBranch();

    expect(await mergeCommand(TICKET_ID)).toBe(0);

    expect(await git(fixture.repo, "log", "--oneline", "main")).toContain("implement the thing");
    expect(await fs.readFile(path.join(fixture.jfdiDir, "board.md"), "utf8")).toBe(unrelated);
  });

  it("merges with no board at all", async () => {
    await makeTicketBranch();

    expect(await mergeCommand(TICKET_ID)).toBe(0);

    expect(await git(fixture.repo, "log", "--oneline", "main")).toContain("implement the thing");
  });
});
