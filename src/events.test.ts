import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, loadState, mergedTicketIds } from "./events.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-events-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("EventLog", () => {
  it("appends jsonl and maintains a state snapshot", async () => {
    const log = new EventLog(dir);
    log.emit("dispatch", "t1", { title: "Ticket One", branch: "jfdi/t1" });
    log.emit("round_start", "t1", { round: 1 });
    log.emit("stage_start", "t1", { stage: "implementation" });
    await log.flush();

    const lines = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    const state = log.snapshot();
    expect(state.tickets.t1?.stage).toBe("implementation");
    expect(state.tickets.t1?.round).toBe(1);
    expect(state.tickets.t1?.branch).toBe("jfdi/t1");
  });

  it("tracks the integration queue through merge lifecycle", () => {
    const log = new EventLog(dir, false);
    log.emit("dispatch", "a", { title: "A" });
    log.emit("dispatch", "b", { title: "B" });
    log.emit("merge_queued", "a");
    log.emit("merge_queued", "b");
    expect(log.snapshot().integrationQueue).toEqual(["a", "b"]);
    log.emit("merge_start", "a");
    expect(log.snapshot().integrationQueue).toEqual(["b"]);
    expect(log.snapshot().tickets.a?.status).toBe("merging");
    log.emit("merged", "a");
    expect(log.snapshot().tickets.a?.status).toBe("done");
  });

  it("shows a resumed ticket's prior work in the activity line", () => {
    const log = new EventLog(dir, false);
    log.emit("dispatch", "t1", { title: "Ticket One" });
    log.emit("resumed", "t1", { commitCount: 4, hasCheckpointedChanges: true });
    const ticket = log.snapshot().tickets.t1;
    expect(ticket?.lastActivity).toBe("resuming 4 commits of prior work");
    expect(ticket?.status).toBe("running");
  });

  it("blocked removes from queue and sets status", () => {
    const log = new EventLog(dir, false);
    log.emit("merge_queued", "x");
    log.emit("blocked", "x", { reason: "escalated: which db?" });
    expect(log.snapshot().integrationQueue).toEqual([]);
    expect(log.snapshot().tickets.x?.status).toBe("blocked");
  });

  it("notifies in-process listeners (renderer contract)", () => {
    const log = new EventLog(dir, false);
    const seen: string[] = [];
    const off = log.on((event) => seen.push(event.type));
    log.emit("dispatch", "t");
    off();
    log.emit("merged", "t");
    expect(seen).toEqual(["dispatch"]);
  });

  it("state is rebuildable purely from events.jsonl", async () => {
    const log = new EventLog(dir);
    log.emit("dispatch", "t1", { title: "T1", branch: "jfdi/t1" });
    log.emit("merge_queued", "t1");
    await log.flush();
    // Delete the snapshot; rebuild must reproduce it.
    await fs.rm(path.join(dir, "state.json"));
    const rebuilt = await EventLog.rebuild(dir);
    expect(rebuilt.tickets.t1?.status).toBe("merge-queued");
    expect(rebuilt.integrationQueue).toEqual(["t1"]);
  });

  it("folds in another process's events and skips its own", async () => {
    const log = new EventLog(dir);
    log.emit("dispatch", "t1", { title: "T1" });
    await log.followFromEnd();
    log.emit("merge_ready", "t1");
    // A second process — `jfdi merge` in another terminal — on the same stream.
    const other = new EventLog(dir);
    other.emit("merged", "t1");
    await Promise.all([log.flush(), other.flush()]);

    const seen: string[] = [];
    log.on((event) => seen.push(event.type));
    const foreign = await log.pullForeignEvents();

    expect(foreign.map((event) => event.type)).toEqual(["merged"]);
    expect(seen).toEqual(["merged"]);
    expect(log.snapshot().tickets.t1?.status).toBe("done");
  });

  it("does not re-fold its own events on a second pull", async () => {
    const log = new EventLog(dir);
    await log.followFromEnd();
    log.emit("round_start", "r1");
    log.emit("round_start", "r1");
    await log.flush();

    expect(await log.pullForeignEvents()).toEqual([]);
    // Two rounds emitted, two rounds counted — the tail added nothing.
    expect(log.snapshot().tickets.r1?.round).toBe(2);
  });

  it("keeps following past a line that is not an event", async () => {
    const log = new EventLog(dir, false);
    await log.followFromEnd();
    const other = new EventLog(dir);
    other.emit("dispatch", "t1", { title: "T1" });
    await other.flush();
    await fs.appendFile(path.join(dir, "events.jsonl"), "not json at all\n", "utf8");
    other.emit("merged", "t1");
    await other.flush();

    const foreign = await log.pullForeignEvents();
    expect(foreign.map((event) => event.type)).toEqual(["dispatch", "merged"]);
    expect(log.snapshot().tickets.t1?.status).toBe("done");
  });

  it("leaves a half-written trailing line for the next pull", async () => {
    const log = new EventLog(dir, false);
    await log.followFromEnd();
    const complete = JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", type: "dispatch" });
    const partial = `{"ts":"2020-01-01T00:00:01.000Z","type":"mer`;
    const eventsPath = path.join(dir, "events.jsonl");
    await fs.writeFile(eventsPath, `${complete}\n${partial}`, "utf8");
    expect(await log.pullForeignEvents()).toHaveLength(1);

    await fs.appendFile(eventsPath, `ged","ticketId":"t1"}\n`, "utf8");
    const rest = await log.pullForeignEvents();
    expect(rest.map((event) => event.type)).toEqual(["merged"]);
  });

  it("mergedTicketIds reports every ticket with a merge on record", async () => {
    const log = new EventLog(dir);
    log.emit("dispatch", "a");
    log.emit("merged", "a");
    log.emit("merge_ready", "b");
    await log.flush();
    expect([...(await mergedTicketIds(dir))]).toEqual(["a"]);
  });

  it("loadState falls back to rebuild when state.json is missing", async () => {
    const log = new EventLog(dir);
    log.emit("dispatch", "z", { title: "Z" });
    await log.flush();
    await fs.rm(path.join(dir, "state.json"));
    const state = await loadState(dir);
    expect(state.tickets.z).toBeDefined();
  });
});
