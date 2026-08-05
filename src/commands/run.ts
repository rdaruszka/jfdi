import * as path from "node:path";
import { describeBlockers, unresolvedBlockers } from "../blocking.js";
import { type Board, ensureColumns, parseBoard } from "../board.js";
import { boardPath, findTicketCard, moveCardSafe } from "../cards.js";
import { integrateTicket } from "../integrate.js";
import type { PipelineContext } from "../pipeline.js";
import { runPipeline } from "../pipeline.js";
import { recordMergeReady, recordObservations } from "../report.js";
import { resolveTicket } from "../tickets.js";
import { EXIT_SIGINT } from "../util/exit-codes.js";
import { readIfExists } from "../util/fsx.js";
import { attachInlinePrinter, attachRetryKey, buildContext } from "./context.js";

/** Options for a single-ticket run; `isForced` runs a blocked-by ticket anyway. */
export interface RunOptions {
  isForced?: boolean;
}

/**
 * `jfdi run <ticket>` — single-ticket mode: the full pipeline inline. <ticket>
 * is a card line, a [[wikilink]], or an inline description. A board is not
 * required; when one exists and holds a matching card, the run keeps that card
 * in step exactly as the coordinator would.
 */
export async function runCommand(ticketRef: string, options: RunOptions = {}): Promise<number> {
  const context = await buildContext();
  const detach = attachInlinePrinter(context.log);
  /** Release what the run acquired: the pause's timers, then the pending writes. */
  const shutdown = async (): Promise<void> => {
    context.pause.stop();
    await context.log.flush();
  };
  // A single-ticket run pauses on a broken provider exactly as the coordinator
  // does, so it needs the same way for a human to say "repaired — go". While
  // that key is live the terminal sends no SIGINT, so a Ctrl-C has to do the
  // shutdown the default handler would have skipped, then exit as it would.
  const detachRetryKey = attachRetryKey(context.pause, () => {
    void shutdown()
      .catch((error: unknown) => {
        console.error(`could not shut down cleanly: ${(error as Error).message}`);
      })
      .then(() => process.exit(EXIT_SIGINT));
  });
  try {
    return await runTicketInline(context, ticketRef, options);
  } finally {
    detachRetryKey();
    detach();
    await shutdown();
  }
}

/** The run itself, over an already-built context. */
export async function runTicketInline(
  context: PipelineContext,
  ticketRef: string,
  options: RunOptions = {},
): Promise<number> {
  const ticketsDir = path.join(context.repoRoot, context.config.ticketsDir);
  const ticket = await resolveTicket(ticketRef, ticketsDir);
  console.log(`ticket: ${ticket.id}`);

  const columns = context.config.board.columns;

  // Blocking means blocked on every path: a direct run refuses a ticket whose
  // blocked-by tickets are not done, and only --force spells out the override.
  // The board is the truth for a blocker's done-ness; a boardless run has no
  // card for any blocker, so every listed blocker reads as unresolved.
  const blockers = unresolvedBlockers(ticket.links, await readBoardOrEmpty(context), columns.done);
  if (blockers.ids.length > 0) {
    const detail = describeBlockers(blockers);
    if (!options.isForced) {
      console.error(`\nBlocked: ${ticket.id} is blocked by ${detail}.`);
      console.error("Those tickets are not done. Re-run with --force to override.");
      return 2;
    }
    console.warn(`Forcing past unresolved blockers: ${detail}`);
  }

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
    const observations =
      outcome.status === "passed" ? outcome.report.observations : outcome.observations;
    await surfaceObservations(context, ticket.id, observations);
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

    if (context.config.integration.mode === "auto") {
      const merged = await integrateTicket(context, ticket, outcome.worktree);
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

/** Send proposals to the inbox, or keep them visible in a boardless run's summary. */
async function surfaceObservations(
  context: PipelineContext,
  ticketId: string,
  observations: string[],
): Promise<void> {
  if (observations.length === 0) return;
  const hasObservationInbox = await recordObservations(context, ticketId, observations);
  if (hasObservationInbox) return;
  console.log("\nObservations:");
  for (const observation of observations) console.log(`- ${observation}`);
}

/** The board a run should read blocker done-ness from; empty when none exists. */
async function readBoardOrEmpty(context: PipelineContext): Promise<Board> {
  const content = await readIfExists(boardPath(context));
  return content === null ? { columns: [] } : parseBoard(content);
}
