import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog, type JfdiEvent } from "./events.js";
import type { HarnessFailure } from "./harness/types.js";
import { PauseController, type PauseDelays } from "./pause.js";

/** Round numbers, so an assertion can name the instant a wait ends. */
const DELAYS: PauseDelays = {
  outageStageRetryMs: [1_000, 2_000],
  probeMs: [10_000, 30_000],
  usageLimitBufferMs: 5_000,
  maxWaitMs: 100_000,
};

const OUTAGE: HarnessFailure = { kind: "outage", detail: "Overloaded" };
const NEEDS_HUMAN: HarnessFailure = { kind: "needs-human", detail: "run /login" };

function usageLimit(resetsAtMs: number | null): HarnessFailure {
  return { kind: "usage-limit", resetsAtMs, detail: "session limit" };
}

let events: JfdiEvent[];
let pause: PauseController;

function makeController(delays: PauseDelays = DELAYS): PauseController {
  const log = new EventLog("/nonexistent-state-dir", false);
  log.on((event) => events.push(event));
  return new PauseController(log, delays);
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  pause = makeController();
});

afterEach(() => {
  pause.stop();
  vi.useRealTimers();
});

/** The single pause event a test just provoked. */
function pausedEvent(): JfdiEvent {
  const paused = events.filter((event) => event.type === "harness_paused");
  expect(paused).toHaveLength(1);
  return paused[0] as JfdiEvent;
}

describe("PauseController", () => {
  it("does not pause the tool for the first outages — it retries the stage", async () => {
    const first = pause.holdAfterFailure(OUTAGE, 1);
    expect(pause.isPaused()).toBe(false);
    await vi.advanceTimersByTimeAsync(DELAYS.outageStageRetryMs[0] as number);
    expect(await first).toBe(true);
    expect(events.filter((event) => event.type === "harness_paused")).toHaveLength(0);
  });

  it("escalates to a global pause once the stage retries are spent", async () => {
    const held = pause.holdAfterFailure(OUTAGE, DELAYS.outageStageRetryMs.length + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pause.isPaused()).toBe(true);
    expect(pause.state?.kind).toBe("outage");

    // …and the probe timer alone lifts it: no human is needed for an outage.
    await vi.advanceTimersByTimeAsync(DELAYS.probeMs[0] as number);
    expect(await held).toBe(true);
    expect(pause.isPaused()).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "harness_resumed", data: { trigger: "timer" } });
  });

  it("steps the probe backoff over consecutive pauses, and resets it on a healthy session", async () => {
    const startMs = Date.now();
    const first = pause.holdAfterFailure(OUTAGE, 99);
    await vi.advanceTimersByTimeAsync(DELAYS.probeMs[0] as number);
    expect(await first).toBe(true);

    const second = pause.holdAfterFailure(OUTAGE, 99);
    await vi.advanceTimersByTimeAsync(0);
    const secondResume = Date.parse(String(events.at(-1)?.data?.resumesAt));
    expect(secondResume - startMs).toBe(
      (DELAYS.probeMs[0] as number) + (DELAYS.probeMs[1] as number),
    );
    await vi.advanceTimersByTimeAsync(DELAYS.probeMs[1] as number);
    expect(await second).toBe(true);

    // A session that reached the provider means the next episode starts over.
    pause.reportHealthy();
    events = [];
    const third = pause.holdAfterFailure(OUTAGE, 99);
    await vi.advanceTimersByTimeAsync(0);
    expect(Date.parse(String(pausedEvent().data?.resumesAt)) - Date.now()).toBe(
      DELAYS.probeMs[0] as number,
    );
    await vi.advanceTimersByTimeAsync(DELAYS.probeMs[0] as number);
    expect(await third).toBe(true);
  });

  it("waits for the stated reset time, plus a buffer, on a usage limit", async () => {
    const resetsAtMs = Date.now() + 40_000;
    const held = pause.holdAfterFailure(usageLimit(resetsAtMs), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pausedEvent().data?.resumesAt).toBe(
      new Date(resetsAtMs + DELAYS.usageLimitBufferMs).toISOString(),
    );

    await vi.advanceTimersByTimeAsync(40_000 + DELAYS.usageLimitBufferMs);
    expect(await held).toBe(true);
  });

  it("caps a reset time it may have misread, so a bad parse costs one probe", async () => {
    const held = pause.holdAfterFailure(usageLimit(Date.now() + 10 * DELAYS.maxWaitMs), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(Date.parse(String(pausedEvent().data?.resumesAt)) - Date.now()).toBe(DELAYS.maxWaitMs);
    await vi.advanceTimersByTimeAsync(DELAYS.maxWaitMs);
    expect(await held).toBe(true);
  });

  it("falls back to the probe schedule for a usage limit that named no reset", async () => {
    const held = pause.holdAfterFailure(usageLimit(null), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(Date.parse(String(pausedEvent().data?.resumesAt)) - Date.now()).toBe(
      DELAYS.probeMs[0] as number,
    );
    await vi.advanceTimersByTimeAsync(DELAYS.probeMs[0] as number);
    expect(await held).toBe(true);
  });

  it("never auto-probes a needs-human pause; R is the only way out", async () => {
    const held = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pausedEvent().data).toEqual({ kind: "needs-human", detail: "run /login" });

    // Long past any probe schedule, and still held.
    await vi.advanceTimersByTimeAsync(DELAYS.maxWaitMs);
    expect(pause.isPaused()).toBe(true);

    pause.retryNow();
    expect(await held).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "harness_resumed", data: { trigger: "human" } });
  });

  it("holds a live handle for the whole pause, even with no resume instant to wait on", async () => {
    // A pause with nothing referenced on the event loop does not hold anything:
    // the process exits under it and abandons the run. needs-human is the case
    // that installs no resume timer, so it is the one with nothing of its own.
    expect(vi.getTimerCount()).toBe(0);
    const held = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pause.state?.resumesAtMs).toBe(null);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    pause.retryNow();
    expect(await held).toBe(true);
    // …and released with the pause, so a finished run can still exit.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its handles on stop too, not only on resume", async () => {
    const held = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    pause.stop();
    expect(await held).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases every holder at once, including ones that arrived after the pause", async () => {
    const first = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    const latecomer = pause.waitWhilePaused();
    let hasLatecomerResumed = false;
    const watched = latecomer.then(() => {
      hasLatecomerResumed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hasLatecomerResumed).toBe(false);

    pause.retryNow();
    await Promise.all([first, watched]);
    expect(hasLatecomerResumed).toBe(true);
    // One pause, one resume — not one per holder.
    expect(events.filter((event) => event.type === "harness_resumed")).toHaveLength(1);
  });

  it("keeps the first pause when a second failure lands while it is held", async () => {
    const first = pause.holdAfterFailure(usageLimit(Date.now() + 40_000), 1);
    await vi.advanceTimersByTimeAsync(0);
    const second = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pause.state?.kind).toBe("usage-limit");
    expect(events.filter((event) => event.type === "harness_paused")).toHaveLength(1);

    pause.retryNow();
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it("tells holders to stop rather than retry once the tool is stopping", async () => {
    const held = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    pause.stop();
    expect(await held).toBe(false);
    // A stage-local backoff started after the stop does not wait either.
    expect(await pause.holdAfterFailure(OUTAGE, 1)).toBe(false);
  });

  it("notifies subscribers on both edges, so dispatch knows to stop and to start", async () => {
    const edges: boolean[] = [];
    const unsubscribe = pause.subscribe(() => edges.push(pause.isPaused()));
    const held = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    pause.retryNow();
    expect(await held).toBe(true);
    expect(edges).toEqual([true, false]);

    unsubscribe();
    const again = pause.holdAfterFailure(NEEDS_HUMAN, 1);
    await vi.advanceTimersByTimeAsync(0);
    pause.retryNow();
    expect(await again).toBe(true);
    expect(edges).toEqual([true, false]);
  });
});
