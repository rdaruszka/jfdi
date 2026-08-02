import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite, ensureDir, readIfExists } from "./util/fsx.js";

export type StageName = "implementation" | "code-review" | "qa" | "integration";

export type EventType =
  | "dispatch"
  | "stage_start"
  | "stage_end"
  | "gate_start"
  | "gate_result"
  | "round_start"
  | "escalation"
  | "blocked"
  | "merge_queued"
  | "merge_start"
  | "complicated_merge"
  | "merged"
  | "merge_ready"
  | "card_moved"
  | "observation"
  | "session_activity"
  | "done"
  | "failed"
  | "error";

export interface JfdiEvent {
  ts: string;
  type: EventType;
  ticketId?: string;
  data?: Record<string, unknown>;
}

export type TicketStatus =
  | "running"
  | "blocked"
  | "merge-queued"
  | "merging"
  | "merge-ready"
  | "done"
  | "failed";

export interface TicketState {
  id: string;
  title: string;
  status: TicketStatus;
  stage: StageName | null;
  round: number;
  branch: string;
  lastActivity: string;
  lastEventTs: string;
}

export interface CoordinatorState {
  updatedAt: string;
  tickets: Record<string, TicketState>;
  integrationQueue: string[];
}

export function emptyState(): CoordinatorState {
  return { updatedAt: "", tickets: {}, integrationQueue: [] };
}

function newTicketState(id: string, ts: string): TicketState {
  return {
    id,
    title: id,
    status: "running",
    stage: null,
    round: 0,
    branch: "",
    lastActivity: "",
    lastEventTs: ts,
  };
}

/**
 * Apply one ticket-scoped event. `ticket` is this reduction's private copy —
 * already installed in `next.tickets` — so mutating it here mutates nothing
 * the caller shared with us.
 */
function applyTicketEvent(
  next: CoordinatorState,
  ticket: TicketState,
  id: string,
  evt: JfdiEvent,
): void {
  switch (evt.type) {
    case "dispatch":
      ticket.status = "running";
      ticket.title = (evt.data?.title as string) ?? id;
      ticket.branch = (evt.data?.branch as string) ?? "";
      ticket.lastActivity = "dispatched";
      break;
    case "round_start":
      ticket.round = (evt.data?.round as number) ?? ticket.round + 1;
      ticket.lastActivity = `round ${ticket.round}`;
      break;
    case "stage_start":
      ticket.stage = (evt.data?.stage as StageName) ?? ticket.stage;
      ticket.lastActivity = `${ticket.stage} running`;
      break;
    case "stage_end":
      ticket.lastActivity = `${(evt.data?.stage as string) ?? ticket.stage}: ${(evt.data?.verdict as string) ?? "done"}`;
      break;
    case "gate_start":
      ticket.lastActivity = "gate running";
      break;
    case "gate_result":
      ticket.lastActivity = evt.data?.ok ? "gate passed" : `gate failed (${evt.data?.step ?? "?"})`;
      break;
    case "session_activity":
      ticket.lastActivity = (evt.data?.text as string) ?? ticket.lastActivity;
      break;
    case "escalation":
      ticket.lastActivity = "escalated";
      break;
    case "blocked":
      ticket.status = "blocked";
      ticket.stage = null;
      ticket.lastActivity = (evt.data?.reason as string) ?? "blocked";
      next.integrationQueue = next.integrationQueue.filter((queued) => queued !== id);
      break;
    case "merge_queued":
      ticket.status = "merge-queued";
      ticket.stage = null;
      if (!next.integrationQueue.includes(id)) next.integrationQueue.push(id);
      break;
    case "merge_start":
      ticket.status = "merging";
      ticket.stage = "integration";
      next.integrationQueue = next.integrationQueue.filter((queued) => queued !== id);
      break;
    case "complicated_merge":
      ticket.lastActivity = "complicated merge — back to QA";
      ticket.status = "running";
      break;
    case "merge_ready":
      ticket.status = "merge-ready";
      ticket.stage = null;
      ticket.lastActivity = "awaiting approval";
      break;
    case "merged":
      ticket.status = "done";
      ticket.stage = null;
      ticket.lastActivity = "merged";
      break;
    case "done":
      ticket.status = "done";
      ticket.stage = null;
      break;
    case "failed":
      ticket.status = "failed";
      ticket.stage = null;
      ticket.lastActivity = (evt.data?.reason as string) ?? "failed";
      next.integrationQueue = next.integrationQueue.filter((queued) => queued !== id);
      break;
    // card_moved, observation and error carry no ticket-state transition.
    default:
      break;
  }
}

/** Pure reducer: state.json is always rebuildable by folding events.jsonl. */
export function reduceEvent(state: CoordinatorState, evt: JfdiEvent): CoordinatorState {
  const next: CoordinatorState = {
    updatedAt: evt.ts,
    tickets: { ...state.tickets },
    integrationQueue: [...state.integrationQueue],
  };
  const id = evt.ticketId;
  if (!id) return next;
  const ticket: TicketState = {
    ...(next.tickets[id] ?? newTicketState(id, evt.ts)),
    lastEventTs: evt.ts,
  };
  next.tickets[id] = ticket;
  applyTicketEvent(next, ticket, id, evt);
  return next;
}

/**
 * Append-only event log + derived state snapshot. The TUI (and any future
 * renderer) consumes this stream; nothing renders from pipeline internals.
 */
export class EventLog {
  private readonly emitter = new EventEmitter();
  private state: CoordinatorState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    private readonly persist: boolean = true,
  ) {}

  get eventsPath(): string {
    return path.join(this.stateDir, "events.jsonl");
  }
  get statePath(): string {
    return path.join(this.stateDir, "state.json");
  }

  snapshot(): CoordinatorState {
    return this.state;
  }

  on(listener: (evt: JfdiEvent, state: CoordinatorState) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  emit(type: EventType, ticketId?: string, data?: Record<string, unknown>): JfdiEvent {
    const evt: JfdiEvent = {
      ts: new Date().toISOString(),
      type,
      ...(ticketId !== undefined ? { ticketId } : {}),
      ...(data !== undefined ? { data } : {}),
    };
    this.state = reduceEvent(this.state, evt);
    if (this.persist) {
      const snapshot = this.state;
      this.writeChain = this.writeChain.then(async () => {
        await ensureDir(this.stateDir);
        await fs.appendFile(this.eventsPath, `${JSON.stringify(evt)}\n`, "utf8");
        await atomicWrite(this.statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      });
    }
    this.emitter.emit("event", evt, this.state);
    return evt;
  }

  /** Wait for pending disk writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Rebuild state purely from events.jsonl. */
  static async rebuild(stateDir: string): Promise<CoordinatorState> {
    const content = await readIfExists(path.join(stateDir, "events.jsonl"));
    let state = emptyState();
    if (content === null) return state;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      state = reduceEvent(state, JSON.parse(line) as JfdiEvent);
    }
    return state;
  }
}

/** Load the current snapshot from disk (jfdi status). */
export async function loadState(stateDir: string): Promise<CoordinatorState> {
  const content = await readIfExists(path.join(stateDir, "state.json"));
  if (content === null) return EventLog.rebuild(stateDir);
  return JSON.parse(content) as CoordinatorState;
}
