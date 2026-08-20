import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, integrationRecords, type JfdiEvent, loadState } from "./events.js";

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-events-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("EventLog", () => {
  it("appends jsonl and maintains a state snapshot", async () => {
    const log = new EventLog(directory);
    log.emit("dispatch", "t1", { title: "Ticket One", branch: "jfdi/t1" });
    log.emit("round_start", "t1", { round: 1 });
    log.emit("stage_start", "t1", { stage: "implementation" });
    await log.flush();

    const lines = (await fs.readFile(path.join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    const dispatch = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(dispatch)).toEqual(["ts", "type", "ticketId", "origin", "data"]);
    expect(Object.keys(dispatch.data as Record<string, unknown>)).toEqual(["title", "branch"]);
    const state = log.snapshot();
    expect(state.tickets.t1?.stage).toBe("implementation");
    expect(state.tickets.t1?.round).toBe(1);
    expect(state.tickets.t1?.branch).toBe("jfdi/t1");
  });

  it("tracks the integration queue through merge lifecycle", () => {
    const log = new EventLog(directory, false);
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

  it("sets running cost/time totals from a stage_end, idempotent under re-folding", () => {
    const log = new EventLog(directory, false);
    log.emit("dispatch", "t1", { title: "Ticket One" });
    // A stage_end carries the run's cumulative; the reducer sets, never adds.
    const stageEnd = {
      stage: "implementation",
      verdict: "done",
      runAgentMs: 120_000,
      runCostUsd: 9,
      runTokens: 1_000,
    };
    log.emit("stage_end", "t1", stageEnd);
    expect(log.snapshot().tickets.t1?.totalAgentMs).toBe(120_000);
    expect(log.snapshot().tickets.t1?.totalCostUsd).toBe(9);
    expect(log.snapshot().tickets.t1?.totalTokens).toBe(1_000);

    // Re-folding the same cumulative (as pullForeignEvents can) must not double it.
    log.emit("stage_end", "t1", stageEnd);
    expect(log.snapshot().tickets.t1?.totalAgentMs).toBe(120_000);
    expect(log.snapshot().tickets.t1?.totalCostUsd).toBe(9);

    // A later stage carries a higher cumulative; the total moves to it.
    log.emit("stage_end", "t1", {
      stage: "qa",
      verdict: "pass",
      runAgentMs: 200_000,
      runCostUsd: 13.5,
      runTokens: 5_000,
    });
    expect(log.snapshot().tickets.t1?.totalAgentMs).toBe(200_000);
    expect(log.snapshot().tickets.t1?.totalCostUsd).toBe(13.5);
  });

  it("reads an absent run cost as unknown, never as zero dollars", () => {
    const log = new EventLog(directory, false);
    log.emit("dispatch", "t1", { title: "Ticket One" });
    // runCostUsd null means a session had no known price — total cost is unknown.
    log.emit("stage_end", "t1", {
      stage: "qa",
      verdict: "pass",
      runAgentMs: 60_000,
      runCostUsd: null,
      runTokens: 2_000,
    });
    expect(log.snapshot().tickets.t1?.totalCostUsd).toBeNull();
    expect(log.snapshot().tickets.t1?.totalTokens).toBe(2_000);
  });

  it("shows a resumed ticket's prior work in the activity line", () => {
    const log = new EventLog(directory, false);
    log.emit("dispatch", "t1", { title: "Ticket One" });
    log.emit("resumed", "t1", { commitCount: 4, hasCheckpointedChanges: true });
    const ticket = log.snapshot().tickets.t1;
    expect(ticket?.lastActivity).toBe("resuming 4 commits of prior work");
    expect(ticket?.status).toBe("running");
  });

  it("names an unresolved ticket link in the activity line, without moving status", () => {
    const log = new EventLog(directory, false);
    log.emit("dispatch", "t1", { title: "Ticket One" });
    log.emit("unresolved_link", "t1", { kind: "blocked-by", target: "never-written" });
    const ticket = log.snapshot().tickets.t1;
    expect(ticket?.lastActivity).toBe("unresolved blocked-by link [[never-written]]");
    expect(ticket?.status).toBe("running");
  });

  it("blocked removes from queue and sets status", () => {
    const log = new EventLog(directory, false);
    log.emit("merge_queued", "x");
    log.emit("blocked", "x", { reason: "escalated: which db?" });
    expect(log.snapshot().integrationQueue).toEqual([]);
    expect(log.snapshot().tickets.x?.status).toBe("blocked");
  });

  it("blocked_by parks a held card in a waiting state naming its blockers", () => {
    const log = new EventLog(directory, false);
    log.emit("blocked_by", "held", { blockers: ["dep-a", "dep-b"], missing: ["dep-b"] });
    const ticket = log.snapshot().tickets.held;
    expect(ticket?.status).toBe("waiting");
    expect(ticket?.stage).toBeNull();
    expect(ticket?.lastActivity).toBe("waiting on dep-a, dep-b");
  });

  it("blocked_by tolerates a malformed blocker payload", () => {
    const log = new EventLog(directory, false);
    // The payload is untyped and re-parsed from disk: a non-array must not throw.
    log.emit("blocked_by", "held", { blockers: "not-an-array" });
    const ticket = log.snapshot().tickets.held;
    expect(ticket?.status).toBe("waiting");
    expect(ticket?.lastActivity).toBe("waiting on blockers");
  });

  it("unblocked narrates without unwinding the waiting status before dispatch", () => {
    const log = new EventLog(directory, false);
    log.emit("blocked_by", "held", { blockers: ["dep-a"] });
    log.emit("unblocked", "held");
    const ticket = log.snapshot().tickets.held;
    // Dispatch flips it to running next; until then it reads as freed, still waiting for a slot.
    expect(ticket?.status).toBe("waiting");
    expect(ticket?.lastActivity).toBe("blockers resolved");
  });

  it("notifies in-process listeners (renderer contract)", () => {
    const log = new EventLog(directory, false);
    const seen: string[] = [];
    const off = log.on((event) => seen.push(event.type));
    log.emit("dispatch", "t");
    off();
    log.emit("merged", "t");
    expect(seen).toEqual(["dispatch"]);
  });

  it("state is rebuildable purely from events.jsonl", async () => {
    const log = new EventLog(directory);
    log.emit("dispatch", "t1", { title: "T1", branch: "jfdi/t1" });
    log.emit("merge_queued", "t1");
    await log.flush();
    // Delete the snapshot; rebuild must reproduce it.
    await fs.rm(path.join(directory, "state.json"));
    const rebuilt = await EventLog.rebuild(directory);
    expect(rebuilt.tickets.t1?.status).toBe("merge-queued");
    expect(rebuilt.integrationQueue).toEqual(["t1"]);
  });

  it("folds in another process's events and skips its own", async () => {
    const log = new EventLog(directory);
    log.emit("dispatch", "t1", { title: "T1" });
    await log.followFromEnd();
    log.emit("merge_ready", "t1");
    // A second process — `jfdi merge` in another terminal — on the same stream.
    const other = new EventLog(directory);
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
    const log = new EventLog(directory);
    await log.followFromEnd();
    log.emit("round_start", "r1");
    log.emit("round_start", "r1");
    await log.flush();

    expect(await log.pullForeignEvents()).toEqual([]);
    // Two rounds emitted, two rounds counted — the tail added nothing.
    expect(log.snapshot().tickets.r1?.round).toBe(2);
  });

  it("keeps following past a line that is not an event", async () => {
    const log = new EventLog(directory, false);
    await log.followFromEnd();
    const other = new EventLog(directory);
    other.emit("dispatch", "t1", { title: "T1" });
    await other.flush();
    await fs.appendFile(path.join(directory, "events.jsonl"), "not json at all\n", "utf8");
    other.emit("merged", "t1");
    await other.flush();

    const foreign = await log.pullForeignEvents();
    expect(foreign.map((event) => event.type)).toEqual(["dispatch", "merged"]);
    expect(log.snapshot().tickets.t1?.status).toBe("done");
  });

  it("steps past an oversized line written outside JFDI", async () => {
    const log = new EventLog(directory, false);
    await log.followFromEnd();
    const oversizedLine = "x".repeat(1_048_576);
    const event = JSON.stringify({
      ts: "2020-01-01T00:00:00.000Z",
      type: "dispatch",
      ticketId: "t1",
    });
    await fs.writeFile(
      path.join(directory, "events.jsonl"),
      `${oversizedLine}\n${event}\n`,
      "utf8",
    );

    expect(await log.pullForeignEvents()).toEqual([]);
    expect((await log.pullForeignEvents()).map((foreignEvent) => foreignEvent.type)).toEqual([
      "dispatch",
    ]);
  });

  it("terminates on a line spanning several chunks and surfaces its remainder", async () => {
    const log = new EventLog(directory, false);
    await log.followFromEnd();
    const errors: string[] = [];
    log.on((event) => {
      if (event.type === "error") errors.push("error");
    });
    // Longer than one 1 MiB read chunk: the step-over must fire once per full
    // chunk until the newline is finally in range, then the remainder of the
    // bad line surfaces as an unreadable line before the valid event reads.
    const oversizedLine = "x".repeat(1_048_576 + 4096);
    const event = JSON.stringify({
      ts: "2020-01-01T00:00:00.000Z",
      type: "dispatch",
      ticketId: "t1",
    });
    await fs.writeFile(
      path.join(directory, "events.jsonl"),
      `${oversizedLine}\n${event}\n`,
      "utf8",
    );

    // First pull steps over a full chunk with no newline: nothing yet.
    expect(await log.pullForeignEvents()).toEqual([]);
    // Second pull reaches the newline: the bad remainder is reported as an
    // unreadable line, and the valid event that follows it is still read.
    expect((await log.pullForeignEvents()).map((foreignEvent) => foreignEvent.type)).toEqual([
      "dispatch",
    ]);
    expect(errors).toEqual(["error"]);
    expect(log.snapshot().tickets.t1?.status).toBe("running");
  });

  it("does not step over a long line still shorter than a full chunk", async () => {
    const log = new EventLog(directory, false);
    await log.followFromEnd();
    // A large but sub-chunk line with no newline yet is a mid-append partial,
    // not an oversized line: it must be left for the next pull, never skipped.
    const event = JSON.stringify({
      ts: "2020-01-01T00:00:00.000Z",
      type: "dispatch",
      ticketId: "t1",
      title: "a".repeat(700_000),
    });
    expect(Buffer.byteLength(event, "utf8")).toBeLessThan(1_048_576);
    const eventsPath = path.join(directory, "events.jsonl");
    await fs.writeFile(eventsPath, event, "utf8");
    // No trailing newline: the partial line is withheld, not stepped over.
    expect(await log.pullForeignEvents()).toEqual([]);

    await fs.appendFile(eventsPath, "\n", "utf8");
    // The newline arrives: the same bytes are read as one valid event.
    expect((await log.pullForeignEvents()).map((foreignEvent) => foreignEvent.type)).toEqual([
      "dispatch",
    ]);
  });

  it("leaves a half-written trailing line for the next pull", async () => {
    const log = new EventLog(directory, false);
    await log.followFromEnd();
    const complete = JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", type: "dispatch" });
    const partial = `{"ts":"2020-01-01T00:00:01.000Z","type":"mer`;
    const eventsPath = path.join(directory, "events.jsonl");
    await fs.writeFile(eventsPath, `${complete}\n${partial}`, "utf8");
    expect(await log.pullForeignEvents()).toHaveLength(1);

    await fs.appendFile(eventsPath, `ged","ticketId":"t1"}\n`, "utf8");
    const rest = await log.pullForeignEvents();
    expect(rest.map((event) => event.type)).toEqual(["merged"]);
  });

  it("integrationRecords tells a recorded merge from one still in flight", async () => {
    const log = new EventLog(directory);
    log.emit("dispatch", "a");
    log.emit("merge_start", "a");
    log.emit("merged", "a");
    log.emit("merge_start", "b");
    log.emit("merge_start", "c");
    log.emit("blocked", "c", { reason: "gate failed" });
    log.emit("merge_ready", "d");
    // A rerun of `jfdi merge` on a merged ticket opens the story again.
    log.emit("merged", "e");
    log.emit("merge_start", "e");
    await log.flush();
    // A corrupt line costs its own evidence, not the whole answer — the
    // coordinator's scan asks this question and cannot afford to abort.
    await fs.appendFile(path.join(directory, "events.jsonl"), "{ half a line\n", "utf8");
    const records = await integrationRecords(directory);
    expect(records.get("a")?.phase).toBe("merged");
    expect(records.get("b")?.phase).toBe("in-flight");
    expect(records.has("c")).toBe(false);
    expect(records.has("d")).toBe(false);
    expect(records.get("e")?.phase).toBe("in-flight");
  });

  it("foldRecorded updates state and listeners without appending", async () => {
    const log = new EventLog(directory);
    log.emit("dispatch", "a", { title: "A" });
    await log.flush();
    const eventsPath = path.join(directory, "events.jsonl");
    const sizeBefore = (await fs.stat(eventsPath)).size;

    const seen: JfdiEvent[] = [];
    log.on((event) => seen.push(event));
    log.foldRecorded({ ts: "2020-01-01T00:00:00.000Z", type: "merged", ticketId: "a" });

    expect(log.snapshot().tickets.a?.status).toBe("done");
    expect(seen.map((event) => event.type)).toEqual(["merged"]);
    await log.flush();
    expect((await fs.stat(eventsPath)).size).toBe(sizeBefore);
  });

  it("loadState falls back to rebuild when state.json is missing", async () => {
    const log = new EventLog(directory);
    log.emit("dispatch", "z", { title: "Z" });
    await log.flush();
    await fs.rm(path.join(directory, "state.json"));
    const state = await loadState(directory);
    expect(state.tickets.z).toBeDefined();
  });
});
