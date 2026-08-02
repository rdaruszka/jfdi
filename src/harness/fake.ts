import type {
  Harness,
  HarnessEvent,
  HarnessResult,
  HarnessSession,
  PromptSpec,
  SpawnOptions,
} from "./types.js";

export type FakeHandler = (
  promptSpec: PromptSpec,
  options: SpawnOptions,
) => Promise<{ ok: boolean; text: string; sessionId?: string }>;

/**
 * In-process harness for tests: the handler plays the agent, performing side
 * effects (writing files, committing, dropping verdict files) directly.
 */
export class FakeHarness implements Harness {
  readonly name = "fake";
  readonly calls: Array<{ promptSpec: PromptSpec; options: SpawnOptions }> = [];

  constructor(private readonly handler: FakeHandler) {}

  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession {
    this.calls.push({ promptSpec, options });
    let resolveDone: (result: HarnessResult) => void = () => {
      // Placeholder; replaced synchronously by the Promise executor below.
    };
    const done = new Promise<HarnessResult>((resolve) => {
      resolveDone = resolve;
    });
    const events: HarnessEvent[] = [];
    const run = this.handler(promptSpec, options)
      .then((result) => {
        events.push({ type: "result", ok: result.ok, text: result.text });
        resolveDone({ ...result, exitCode: result.ok ? 0 : 1 });
      })
      .catch((error: Error) => {
        resolveDone({ ok: false, text: error.message, exitCode: 1 });
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
