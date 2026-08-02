import * as path from "node:path";
import { findTicketCard, moveCardSafe } from "../cards.js";
import { branchExists, ticketBranch } from "../git.js";
import { integrateTicket } from "../integrate.js";
import { worktreesDir } from "../pipeline.js";
import { loadReport } from "../report.js";
import { resolveTicket } from "../tickets.js";
import { fileExists } from "../util/fsx.js";
import { attachInlinePrinter, buildContext, type CliContext } from "./context.js";

/**
 * The board bookkeeping the coordinator would have done for a card it dispatched:
 * an approval typed by hand has to close its own card. The card may be anywhere
 * (a human moves cards too), and there may be no card at all — a `jfdi run`
 * ticket never had one, and the merge proceeds boardless.
 */
async function moveTicketCard(
  context: CliContext,
  ticketId: string,
  toColumn: string,
  shouldCheckOff: boolean,
): Promise<void> {
  const located = await findTicketCard(context, ticketId, context.config.board.columns.inbox);
  if (!located) return;
  await moveCardSafe(context, located.card, located.column, toColumn, shouldCheckOff);
}

/**
 * `jfdi merge <ticket>` — approve a Ready-to-Merge ticket (on-approval mode).
 * Detects a branch the human already merged by hand and closes without
 * double-merging, then moves the ticket's card itself rather than leaving it
 * for a running coordinator's sweep to notice later.
 */
export async function mergeCommand(ticketId: string): Promise<number> {
  const context = await buildContext();
  const detach = attachInlinePrinter(context.log);
  try {
    const branch = ticketBranch(ticketId);
    if (!(await branchExists(context.repoRoot, branch))) {
      console.error(`no branch ${branch} — nothing to merge for ticket "${ticketId}"`);
      return 1;
    }
    const ticketsDir = path.join(context.repoRoot, context.config.ticketsDir);
    const notePath = path.join(ticketsDir, `${ticketId}.md`);
    const ticket = (await fileExists(notePath))
      ? await resolveTicket(`[[${ticketId}]]`, ticketsDir)
      : {
          id: ticketId,
          cardText: ticketId,
          spec: ticketId,
          notePath: null,
          mode: "default" as const,
        };

    const worktreePath = path.join(worktreesDir(context.jfdiDir), ticketId);
    const report = await loadReport(context.stateDir, ticketId);
    const outcome = await integrateTicket(context, ticket, { path: worktreePath, branch }, report);
    const columns = context.config.board.columns;
    if (outcome.status === "blocked") {
      await moveTicketCard(context, ticketId, columns.blocked, false);
      console.error(`Integration blocked: ${outcome.reason}`);
      return 2;
    }
    await moveTicketCard(context, ticketId, columns.done, true);
    console.log(
      outcome.status === "already-merged"
        ? "Branch was already contained in the target — closed without merging."
        : `Merged into ${context.config.integration.target_branch}.`,
    );
    return 0;
  } finally {
    detach();
    await context.log.flush();
  }
}
