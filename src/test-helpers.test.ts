import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
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
});
