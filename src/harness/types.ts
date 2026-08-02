/**
 * The harness abstraction. Pipeline logic never touches harness specifics —
 * Provider-specific CLI details stay behind this interface.
 */

export interface PromptSpec {
  prompt: string;
}

export type HarnessEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "result"; ok: boolean; text: string };

export interface HarnessResult {
  ok: boolean;
  /** The session's final result text (agents are told to end with their report). */
  text: string;
  exitCode: number;
}

export interface HarnessSession {
  /** Live event stream for progress rendering. */
  events: AsyncIterable<HarnessEvent>;
  /** Resolves when the session ends (never rejects; failures are ok:false). */
  done: Promise<HarnessResult>;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  /** Raw harness output is appended here (jfdi logs <ticket>). */
  logPath?: string;
}

export interface InteractiveSpawnOptions {
  cwd: string;
  /** Providers may support a true system prompt or approximate it as initial instructions. */
  isSystemPrompt?: boolean;
}

export interface Harness {
  readonly name: string;
  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession;
  spawnInteractive(promptSpec: PromptSpec, options: InteractiveSpawnOptions): Promise<number>;
}
