import { loadState } from "../events.js";
import { buildContext } from "./context.js";

/** `jfdi status` — snapshot of state.json for scripts and quick checks. */
export async function statusCommand(opts: { json?: boolean } = {}): Promise<number> {
  const ctx = await buildContext();
  const state = await loadState(ctx.jfdiDir);
  if (opts.json) {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  const tickets = Object.values(state.tickets);
  if (tickets.length === 0) {
    console.log("no tickets tracked yet");
    return 0;
  }
  console.log(`updated: ${state.updatedAt || "never"}\n`);
  for (const t of tickets) {
    const stage = t.stage ? ` · ${t.stage}` : "";
    const round = t.round > 0 ? ` (round ${t.round})` : "";
    console.log(`  ${t.id}  [${t.status}${stage}${round}]  ${t.lastActivity}`);
  }
  if (state.integrationQueue.length > 0)
    console.log(`\nintegration queue: ${state.integrationQueue.join(" → ")}`);
  return 0;
}
