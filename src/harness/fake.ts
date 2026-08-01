import type {
  Harness,
  HarnessEvent,
  HarnessResult,
  HarnessSession,
  PromptSpec,
  SpawnOptions,
} from "./types.js";

export type FakeHandler = (
  spec: PromptSpec,
  opts: SpawnOptions,
) => Promise<{ ok: boolean; text: string }>;

/**
 * In-process harness for tests: the handler plays the agent, performing side
 * effects (writing files, committing, dropping verdict files) directly.
 */
export class FakeHarness implements Harness {
  readonly name = "fake";
  readonly calls: Array<{ spec: PromptSpec; opts: SpawnOptions }> = [];

  constructor(private readonly handler: FakeHandler) {}

  spawn(spec: PromptSpec, opts: SpawnOptions): HarnessSession {
    this.calls.push({ spec, opts });
    let resolveDone: (r: HarnessResult) => void = () => {
      // Placeholder; replaced synchronously by the Promise executor below.
    };
    const done = new Promise<HarnessResult>((r) => {
      resolveDone = r;
    });
    const events: HarnessEvent[] = [];
    const run = this.handler(spec, opts)
      .then((r) => {
        events.push({ type: "result", ok: r.ok, text: r.text });
        resolveDone({ ...r, exitCode: r.ok ? 0 : 1 });
      })
      .catch((err: Error) => {
        resolveDone({ ok: false, text: err.message, exitCode: 1 });
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
}
