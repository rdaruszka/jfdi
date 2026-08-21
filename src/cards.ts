import * as path from "node:path";
import { type Card, moveCard, parseBoard } from "./board.js";
import type { PipelineContext } from "./pipeline.js";
import { readIfExists } from "./util/fsx.js";
import { ticketIdFromCard } from "./util/ids.js";

/** Where the board lives for a project — every card read and write starts here. */
export function boardPath(context: PipelineContext): string {
  return path.join(context.projectRoot, context.config.board.path);
}

/**
 * The card a ticket should keep in step: the first one anywhere on the board
 * whose ticket id matches. The inbox is skipped — its cards are agent
 * proposals a human has not promoted, and nothing dispatches from there.
 */
export async function findTicketCard(
  context: PipelineContext,
  ticketId: string,
  inboxColumn: string,
): Promise<{ card: Card; column: string } | null> {
  const content = await readIfExists(boardPath(context));
  if (content === null) return null;
  for (const column of parseBoard(content).columns) {
    if (column.name === inboxColumn) continue;
    const card = column.cards.find((c) => ticketIdFromCard(c.text) === ticketId);
    if (card) return { card, column: column.name };
  }
  return null;
}

type MoveResult = "moved" | "skipped" | "failed";

/**
 * Move a card, tolerating a human having already moved it: if the raw line
 * isn't in the expected source column, find it wherever it is; if it is gone
 * entirely — or already sits in the destination — leave the board alone (the
 * board is the human's document).
 */
async function tolerantMove(
  targetBoardPath: string,
  cardRaw: string,
  from: string,
  to: string,
  shouldCheckOff: boolean,
): Promise<MoveResult> {
  const rewrittenLine = shouldCheckOff ? cardRaw.replace("- [ ]", "- [x]") : cardRaw;
  // Already where it belongs with nothing left to check off: a rewrite would be
  // a needless write to a file the human has open. An unchecked card in the
  // destination still needs its in-place check-off.
  const isSettled = (column: string) => column === to && rewrittenLine === cardRaw;
  if (isSettled(from)) return "skipped";
  const rewrite = shouldCheckOff
    ? { rewriteLine: (line: string) => line.replace("- [ ]", "- [x]") }
    : {};
  try {
    await moveCard(targetBoardPath, cardRaw, from, to, rewrite);
    return "moved";
  } catch {
    // Not in `from` — locate it.
    const content = await readIfExists(targetBoardPath);
    if (content === null) return "skipped";
    const board = parseBoard(content);
    const actual = board.columns.find((column) => column.cards.some((c) => c.raw === cardRaw));
    if (!actual || isSettled(actual.name)) return "skipped";
    try {
      await moveCard(targetBoardPath, cardRaw, actual.name, to, rewrite);
      return "moved";
    } catch {
      return "failed";
    }
  }
}

/**
 * Advance one card to the column its ticket's progress calls for, and record
 * the move on the event stream. Every mover goes through here — the
 * coordinator, `jfdi run`, and `jfdi merge` alike — so a card travels the same
 * way whichever one is driving.
 */
export async function moveCardSafe(
  context: PipelineContext,
  card: Card,
  from: string,
  to: string,
  shouldCheckOff: boolean,
): Promise<void> {
  const result = await tolerantMove(boardPath(context), card.raw, from, to, shouldCheckOff);
  if (result === "failed") {
    context.log.emit("error", ticketIdFromCard(card.text), {
      message: `could not move card to "${to}" — leaving board as-is`,
    });
    return;
  }
  if (result === "moved") context.log.emit("card_moved", ticketIdFromCard(card.text), { from, to });
}
