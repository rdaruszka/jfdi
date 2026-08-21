import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCardIfAbsent,
  BoardEditError,
  createBoardIfMissing,
  ensureColumns,
  findColumn,
  moveCard,
  parseBoard,
} from "./board.js";

const SAMPLE = `---

kanban-plugin: board

---

## Ready

- [ ] Add a --help flag
- [ ] Fix the thing [[fix-thing]]

## In Progress

- [ ] Old task

## Done

- [x] Shipped one

`;

let directory: string;
let boardPath: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-board-"));
  boardPath = path.join(directory, "board.md");
  await fs.writeFile(boardPath, SAMPLE);
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("parseBoard", () => {
  it("parses columns and cards", () => {
    const board = parseBoard(SAMPLE);
    expect(board.columns.map((c) => c.name)).toEqual(["Ready", "In Progress", "Done"]);
    expect(findColumn(board, "Ready")?.cards.map((c) => c.text)).toEqual([
      "Add a --help flag",
      "Fix the thing [[fix-thing]]",
    ]);
    expect(findColumn(board, "Done")?.cards[0]?.checked).toBe(true);
  });

  it("ignores non-card lines", () => {
    const board = parseBoard("## Col\n\nsome prose\n- [ ] real card\n- not a card\n");
    expect(findColumn(board, "Col")?.cards.map((c) => c.text)).toEqual(["real card"]);
  });
});

describe("moveCard", () => {
  it("writes through a symlinked board and preserves the link", async () => {
    // The deployed shape: board.md in .jfdi/ is a symlink into an Obsidian
    // vault. A move must land in the vault file, not replace the link.
    const vault = path.join(directory, "vault");
    await fs.mkdir(vault);
    const vaultBoard = path.join(vault, "kanban.md");
    await fs.rename(boardPath, vaultBoard);
    await fs.symlink(vaultBoard, boardPath);

    await moveCard(boardPath, "- [ ] Add a --help flag", "Ready", "In Progress");

    expect((await fs.lstat(boardPath)).isSymbolicLink()).toBe(true);
    const board = parseBoard(await fs.readFile(vaultBoard, "utf8"));
    expect(findColumn(board, "In Progress")?.cards.map((c) => c.text)).toEqual([
      "Old task",
      "Add a --help flag",
    ]);
  });

  it("moves a card line between columns surgically", async () => {
    await moveCard(boardPath, "- [ ] Add a --help flag", "Ready", "In Progress");
    const content = await fs.readFile(boardPath, "utf8");
    const board = parseBoard(content);
    expect(findColumn(board, "Ready")?.cards.map((c) => c.text)).toEqual([
      "Fix the thing [[fix-thing]]",
    ]);
    expect(findColumn(board, "In Progress")?.cards.map((c) => c.text)).toEqual([
      "Old task",
      "Add a --help flag",
    ]);
    // Surgical: frontmatter and unrelated content untouched.
    expect(content).toContain("kanban-plugin: board");
    expect(content).toContain("- [x] Shipped one");
  });

  it("can rewrite the line in transit (check off on done)", async () => {
    await moveCard(boardPath, "- [ ] Old task", "In Progress", "Done", {
      rewriteLine: (l) => l.replace("- [ ]", "- [x]"),
    });
    const board = parseBoard(await fs.readFile(boardPath, "utf8"));
    expect(findColumn(board, "Done")?.cards.map((c) => c.raw)).toContain("- [x] Old task");
  });

  it("throws when the card is not in the source column", async () => {
    await expect(moveCard(boardPath, "- [ ] Nope", "Ready", "Done")).rejects.toThrow(
      BoardEditError,
    );
  });

  it("throws when the target column is missing", async () => {
    await expect(
      moveCard(boardPath, "- [ ] Add a --help flag", "Ready", "Missing"),
    ).rejects.toThrow(BoardEditError);
  });
});

describe("ensureColumns", () => {
  it("appends missing columns only", async () => {
    await ensureColumns(boardPath, ["Ready", "Blocked", "Ready to Merge"]);
    const board = parseBoard(await fs.readFile(boardPath, "utf8"));
    expect(board.columns.map((c) => c.name)).toEqual([
      "Ready",
      "In Progress",
      "Done",
      "Blocked",
      "Ready to Merge",
    ]);
  });

  it("is a no-op when all exist", async () => {
    const before = await fs.readFile(boardPath, "utf8");
    await ensureColumns(boardPath, ["Ready"]);
    expect(await fs.readFile(boardPath, "utf8")).toBe(before);
  });
});

describe("createBoardIfMissing", () => {
  it("creates a kanban-plugin board with columns", async () => {
    const boardPath = path.join(directory, "new-board.md");
    await createBoardIfMissing(boardPath, ["Ready", "Done"]);
    const content = await fs.readFile(boardPath, "utf8");
    expect(content).toContain("kanban-plugin: board");
    const board = parseBoard(content);
    expect(board.columns.map((c) => c.name)).toEqual(["Ready", "Done"]);
  });

  it("does not overwrite an existing board", async () => {
    await createBoardIfMissing(boardPath, ["Other"]);
    expect(await fs.readFile(boardPath, "utf8")).toBe(SAMPLE);
  });
});

describe("addCardIfAbsent", () => {
  it("appends a card after existing cards in the column", async () => {
    expect(await addCardIfAbsent(boardPath, "Ready", "New proposal *(from t1)*")).toBe(true);
    const board = parseBoard(await fs.readFile(boardPath, "utf8"));
    expect(findColumn(board, "Ready")?.cards.map((c) => c.text)).toEqual([
      "Add a --help flag",
      "Fix the thing [[fix-thing]]",
      "New proposal *(from t1)*",
    ]);
  });

  it("is idempotent: an identical card anywhere on the board is not duplicated", async () => {
    await addCardIfAbsent(boardPath, "Ready", "New proposal *(from t1)*");
    expect(await addCardIfAbsent(boardPath, "Ready", "New proposal *(from t1)*")).toBe(false);
    // Same text targeted at another column is still a duplicate.
    expect(await addCardIfAbsent(boardPath, "Done", "New proposal *(from t1)*")).toBe(false);
    const board = parseBoard(await fs.readFile(boardPath, "utf8"));
    const all = board.columns.flatMap((c) => c.cards.map((k) => k.text));
    expect(all.filter((t) => t === "New proposal *(from t1)*")).toHaveLength(1);
  });

  it("creates the column when it is missing", async () => {
    await addCardIfAbsent(boardPath, "Inbox", "Spotted dead code *(from t2)*");
    const board = parseBoard(await fs.readFile(boardPath, "utf8"));
    expect(findColumn(board, "Inbox")?.cards.map((c) => c.text)).toEqual([
      "Spotted dead code *(from t2)*",
    ]);
  });
});
