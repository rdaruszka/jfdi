import * as path from "node:path";
import { integrateTicket } from "../integrate.js";
import { runPipeline } from "../pipeline.js";
import { recordMergeReady, recordObservations } from "../report.js";
import { resolveTicket } from "../tickets.js";
import { attachInlinePrinter, buildContext } from "./context.js";

/**
 * `jfdi run <ticket>` — single-ticket mode: the full pipeline inline, no board
 * required. <ticket> is a card line, a [[wikilink]], or an inline description.
 */
export async function runCommand(ticketRef: string): Promise<number> {
  const ctx = await buildContext();
  const detach = attachInlinePrinter(ctx.log);
  try {
    const ticketsDir = path.join(ctx.repoRoot, ctx.config.ticketsDir);
    const ticket = await resolveTicket(ticketRef, ticketsDir);
    console.log(`ticket: ${ticket.id}`);
    const outcome = await runPipeline(ctx, ticket);
    if (outcome.status === "blocked") {
      console.error(`\nBlocked: ${outcome.reason}`);
      console.error(`See the ticket note in ${ctx.config.ticketsDir}/ for details.`);
      return 2;
    }
    if (outcome.status === "failed") {
      console.error(`\nFailed: ${outcome.reason}`);
      return 1;
    }

    await recordObservations(ctx, ticket.id, outcome.report.observations);
    if (ctx.config.integration.mode === "auto") {
      const merged = await integrateTicket(ctx, ticket, outcome.worktree, outcome.report);
      if (merged.status === "blocked") {
        console.error(`\nIntegration blocked: ${merged.reason}`);
        return 2;
      }
      console.log(`\nDone — merged into ${ctx.config.integration.target_branch}.`);
      return 0;
    }

    // on-approval: park it as ready to merge.
    const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
    await recordMergeReady(ctx, ticket.id, notePath, outcome.report);
    console.log(`\nPipeline passed. Approve with: jfdi merge ${ticket.id}`);
    return 0;
  } finally {
    detach();
    await ctx.log.flush();
  }
}
