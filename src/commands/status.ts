import { loadState } from "../events.js";
import { formatRunningTotals } from "../usage.js";
import { buildContext } from "./context.js";

/** `jfdi status` — snapshot of state.json for scripts and quick checks. */
export async function statusCommand(options: { shouldEmitJson?: boolean } = {}): Promise<number> {
  const context = await buildContext();
  const state = await loadState(context.stateDirectory);
  if (options.shouldEmitJson) {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  const tickets = Object.values(state.tickets);
  if (tickets.length === 0) {
    console.log("no tickets tracked yet");
    return 0;
  }
  console.log(`updated: ${state.updatedAt || "never"}\n`);
  for (const ticket of tickets) {
    const stage = ticket.stage ? ` · ${ticket.stage}` : "";
    const round = ticket.round > 0 ? ` (round ${ticket.round})` : "";
    const cost =
      ticket.totalAgentMs > 0
        ? ` · ${formatRunningTotals(ticket.totalCostUsd, ticket.totalAgentMs, ticket.totalTokens)}`
        : "";
    console.log(
      `  ${ticket.id}  [${ticket.status}${stage}${round}]  ${ticket.lastActivity}${cost}`,
    );
  }
  if (state.integrationQueue.length > 0)
    console.log(`\nintegration queue: ${state.integrationQueue.join(" → ")}`);
  return 0;
}
