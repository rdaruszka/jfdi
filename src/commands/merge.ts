import * as path from "node:path";
import { branchExists, ticketBranch } from "../git.js";
import { integrateTicket } from "../integrate.js";
import { worktreesDir } from "../pipeline.js";
import { loadReport } from "../report.js";
import { resolveTicket } from "../tickets.js";
import { fileExists } from "../util/fsx.js";
import { attachInlinePrinter, buildContext } from "./context.js";

/**
 * `jfdi merge <ticket>` — approve a Ready-to-Merge ticket (on-approval mode).
 * Detects a branch the human already merged by hand and closes without
 * double-merging.
 */
export async function mergeCommand(ticketId: string): Promise<number> {
  const ctx = await buildContext();
  const detach = attachInlinePrinter(ctx.log);
  try {
    const branch = ticketBranch(ticketId);
    if (!(await branchExists(ctx.repoRoot, branch))) {
      console.error(`no branch ${branch} — nothing to merge for ticket "${ticketId}"`);
      return 1;
    }
    const ticketsDir = path.join(ctx.repoRoot, ctx.config.ticketsDir);
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

    const wtPath = path.join(worktreesDir(ctx.jfdiDir), ticketId);
    const report = await loadReport(ctx.jfdiDir, ticketId);
    const outcome = await integrateTicket(ctx, ticket, { path: wtPath, branch }, report);
    if (outcome.status === "blocked") {
      console.error(`Integration blocked: ${outcome.reason}`);
      return 2;
    }
    console.log(
      outcome.status === "already-merged"
        ? "Branch was already contained in the target — closed without merging."
        : `Merged into ${ctx.config.integration.target_branch}.`,
    );
    return 0;
  } finally {
    detach();
    await ctx.log.flush();
  }
}
