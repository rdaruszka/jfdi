import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waitFor", () => {
  it("resolves when an asynchronous condition becomes true", async () => {
    vi.useFakeTimers();
    let attempts = 0;

    const waiting = waitFor(
      async () => {
        await Promise.resolve();
        attempts += 1;
        return attempts === 3;
      },
      { timeoutMs: 100, intervalMs: 10, describe: () => "the third attempt" },
    );

    await vi.runAllTimersAsync();
    await expect(waiting).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it("names the unmet condition on timeout", async () => {
    vi.useFakeTimers();
    const waiting = waitFor(() => false, {
      timeoutMs: 20,
      intervalMs: 10,
      describe: () => "the card to reach Done",
    });
    const result = expect(waiting).rejects.toThrow("the card to reach Done");

    await vi.runAllTimersAsync();
    await result;
  });

  it("caps attempts using the timeout and interval", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const waiting = waitFor(
      () => {
        attempts += 1;
        return false;
      },
      { timeoutMs: 10, intervalMs: 4, describe: () => "an impossible condition" },
    );
    const result = expect(waiting).rejects.toThrow();

    await vi.runAllTimersAsync();
    await result;
    expect(attempts).toBe(4);
  });

  it("stays bounded by the attempt cap even when the clock never advances", async () => {
    // The deadline guard cannot fire if Date.now is pinned, so this isolates the
    // derived attempt cap as an independent terminator — the bound the project's
    // termination-measure rule requires when a stuck condition never flips.
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let attempts = 0;
    const waiting = waitFor(
      () => {
        attempts += 1;
        return false;
      },
      { timeoutMs: 30, intervalMs: 10, describe: () => "a frozen clock" },
    );
    const result = expect(waiting).rejects.toThrow("a frozen clock");

    await vi.runAllTimersAsync();
    await result;
    // ceil(30 / 10) + 1 — reached without the wall-clock deadline ever helping.
    expect(attempts).toBe(4);
  });

  it("polls a real timer until a condition flips, without fake timers", async () => {
    // The e2e suites run waitFor against real subprocess state on real timers;
    // this proves the poll actually yields and re-checks off a live clock.
    let attempts = 0;
    await expect(
      waitFor(
        () => {
          attempts += 1;
          return attempts === 3;
        },
        { timeoutMs: 1_000, intervalMs: 5, describe: () => "three real polls" },
      ),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it("resolves on the first check when the condition already holds", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await expect(
      waitFor(() => true, { timeoutMs: 100, intervalMs: 10, describe: () => "unreachable" }),
    ).resolves.toBeUndefined();
    // A condition that is already true must not schedule any wait.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("awaits an asynchronous describe when building the timeout message", async () => {
    vi.useFakeTimers();
    const waiting = waitFor(() => false, {
      timeoutMs: 20,
      intervalMs: 10,
      describe: () => Promise.resolve("the board to settle"),
    });
    const result = expect(waiting).rejects.toThrow("the board to settle");

    await vi.runAllTimersAsync();
    await result;
  });

  it("rejects a non-finite or negative timeout before polling", async () => {
    const describe = () => "should never be reached";
    for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      await expect(waitFor(() => false, { timeoutMs, intervalMs: 10, describe })).rejects.toThrow(
        /timeoutMs/,
      );
    }
  });

  it("rejects a non-positive or non-finite interval before polling", async () => {
    const describe = () => "should never be reached";
    for (const intervalMs of [0, -5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(waitFor(() => false, { timeoutMs: 100, intervalMs, describe })).rejects.toThrow(
        /intervalMs/,
      );
    }
  });
});
