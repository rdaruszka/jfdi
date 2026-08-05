import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Coordinator } from "./coordinator.js";
import { EventLog } from "./events.js";
import { type Fixture, makeFixture } from "./test-helpers.js";
import { ticketIdFromCard } from "./util/ids.js";

// Regression cover for coordinator-test-determinism. The ticket's afterEach fix
// only helps if stop() genuinely releases the poll timer — otherwise a failed
// assertion still leaks a live timer into the rest of the suite. The seam that
// makes that observable: pollForeignEvents() folds another process's events
// into the snapshot, is driven ONLY by the poll timer, and (unlike a dispatch,
// which isStopped guards independently) fires regardless of isStopped. So a
// foreign event absorbed after stop() means the timer is still alive.

let fixture: Fixture;
let coordinators: Coordinator[];

const EMPTY_BOARD = `---

kanban-plugin: board

---

## Ready

## In Progress

## Done

`;

/** Short enough that a live poll timer fires many times inside NON_EVENT_WINDOW_MS. */
const FAST_POLL_MS = 20;
/** A leaked timer at FAST_POLL_MS would fire ~15× in this window; its silence is real. */
const NON_EVENT_WINDOW_MS = 300;

function boardPath(): string {
  return path.join(fixture.jfdiDir, "board.md");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Poll a condition to a fixed cap — never an unbounded wait. */
async function waitUntil(isSatisfied: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (isSatisfied()) return;
    await sleep(10);
  }
  throw new Error("condition never held");
}

/** Another process landing a merge on the shared stream — a foreign event only a poll picks up. */
async function emitForeignMerge(ticketId: string): Promise<void> {
  const merger = new EventLog(fixture.stateDir);
  merger.emit("merge_start", ticketId);
  merger.emit("merged", ticketId);
  await merger.flush();
}

async function startTracked(coordinator: Coordinator): Promise<void> {
  coordinators.push(coordinator);
  await coordinator.start();
}

beforeEach(async () => {
  coordinators = [];
  fixture = await makeFixture();
  await fs.writeFile(boardPath(), EMPTY_BOARD);
});

afterEach(async () => {
  for (const coordinator of coordinators) coordinator.stop();
  await fixture.cleanup();
});

describe("Coordinator teardown releases its poll timer", () => {
  it("PROBE: a running coordinator folds a foreign merge in on its poll timer", async () => {
    // Positive control — the poll timer is live while running, so the leak
    // assertion below (its silence after stop) cannot pass vacuously.
    const ghostId = ticketIdFromCard("Add feature ghost");
    const context = fixture.context(() => Promise.resolve({ ok: true, text: "" }), {
      shouldPersistEvents: true,
    });
    const coordinator = new Coordinator(context, { pollMs: FAST_POLL_MS });
    await startTracked(coordinator);
    expect(context.log.snapshot().tickets[ghostId]).toBeUndefined();

    await emitForeignMerge(ghostId);
    await waitUntil(() => context.log.snapshot().tickets[ghostId]?.status === "done");
    coordinator.stop();
  });

  it("stops folding foreign events after stop() — the poll timer is released", async () => {
    const ghostId = ticketIdFromCard("Add feature ghost");
    const context = fixture.context(() => Promise.resolve({ ok: true, text: "" }), {
      shouldPersistEvents: true,
    });
    const coordinator = new Coordinator(context, { pollMs: FAST_POLL_MS });
    await startTracked(coordinator);
    coordinator.stop();

    // The same foreign merge the probe folded in — but the timer is gone.
    await emitForeignMerge(ghostId);
    // Bounded non-event wait: a surviving timer would have polled ~15× by now.
    await sleep(NON_EVENT_WINDOW_MS);

    expect(context.log.snapshot().tickets[ghostId]).toBeUndefined();
  });

  it("the afterEach-style teardown loop releases a coordinator a throw left running", async () => {
    // Mirrors the exact leak the ticket fixes: an assertion throws past the
    // in-body stop(), and only the tracked-array teardown releases the timer.
    const ghostId = ticketIdFromCard("Add feature ghost");
    const context = fixture.context(() => Promise.resolve({ ok: true, text: "" }), {
      shouldPersistEvents: true,
    });
    const started: Coordinator[] = [];
    const teardown = () => {
      for (const coordinator of started) coordinator.stop();
    };

    try {
      const coordinator = new Coordinator(context, { pollMs: FAST_POLL_MS });
      started.push(coordinator);
      await coordinator.start();
      throw new Error("simulated failed assertion before coordinator.stop()");
    } catch (error) {
      expect((error as Error).message).toContain("simulated failed assertion");
    } finally {
      teardown();
    }

    await emitForeignMerge(ghostId);
    await sleep(NON_EVENT_WINDOW_MS);
    expect(context.log.snapshot().tickets[ghostId]).toBeUndefined();
  });
});
