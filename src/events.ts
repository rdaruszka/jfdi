import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite, ensureDir, readIfExists } from "./util/fsx.js";

export type StageName = "implementation" | "code-review" | "qa" | "integration";

export type EventType =
  | "dispatch"
  | "resumed"
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

/** Longest excerpt of a rejected line quoted back in an error. */
const MAX_BAD_LINE_CHARS = 200;

/**
 * Every `StageName`, as a runtime lookup. Keyed by the union rather than
 * listed as an array so the compiler enforces the pairing: adding a stage
 * without adding it here fails the build, instead of silently making
 * `stageField` reject it.
 */
const STAGE_NAMES: Record<StageName, true> = {
  implementation: true,
  "code-review": true,
  qa: true,
  integration: true,
};

// An event's `data` is untyped by design (each event type carries its own
// shape) and reaches us re-parsed from events.jsonl, so every field read out
// of it is checked rather than cast.
function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key];
  return typeof value === "number" ? value : undefined;
}

function stageField(data: Record<string, unknown> | undefined): StageName | undefined {
  const value = data?.stage;
  // `hasOwn`, not `in`: `in` walks the prototype chain, so a corrupt event
  // carrying stage "toString" would pass.
  return typeof value === "string" && Object.hasOwn(STAGE_NAMES, value)
    ? (value as StageName)
    : undefined;
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
 * The activity line for events that only narrate — they move no status, stage
 * or queue. Kept apart from the transitions so the wording lives in one place.
 */
function narrate(event: JfdiEvent, ticket: TicketState): string {
  switch (event.type) {
    case "resumed":
      return `resuming ${numberField(event.data, "commitCount") ?? 0} commits of prior work`;
    case "stage_start":
      return `${ticket.stage} running`;
    case "stage_end":
      return `${stringField(event.data, "stage") ?? ticket.stage}: ${stringField(event.data, "verdict") ?? "done"}`;
    case "gate_start":
      return "gate running";
    case "gate_result":
      return event.data?.ok ? "gate passed" : `gate failed (${event.data?.step ?? "?"})`;
    case "session_activity":
      return stringField(event.data, "text") ?? ticket.lastActivity;
    case "escalation":
      return "escalated";
    // The rest never reach here: applyTicketEvent writes their activity line
    // itself, or they have none. Enumerated rather than left to a `default`,
    // for the same reason as the tail of applyTicketEvent — a `default` clause
    // silences useExhaustiveSwitchCases, so a new EventType grouped with the
    // narrating cases above would quietly re-emit the previous line instead of
    // getting a wording decision. With no `default`, tsc (TS2366) agrees.
    case "dispatch":
    case "round_start":
    case "blocked":
    case "merge_queued":
    case "merge_start":
    case "complicated_merge":
    case "merged":
    case "merge_ready":
    case "card_moved":
    case "observation":
    case "done":
    case "failed":
    case "error":
      return ticket.lastActivity;
  }
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
  event: JfdiEvent,
): void {
  switch (event.type) {
    case "dispatch":
      ticket.status = "running";
      ticket.title = stringField(event.data, "title") ?? id;
      ticket.branch = stringField(event.data, "branch") ?? "";
      ticket.lastActivity = "dispatched";
      break;
    case "round_start":
      ticket.round = numberField(event.data, "round") ?? ticket.round + 1;
      ticket.lastActivity = `round ${ticket.round}`;
      break;
    case "stage_start":
      ticket.stage = stageField(event.data) ?? ticket.stage;
      ticket.lastActivity = narrate(event, ticket);
      break;
    // Narration only — see narrate() for what each one says.
    case "resumed":
    case "stage_end":
    case "gate_start":
    case "gate_result":
    case "session_activity":
    case "escalation":
      ticket.lastActivity = narrate(event, ticket);
      break;
    case "blocked":
      ticket.status = "blocked";
      ticket.stage = null;
      ticket.lastActivity = stringField(event.data, "reason") ?? "blocked";
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
      ticket.lastActivity = stringField(event.data, "reason") ?? "failed";
      next.integrationQueue = next.integrationQueue.filter((queued) => queued !== id);
      break;
    // These three carry no ticket-state transition. Named rather than left to
    // a `default`, so useExhaustiveSwitchCases fails the gate when a new
    // EventType is added without deciding how it folds into ticket state.
    case "card_moved":
    case "observation":
    case "error":
      break;
  }
}

/** Pure reducer: state.json is always rebuildable by folding events.jsonl. */
export function reduceEvent(state: CoordinatorState, event: JfdiEvent): CoordinatorState {
  const next: CoordinatorState = {
    updatedAt: event.ts,
    tickets: { ...state.tickets },
    integrationQueue: [...state.integrationQueue],
  };
  const id = event.ticketId;
  if (!id) return next;
  const ticket: TicketState = {
    ...(next.tickets[id] ?? newTicketState(id, event.ts)),
    lastEventTs: event.ts,
  };
  next.tickets[id] = ticket;
  applyTicketEvent(next, ticket, id, event);
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
    private readonly shouldPersist: boolean = true,
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

  on(listener: (event: JfdiEvent, state: CoordinatorState) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  emit(type: EventType, ticketId?: string, data?: Record<string, unknown>): JfdiEvent {
    const event: JfdiEvent = {
      ts: new Date().toISOString(),
      type,
      ...(ticketId !== undefined ? { ticketId } : {}),
      ...(data !== undefined ? { data } : {}),
    };
    this.state = reduceEvent(this.state, event);
    if (this.shouldPersist) {
      const snapshot = this.state;
      this.writeChain = this.writeChain.then(async () => {
        await ensureDir(this.stateDir);
        await fs.appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
        await atomicWrite(this.statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      });
    }
    this.emitter.emit("event", event, this.state);
    return event;
  }

  /** Wait for pending disk writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Rebuild state purely from events.jsonl. */
  static async rebuild(stateDir: string): Promise<CoordinatorState> {
    const eventsPath = path.join(stateDir, "events.jsonl");
    const content = await readIfExists(eventsPath);
    let state = emptyState();
    if (content === null) return state;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (!isJfdiEvent(parsed))
        throw new Error(
          `${eventsPath} contains a line that is not a JFDI event: ${line.slice(0, MAX_BAD_LINE_CHARS)}`,
        );
      state = reduceEvent(state, parsed);
    }
    return state;
  }
}

// events.jsonl and state.json are files on disk: another process, a crashed
// write, or a hand edit can leave anything there. Both are checked before the
// rest of the program is allowed to believe their types.
function isJfdiEvent(value: unknown): value is JfdiEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.ts === "string" && typeof record.type === "string";
}

function isCoordinatorState(value: unknown): value is CoordinatorState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.updatedAt === "string" &&
    typeof record.tickets === "object" &&
    record.tickets !== null &&
    Array.isArray(record.integrationQueue)
  );
}

/** Load the current snapshot from disk (jfdi status). */
export async function loadState(stateDir: string): Promise<CoordinatorState> {
  const statePath = path.join(stateDir, "state.json");
  const content = await readIfExists(statePath);
  if (content === null) return EventLog.rebuild(stateDir);
  const parsed: unknown = JSON.parse(content);
  if (!isCoordinatorState(parsed))
    throw new Error(
      `${statePath} is not a coordinator snapshot — delete it to rebuild from events.jsonl`,
    );
  return parsed;
}
