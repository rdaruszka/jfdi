import type {
  Harness,
  HarnessEvent,
  HarnessFailure,
  HarnessResult,
  HarnessSession,
  SessionUsage,
  SpawnOptions,
} from "./types.js";

export type FakeHandler = (
  prompt: string,
  options: SpawnOptions,
) => Promise<{
  ok: boolean;
  text: string;
  sessionId?: string;
  failure?: HarnessFailure;
  /** Optional progress events emitted before the result. */
  events?: HarnessEvent[];
  /** Optional usage a test can pin, so cost/token assertions stay deterministic. */
  usage?: SessionUsage;
}>;

/**
 * In-process harness for tests: the handler plays the agent, performing side
 * effects (writing files, committing, dropping verdict files) directly.
 */
export class FakeHarness implements Harness {
  readonly calls: Array<{ prompt: string; options: SpawnOptions }> = [];

  constructor(private readonly handler: FakeHandler) {}

  spawn(prompt: string, options: SpawnOptions): HarnessSession {
    this.calls.push({ prompt, options });
    let resolveDone: (result: HarnessResult) => void = () => {
      // Placeholder; replaced synchronously by the Promise executor below.
    };
    const done = new Promise<HarnessResult>((resolve) => {
      resolveDone = resolve;
    });
    const events: HarnessEvent[] = [];
    const run = this.handler(prompt, options)
      .then((result) => {
        const { events: progressEvents = [], ...harnessResult } = result;
        events.push(...progressEvents);
        events.push({
          type: "result",
          ok: result.ok,
          text: result.text,
          ...(result.usage ? { usage: result.usage } : {}),
        });
        resolveDone(harnessResult);
      })
      .catch((error: Error) => {
        resolveDone({ ok: false, text: error.message });
      });

    return {
      events: (async function* () {
        await run;
        yield* events;
      })(),
      done,
      kill: () => {
        // Nothing to kill — the fake resolves from an in-process handler.
      },
    };
  }

  spawnInteractive(): Promise<number> {
    return Promise.resolve(0);
  }
}
