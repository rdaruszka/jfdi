import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoardEditError,
  createBoardIfMissing,
  ensureColumns,
  findCard,
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

let dir: string;
let boardPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-board-"));
  boardPath = path.join(dir, "board.md");
  await fs.writeFile(boardPath, SAMPLE);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
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

  it("finds cards by text", () => {
    const board = parseBoard(SAMPLE);
    const hit = findCard(board, "Add a --help flag");
    expect(hit?.column.name).toBe("Ready");
  });
});

describe("moveCard", () => {
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
    const p = path.join(dir, "new-board.md");
    await createBoardIfMissing(p, ["Ready", "Done"]);
    const content = await fs.readFile(p, "utf8");
    expect(content).toContain("kanban-plugin: board");
    const board = parseBoard(content);
    expect(board.columns.map((c) => c.name)).toEqual(["Ready", "Done"]);
  });

  it("does not overwrite an existing board", async () => {
    await createBoardIfMissing(boardPath, ["Other"]);
    expect(await fs.readFile(boardPath, "utf8")).toBe(SAMPLE);
  });
});
