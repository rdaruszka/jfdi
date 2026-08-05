import * as fs from "node:fs/promises";
import { atomicWrite, readModifyWrite } from "./util/fsx.js";
import { ticketIdFromCard } from "./util/ids.js";

export interface Card {
  /** The raw line as it appears in the file, e.g. "- [ ] Fix the thing [[fix-thing]]". */
  raw: string;
  /** Card text with the checkbox marker stripped. */
  text: string;
  checked: boolean;
}

export interface Column {
  name: string;
  cards: Card[];
}

export interface Board {
  columns: Column[];
}

const COLUMN_RE = /^##\s+(.+?)\s*$/;
const CARD_RE = /^- \[( |x)\]\s?(.*)$/;

/** Parse Obsidian Kanban plugin markdown into columns and cards. */
export function parseBoard(content: string): Board {
  const lines = content.split("\n");
  const columns: Column[] = [];
  let current: Column | null = null;
  for (const line of lines) {
    const col = COLUMN_RE.exec(line);
    if (col?.[1]) {
      current = { name: col[1], cards: [] };
      columns.push(current);
      continue;
    }
    const card = CARD_RE.exec(line);
    if (card && current) {
      current.cards.push({ raw: line, text: (card[2] ?? "").trim(), checked: card[1] === "x" });
    }
  }
  return { columns };
}

export function findColumn(board: Board, name: string): Column | undefined {
  return board.columns.find((c) => c.name === name);
}

/** Name of the column holding this ticket's card, or null if the board has none. */
export function columnOfTicket(board: Board, ticketId: string): string | null {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (ticketIdFromCard(card.text) === ticketId) return column.name;
    }
  }
  return null;
}

/** Locate the card whose text matches (exact raw line or trimmed text). */
export function findCard(board: Board, cardRef: string): { column: Column; card: Card } | null {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.raw === cardRef || card.text === cardRef.trim()) return { column, card };
    }
  }
  return null;
}

export class BoardEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardEditError";
  }
}

function columnLineRange(lines: string[], columnName: string): { start: number; end: number } {
  const start = lines.findIndex((line) => {
    const match = COLUMN_RE.exec(line);
    return match?.[1] === columnName;
  });
  if (start === -1) throw new BoardEditError(`column "${columnName}" not found in board`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (COLUMN_RE.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Index of the line after the last card in the column range (insertion point). */
function insertionPoint(lines: string[], range: { start: number; end: number }): number {
  let last = range.start;
  for (let i = range.start + 1; i < range.end; i++) {
    if (CARD_RE.test(lines[i] as string)) last = i;
  }
  return last + 1;
}

/**
 * Move one card line from one column to another — a minimal, surgical edit.
 * Atomic read-modify-write with mtime-conflict retry; safe against Obsidian
 * writing the file concurrently. Optionally rewrites the card line in transit
 * (e.g. checking it off on done).
 */
export async function moveCard(
  boardPath: string,
  cardRaw: string,
  fromColumn: string,
  toColumn: string,
  options: { rewriteLine?: (line: string) => string } = {},
): Promise<void> {
  await readModifyWrite(boardPath, (content) => {
    const lines = content.split("\n");
    const from = columnLineRange(lines, fromColumn);
    let cardIndex = -1;
    for (let i = from.start + 1; i < from.end; i++) {
      if (lines[i] === cardRaw) {
        cardIndex = i;
        break;
      }
    }
    if (cardIndex === -1)
      throw new BoardEditError(`card not found in column "${fromColumn}": ${cardRaw}`);
    lines.splice(cardIndex, 1);
    const to = columnLineRange(lines, toColumn);
    const line = options.rewriteLine ? options.rewriteLine(cardRaw) : cardRaw;
    lines.splice(insertionPoint(lines, to), 0, line);
    return lines.join("\n");
  });
}

/**
 * Append a card to a column unless an identical card already exists anywhere on
 * the board (re-dispatches must not duplicate proposals). Creates the column if
 * missing. Same atomic read-modify-write discipline as moveCard.
 */
export function addCardIfAbsent(
  boardPath: string,
  columnName: string,
  text: string,
): Promise<boolean> {
  return readModifyWrite(boardPath, (content) => {
    const board = parseBoard(content);
    if (board.columns.some((c) => c.cards.some((k) => k.text === text.trim()))) return null;
    const lines = content.split("\n");
    if (!findColumn(board, columnName)) {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(`## ${columnName}`);
    }
    const range = columnLineRange(lines, columnName);
    lines.splice(insertionPoint(lines, range), 0, `- [ ] ${text.trim()}`);
    return lines.join("\n");
  });
}

/** Ensure the named columns exist, appending missing ones at the end of the board. */
export async function ensureColumns(boardPath: string, names: string[]): Promise<void> {
  await readModifyWrite(boardPath, (content) => {
    const board = parseBoard(content);
    const missing = names.filter((n) => !findColumn(board, n));
    if (missing.length === 0) return null;
    let next = content;
    if (!next.endsWith("\n")) next += "\n";
    for (const name of missing) next += `\n## ${name}\n`;
    return next;
  });
}

/** Create a board file with the given columns if it does not exist. */
export async function createBoardIfMissing(boardPath: string, columns: string[]): Promise<void> {
  try {
    await fs.access(boardPath);
    return;
  } catch {
    // Absent, which is the whole point of the call — create it.
    const body = columns.map((c) => `## ${c}\n`).join("\n");
    await atomicWrite(boardPath, `---\n\nkanban-plugin: board\n\n---\n\n${body}`);
  }
}
