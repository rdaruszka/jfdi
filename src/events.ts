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

/** Pure reducer: state.json is always rebuildable by folding events.jsonl. */
export function reduceEvent(state: CoordinatorState, evt: JfdiEvent): CoordinatorState {
  const next: CoordinatorState = {
    updatedAt: evt.ts,
    tickets: { ...state.tickets },
    integrationQueue: [...state.integrationQueue],
  };
  const id = evt.ticketId;
  const ticket = (): TicketState => {
    const existing = next.tickets[id as string];
    if (existing) return existing;
    const fresh: TicketState = {
      id: id as string,
      title: id as string,
      status: "running",
      stage: null,
      round: 0,
      branch: "",
      lastActivity: "",
      lastEventTs: evt.ts,
    };
    next.tickets[id as string] = fresh;
    return fresh;
  };

  if (id) {
    const t = { ...ticket(), lastEventTs: evt.ts };
    next.tickets[id] = t;
    switch (evt.type) {
      case "dispatch":
        t.status = "running";
        t.title = (evt.data?.title as string) ?? id;
        t.branch = (evt.data?.branch as string) ?? "";
        t.lastActivity = "dispatched";
        break;
      case "round_start":
        t.round = (evt.data?.round as number) ?? t.round + 1;
        t.lastActivity = `round ${t.round}`;
        break;
      case "stage_start":
        t.stage = (evt.data?.stage as StageName) ?? t.stage;
        t.lastActivity = `${t.stage} running`;
        break;
      case "stage_end":
        t.lastActivity = `${(evt.data?.stage as string) ?? t.stage}: ${(evt.data?.verdict as string) ?? "done"}`;
        break;
      case "gate_start":
        t.lastActivity = "gate running";
        break;
      case "gate_result":
        t.lastActivity = evt.data?.ok ? "gate passed" : `gate failed (${evt.data?.step ?? "?"})`;
        break;
      case "session_activity":
        t.lastActivity = (evt.data?.text as string) ?? t.lastActivity;
        break;
      case "escalation":
        t.lastActivity = "escalated";
        break;
      case "blocked":
        t.status = "blocked";
        t.stage = null;
        t.lastActivity = (evt.data?.reason as string) ?? "blocked";
        next.integrationQueue = next.integrationQueue.filter((q) => q !== id);
        break;
      case "merge_queued":
        t.status = "merge-queued";
        t.stage = null;
        if (!next.integrationQueue.includes(id)) next.integrationQueue.push(id);
        break;
      case "merge_start":
        t.status = "merging";
        t.stage = "integration";
        next.integrationQueue = next.integrationQueue.filter((q) => q !== id);
        break;
      case "complicated_merge":
        t.lastActivity = "complicated merge — back to QA";
        t.status = "running";
        break;
      case "merge_ready":
        t.status = "merge-ready";
        t.stage = null;
        t.lastActivity = "awaiting approval";
        break;
      case "merged":
        t.status = "done";
        t.stage = null;
        t.lastActivity = "merged";
        break;
      case "done":
        t.status = "done";
        t.stage = null;
        break;
      case "failed":
        t.status = "failed";
        t.stage = null;
        t.lastActivity = (evt.data?.reason as string) ?? "failed";
        next.integrationQueue = next.integrationQueue.filter((q) => q !== id);
        break;
      default:
        break;
    }
  }
  return next;
}

/**
 * Append-only event log + derived state snapshot. The TUI (and any future
 * renderer) consumes this stream; nothing renders from pipeline internals.
 */
export class EventLog {
  private emitter = new EventEmitter();
  private state: CoordinatorState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly jfdiDir: string,
    private readonly persist: boolean = true,
  ) {}

  get eventsPath(): string {
    return path.join(this.jfdiDir, "events.jsonl");
  }
  get statePath(): string {
    return path.join(this.jfdiDir, "state.json");
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
        await ensureDir(this.jfdiDir);
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
  static async rebuild(jfdiDir: string): Promise<CoordinatorState> {
    const content = await readIfExists(path.join(jfdiDir, "events.jsonl"));
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
export async function loadState(jfdiDir: string): Promise<CoordinatorState> {
  const content = await readIfExists(path.join(jfdiDir, "state.json"));
  if (content === null) return EventLog.rebuild(jfdiDir);
  return JSON.parse(content) as CoordinatorState;
}
