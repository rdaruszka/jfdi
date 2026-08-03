import * as path from "node:path";
import { ensureColumns } from "../board.js";
import { boardPath, findTicketCard, moveCardSafe } from "../cards.js";
import { integrateTicket } from "../integrate.js";
import type { PipelineContext } from "../pipeline.js";
import { runPipeline } from "../pipeline.js";
import { recordMergeReady, recordObservations } from "../report.js";
import { resolveTicket } from "../tickets.js";
import { attachInlinePrinter, attachRetryKey, buildContext } from "./context.js";

/**
 * `jfdi run <ticket>` — single-ticket mode: the full pipeline inline. <ticket>
 * is a card line, a [[wikilink]], or an inline description. A board is not
 * required; when one exists and holds a matching card, the run keeps that card
 * in step exactly as the coordinator would.
 */
export async function runCommand(ticketRef: string): Promise<number> {
  const context = await buildContext();
  const detach = attachInlinePrinter(context.log);
  // A single-ticket run pauses on a broken provider exactly as the coordinator
  // does, so it needs the same way for a human to say "repaired — go".
  const detachRetryKey = attachRetryKey(context.pause);
  try {
    return await runTicketInline(context, ticketRef);
  } finally {
    detachRetryKey();
    context.pause.stop();
    detach();
    await context.log.flush();
  }
}

/** The run itself, over an already-built context. */
export async function runTicketInline(
  context: PipelineContext,
  ticketRef: string,
): Promise<number> {
  const ticketsDir = path.join(context.repoRoot, context.config.ticketsDir);
  const ticket = await resolveTicket(ticketRef, ticketsDir);
  console.log(`ticket: ${ticket.id}`);

  const columns = context.config.board.columns;
  const located = await findTicketCard(context, ticket.id, columns.inbox);
  if (located) {
    // Unlike the coordinator, a run has no startup phase to prepare the board —
    // make room for every column this run can leave the card in.
    await ensureColumns(boardPath(context), [
      columns.inProgress,
      columns.blocked,
      columns.readyToMerge,
      columns.done,
    ]);
    await moveCardSafe(context, located.card, located.column, columns.inProgress, false);
  }
  /** Park the card where the run's outcome leaves it. No card: boardless run. */
  const settleCard = (to: string, shouldCheckOff = false): Promise<void> =>
    located
      ? moveCardSafe(context, located.card, columns.inProgress, to, shouldCheckOff)
      : Promise.resolve();

  try {
    const outcome = await runPipeline(context, ticket);
    if (outcome.status === "blocked") {
      await settleCard(columns.blocked);
      console.error(`\nBlocked: ${outcome.reason}`);
      console.error(`See the ticket note in ${context.config.ticketsDir}/ for details.`);
      return 2;
    }
    if (outcome.status === "failed") {
      await settleCard(columns.blocked);
      console.error(`\nFailed: ${outcome.reason}`);
      return 1;
    }

    await recordObservations(context, ticket.id, outcome.report.observations);
    if (context.config.integration.mode === "auto") {
      const merged = await integrateTicket(context, ticket, outcome.worktree, outcome.report);
      if (merged.status === "blocked") {
        await settleCard(columns.blocked);
        console.error(`\nIntegration blocked: ${merged.reason}`);
        return 2;
      }
      await settleCard(columns.done, true);
      console.log(`\nDone — merged into ${context.config.integration.target_branch}.`);
      return 0;
    }

    // on-approval: park it as ready to merge.
    const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
    await recordMergeReady(context, ticket.id, notePath, outcome.report);
    await settleCard(columns.readyToMerge);
    console.log(`\nPipeline passed. Approve with: jfdi merge ${ticket.id}`);
    return 0;
  } catch (error) {
    // A crash mid-run would otherwise strand the card in In Progress. The board
    // move is advisory; the error itself is the caller's to report.
    await settleCard(columns.blocked).catch(() => {
      // Best-effort only — never mask the failure being rethrown.
    });
    throw error;
  }
}
