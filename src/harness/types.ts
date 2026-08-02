/**
 * The harness abstraction. Pipeline logic never touches harness specifics —
 * `claude -p` is the sole implementation today; Codex etc. slot in later.
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

export interface Harness {
  readonly name: string;
  spawn(promptSpec: PromptSpec, options: SpawnOptions): HarnessSession;
}
