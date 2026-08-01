import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, loadState } from "./events.js";

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

  it("tracks the integration queue through merge lifecycle", async () => {
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
    const off = log.on((evt) => seen.push(evt.type));
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

  it("loadState falls back to rebuild when state.json is missing", async () => {
    const log = new EventLog(dir);
    log.emit("dispatch", "z", { title: "Z" });
    await log.flush();
    await fs.rm(path.join(dir, "state.json"));
    const state = await loadState(dir);
    expect(state.tickets.z).toBeDefined();
  });
});
