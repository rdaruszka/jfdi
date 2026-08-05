import { randomUUID } from "node:crypto";
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
  /** A ticket note's `blocks`/`blocked-by` link names no note in ticketsDir. */
  | "unresolved_link"
  /** A begin-column card is held back: its ticket's blocked-by tickets are not yet done. */
  | "blocked_by"
  /** A held-back card's blockers all reached done; it is free to dispatch. */
  | "unblocked"
  | "blocked"
  | "merge_queued"
  | "merge_start"
  | "complicated_merge"
  | "merged"
  | "merge_ready"
  | "card_moved"
  | "observation"
  | "session_activity"
  /** Tool-wide: the provider under the harness is down; no session may run. */
  | "harness_paused"
  | "harness_resumed"
  | "done"
  | "failed"
  | "error";

export interface JfdiEvent {
  ts: string;
  type: EventType;
  ticketId?: string;
  /**
   * Which `EventLog` instance appended this line. Several processes share one
   * events.jsonl (`jfdi start` while `jfdi merge` runs in another terminal), so
   * a log tailing the file needs to tell its own lines from theirs.
   */
  origin?: string;
  data?: Record<string, unknown>;
}

export type TicketStatus =
  | "running"
  /** Held at dispatch for unresolved blocked-by tickets; never ran this run. */
  | "waiting"
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
  /**
   * Running cost/time for this run, set (never accumulated) from the cumulative
   * an event carries — the stream re-folds across processes, so a `+=` here would
   * double-count. Null cost means a session so far had no known price.
   */
  totalCostUsd: number | null;
  totalAgentMs: number;
  totalTokens: number;
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
 * Most events.jsonl bytes one tail pull reads. The rest waits for the next
 * pull, so a log that grew hugely between polls is read in bounded chunks
 * rather than allocated whole.
 */
const MAX_TAIL_READ_BYTES = 1_048_576;

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

function stringArrayField(data: Record<string, unknown> | undefined, key: string): string[] {
  const value = data?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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
    totalCostUsd: 0,
    totalAgentMs: 0,
    totalTokens: 0,
  };
}

/**
 * Set a ticket's running totals from the run-cumulative an event carries.
 * Idempotent by construction: a re-folded event writes the same values, never
 * adds to them. Does nothing for an event without the cumulative (`runAgentMs`
 * gates it), so narration-only stage_ends and pre-feature streams leave totals be.
 */
function applyRunTotals(ticket: TicketState, data: Record<string, unknown> | undefined): void {
  const runAgentMs = numberField(data, "runAgentMs");
  if (runAgentMs === undefined) return;
  ticket.totalAgentMs = runAgentMs;
  ticket.totalTokens = numberField(data, "runTokens") ?? ticket.totalTokens;
  // costUsd rides as a number when known and null when a session was unpriced;
  // `numberField` yields undefined for the null, which we read as "unknown".
  ticket.totalCostUsd = numberField(data, "runCostUsd") ?? null;
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
    case "unresolved_link":
      return `unresolved ${stringField(event.data, "kind") ?? "ticket"} link [[${stringField(event.data, "target") ?? "?"}]]`;
    // The rest never reach here: applyTicketEvent writes their activity line
    // itself, or they have none. Enumerated rather than left to a `default`,
    // for the same reason as the tail of applyTicketEvent — a `default` clause
    // silences useExhaustiveSwitchCases, so a new EventType grouped with the
    // narrating cases above would quietly re-emit the previous line instead of
    // getting a wording decision. With no `default`, tsc (TS2366) agrees.
    case "dispatch":
    case "round_start":
    case "blocked_by":
    case "unblocked":
    case "blocked":
    case "merge_queued":
    case "merge_start":
    case "complicated_merge":
    case "merged":
    case "merge_ready":
    case "card_moved":
    case "observation":
    case "harness_paused":
    case "harness_resumed":
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
    case "stage_end":
      // Narration, plus the running cost/time the stage_end carries.
      applyRunTotals(ticket, event.data);
      ticket.lastActivity = narrate(event, ticket);
      break;
    // Narration only — see narrate() for what each one says.
    case "resumed":
    case "gate_start":
    case "gate_result":
    case "session_activity":
    case "escalation":
    case "unresolved_link":
      ticket.lastActivity = narrate(event, ticket);
      break;
    case "blocked_by": {
      ticket.status = "waiting";
      ticket.stage = null;
      const blockers = stringArrayField(event.data, "blockers");
      ticket.lastActivity =
        blockers.length > 0 ? `waiting on ${blockers.join(", ")}` : "waiting on blockers";
      break;
    }
    case "unblocked":
      ticket.lastActivity = "blockers resolved";
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
      // The complete run total, including the final commit's scribe — the last
      // stage_end fired before that scribe ran, so this closes the gap.
      applyRunTotals(ticket, event.data);
      break;
    case "merged":
      ticket.status = "done";
      ticket.stage = null;
      ticket.lastActivity = "merged";
      break;
    case "done":
      ticket.status = "done";
      ticket.stage = null;
      ticket.lastActivity = "done";
      break;
    case "failed":
      ticket.status = "failed";
      ticket.stage = null;
      ticket.lastActivity = stringField(event.data, "reason") ?? "failed";
      next.integrationQueue = next.integrationQueue.filter((queued) => queued !== id);
      break;
    // These carry no ticket-state transition. Named rather than left to a
    // `default`, so useExhaustiveSwitchCases fails the gate when a new
    // EventType is added without deciding how it folds into ticket state.
    // The two harness events are tool-wide and carry no ticket id at all: a
    // pause says nothing about any one ticket's status, only that every
    // ticket's next session is waiting.
    case "card_moved":
    case "observation":
    case "harness_paused":
    case "harness_resumed":
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
  /** Stamped on every emitted event so `pullForeignEvents` can skip our own. */
  readonly origin = randomUUID();
  private tailOffsetBytes = 0;

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
      origin: this.origin,
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

  /** Wait for pending disk writes, including durability barriers before cross-process effects. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Begin following events.jsonl at its current end: everything already on
   * disk belongs to earlier runs and stays out of this instance's state.
   */
  async followFromEnd(): Promise<void> {
    await this.flush();
    this.tailOffsetBytes = await fileSizeBytes(this.eventsPath);
  }

  /**
   * Fold one event that is already on disk into this instance's state and
   * notify listeners, without appending: re-emitting it would tell the same
   * story twice on the shared stream. `followFromEnd` deliberately skips
   * history; this is the targeted exception for a recorded fact a scan is
   * acting on — a ticket whose merge is on record but whose card is still
   * open. Reducing is idempotent, so folding an event the state already
   * carries changes nothing.
   */
  foldRecorded(event: JfdiEvent): void {
    this.state = reduceEvent(this.state, event);
    this.emitter.emit("event", event, this.state);
  }

  /**
   * Fold in the events another process appended since the last pull and
   * notify listeners, so a running renderer converges on work done elsewhere
   * (a `jfdi merge` in a second terminal). Lines we wrote ourselves are
   * skipped by origin — they are already in this instance's state.
   */
  async pullForeignEvents(): Promise<JfdiEvent[]> {
    const appended = await readAppendedLines(this.eventsPath, this.tailOffsetBytes);
    this.tailOffsetBytes = appended.nextOffsetBytes;
    const foreign: JfdiEvent[] = [];
    for (const line of appended.lines) {
      const event = parseEventLine(line);
      if (event === null) {
        this.emit("error", undefined, {
          message: `ignored a line in ${this.eventsPath} that is not a JFDI event: ${line.slice(0, MAX_BAD_LINE_CHARS)}`,
        });
        continue;
      }
      if (event.origin === this.origin) continue;
      this.state = reduceEvent(this.state, event);
      this.emitter.emit("event", event, this.state);
      foreign.push(event);
    }
    return foreign;
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

/**
 * A ticket's integration story as the shared stream last told it: `merged`
 * carries the recorded event — evidence of a merge that outlives the branch,
 * since `jfdi merge` deletes the branch as its last step and a human tidying
 * up after a hand-merge does the same. `in-flight` means a `merge_start` has
 * no `merged` or `blocked` after it: some process is mid-integration (or died
 * there, in which case rerunning `jfdi merge` finishes the story).
 */
export type IntegrationRecord = { phase: "in-flight" } | { phase: "merged"; event: JfdiEvent };

/**
 * Each ticket's integration record, last event wins. This is how the
 * coordinator's sweep distinguishes a merge finished long ago from one another
 * process is performing right now — the stream is the only ordering the two
 * processes share.
 *
 * A line this cannot read is skipped, not fatal — it is answered during the
 * coordinator's board scan, where refusing the whole stream would stop
 * dispatch too. Rebuilding the snapshot stays strict; see `rebuild`.
 */
export async function integrationRecords(
  stateDir: string,
): Promise<Map<string, IntegrationRecord>> {
  const content = await readIfExists(path.join(stateDir, "events.jsonl"));
  const records = new Map<string, IntegrationRecord>();
  if (content === null) return records;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const event = parseEventLine(line);
    if (!event?.ticketId) continue;
    if (event.type === "merge_start") records.set(event.ticketId, { phase: "in-flight" });
    else if (event.type === "merged") records.set(event.ticketId, { phase: "merged", event });
    else if (event.type === "blocked") records.delete(event.ticketId);
  }
  return records;
}

/**
 * A live tail reads a file other processes are appending to, so it meets
 * shapes the offline reader never does: a half-written line, or a hand edit.
 * Returning null lets the caller report the line and keep following, where
 * `rebuild` refuses the whole stream.
 */
function parseEventLine(line: string): JfdiEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isJfdiEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fileSizeBytes(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    // Nothing written yet — following from byte zero is following from the end.
    return 0;
  }
}

/**
 * Whole lines appended to `filePath` after `offsetBytes`. A trailing partial
 * line — another process caught mid-append — is left for the next call, and a
 * file that shrank (truncated or replaced) resyncs to its new end.
 */
async function readAppendedLines(
  filePath: string,
  offsetBytes: number,
): Promise<{ lines: string[]; nextOffsetBytes: number }> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    // No log on disk: by definition nothing has been appended to it.
    return { lines: [], nextOffsetBytes: offsetBytes };
  }
  try {
    const { size } = await handle.stat();
    if (size <= offsetBytes) return { lines: [], nextOffsetBytes: Math.min(size, offsetBytes) };
    const buffer = Buffer.alloc(Math.min(size - offsetBytes, MAX_TAIL_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offsetBytes);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak === -1) {
      // A hand edit or external writer can leave a line at least as long as a
      // full chunk. Step over it so the tail advances instead of retrying the
      // same bytes forever; any remainder surfaces as an unreadable line.
      const isChunkFull = buffer.length === MAX_TAIL_READ_BYTES;
      return {
        lines: [],
        nextOffsetBytes: isChunkFull ? offsetBytes + buffer.length : offsetBytes,
      };
    }
    const complete = text.slice(0, lastBreak + 1);
    return {
      lines: complete.split("\n").filter((line) => line.trim() !== ""),
      nextOffsetBytes: offsetBytes + Buffer.byteLength(complete, "utf8"),
    };
  } finally {
    await handle.close();
  }
}

// events.jsonl and state.json are files on disk: another process, a crashed
// write, or a hand edit can leave anything there. Both are checked before the
// rest of the program is allowed to believe their types.
function isJfdiEvent(value: unknown): value is JfdiEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === "string" &&
    typeof record.type === "string" &&
    (record.origin === undefined || typeof record.origin === "string")
  );
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
