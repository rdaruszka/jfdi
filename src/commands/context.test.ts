import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { EventLog } from "../events.js";
import type { HarnessFailure } from "../harness/types.js";
import { PauseController } from "../pause.js";
import type { PipelineContext } from "../pipeline.js";
import { projectStateDirectory } from "../state-dir.js";
import { type Fixture, makeFixture } from "../test-helpers.js";
import { attachRetryKey, buildContext, type KeyInput } from "./context.js";

const CTRL_C = "\u0003";
const NEEDS_HUMAN: HarnessFailure = { kind: "needs-human", detail: "run /login" };

/**
 * A stand-in for a TTY stdin. The assertions are about what the terminal is
 * left in — raw or cooked, listened to or not — because that is what decides
 * whether a Ctrl-C reaches the process group.
 */
class FakeKeyInput implements KeyInput {
  isTTY: boolean | undefined = true;
  isRaw = false;
  isFlowing = false;
  private readonly listeners: Array<(chunk: Buffer) => void> = [];

  setRawMode(isRaw: boolean): void {
    this.isRaw = isRaw;
  }
  resume(): void {
    this.isFlowing = true;
  }
  pause(): void {
    this.isFlowing = false;
  }
  on(_event: "data", listener: (chunk: Buffer) => void): void {
    this.listeners.push(listener);
  }
  off(_event: "data", listener: (chunk: Buffer) => void): void {
    const at = this.listeners.indexOf(listener);
    if (at !== -1) this.listeners.splice(at, 1);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
  press(key: string): void {
    for (const listener of [...this.listeners]) listener(Buffer.from(key));
  }
}

let pause: PauseController;
let input: FakeKeyInput;
let interrupts: number;
let detach: () => void;

/** Enter a pause that has no timer, so only the key under test can end it. */
function enterPause(): Promise<boolean> {
  return pause.holdAfterFailure(NEEDS_HUMAN, 1);
}

beforeEach(() => {
  pause = new PauseController(new EventLog("/nonexistent-state-dir", false));
  input = new FakeKeyInput();
  interrupts = 0;
  detach = attachRetryKey(
    pause,
    () => {
      interrupts++;
    },
    input,
  );
});

describe("attachRetryKey", () => {
  it("leaves the terminal cooked until the harness pauses", async () => {
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount).toBe(0);

    const held = enterPause();
    expect(input.isRaw).toBe(true);
    expect(input.listenerCount).toBe(1);

    pause.retryNow();
    expect(await held).toBe(true);
    detach();
  });

  it("gives the terminal back the moment the pause lifts", async () => {
    const held = enterPause();
    pause.retryNow();
    expect(await held).toBe(true);

    // Raw mode clears ISIG, so leaving it on past the pause would keep the
    // terminal from ever signalling the agent subprocess again.
    expect(input.isRaw).toBe(false);
    expect(input.isFlowing).toBe(false);
    expect(input.listenerCount).toBe(0);
    detach();
  });

  it("retries the pause on R, in either case", async () => {
    const first = enterPause();
    input.press("r");
    expect(await first).toBe(true);
    expect(pause.isPaused()).toBe(false);

    const second = enterPause();
    input.press("R");
    expect(await second).toBe(true);
    detach();
  });

  it("hands a swallowed Ctrl-C to the interrupt handler, cooked terminal first", async () => {
    const held = enterPause();
    input.press(CTRL_C);

    expect(interrupts).toBe(1);
    // The handler shuts the run down and exits; it must not be left holding a
    // raw terminal while it does.
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount).toBe(0);

    pause.stop();
    expect(await held).toBe(false);
    detach();
  });

  it("stops listening across repeated pauses, and after detaching", async () => {
    const first = enterPause();
    pause.retryNow();
    expect(await first).toBe(true);
    const second = enterPause();
    expect(input.listenerCount).toBe(1);
    pause.retryNow();
    expect(await second).toBe(true);

    detach();
    const third = enterPause();
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount).toBe(0);
    pause.stop();
    expect(await third).toBe(false);
  });

  it("takes no terminal at all when there is no TTY", async () => {
    detach();
    const headless = new FakeKeyInput();
    headless.isTTY = undefined;
    const detachHeadless = attachRetryKey(pause, () => undefined, headless);

    const held = enterPause();
    expect(headless.isRaw).toBe(false);
    expect(headless.listenerCount).toBe(0);

    pause.stop();
    expect(await held).toBe(false);
    detachHeadless();
  });
});

describe("buildContext state directory injection", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  // The CLI's real invocation path passes no state dir, so it must still derive
  // one from the resolved repo root exactly as before the seam was added.
  it("derives the state dir from the repo when none is injected", async () => {
    const context = await buildContext(fixture.projectRoot);

    expectTypeOf(context).toEqualTypeOf<PipelineContext>();
    expect(context.stateDirectory).toBe(projectStateDirectory(context.projectRoot));
    expect(context.log.eventsPath).toBe(path.join(context.stateDirectory, "events.jsonl"));
  });

  // The additive seam command tests use: an injected dir wins over the derived
  // one, and the event log follows it there.
  it("uses an injected state dir verbatim", async () => {
    const injected = path.join(fixture.root, "injected-state");
    const context = await buildContext(fixture.projectRoot, injected);

    expect(context.stateDirectory).toBe(injected);
    expect(context.stateDirectory).not.toBe(projectStateDirectory(context.projectRoot));
    expect(context.log.eventsPath).toBe(path.join(injected, "events.jsonl"));
  });

  // Minimal and additive: injection touches only the state dir, never the repo
  // root, the .jfdi dir, or the config the rest of the command reads.
  it("leaves everything but the state dir derived from the repo", async () => {
    const injected = path.join(fixture.root, "injected-state");
    const derived = await buildContext(fixture.projectRoot);
    const overridden = await buildContext(fixture.projectRoot, injected);

    expect(overridden.projectRoot).toBe(derived.projectRoot);
    expect(overridden.jfdiDirectory).toBe(derived.jfdiDirectory);
    expect(overridden.config).toEqual(derived.config);
  });
});
