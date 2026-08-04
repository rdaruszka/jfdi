/**
 * The harness abstraction. Pipeline logic never touches harness specifics —
 * Provider-specific CLI details stay behind this interface.
 */
import type { StageName } from "../events.js";

export type HarnessName = "claude" | "codex";

/**
 * A key of the `stages` config section: the four pipeline stages, plus the
 * scribe. The scribe is not a stage — it has no verdict, no round and no
 * sign-off — but it does spawn a session, so it needs a harness selection of
 * its own, and `stages` is where selections live.
 */
export type SessionKind = StageName | "commit-message";

/**
 * What one `stages` entry asked of a harness instance. Model and effort are
 * provider-native strings passed through verbatim — there is no neutral model
 * vocabulary — and each implementation maps them to its own CLI's spelling.
 * Absent means "pass no flag": the provider's own default, never a value
 * borrowed from another entry.
 *
 * `sessionKind` is carried only as provenance: it is the config key that
 * selected this instance, so a spawn that fails can name the entry to fix.
 */
export interface HarnessSelection {
  sessionKind: SessionKind;
  model?: string | undefined;
  effort?: string | undefined;
}

export interface PromptSpec {
  prompt: string;
}

/**
 * Why a session died, when the reason was the provider under it rather than
 * the work in front of it. Each harness classifies its own provider's failures
 * (exit codes carry no class information on either CLI) and reports this
 * neutral shape; the pipeline holds and re-runs the stage instead of treating
 * it as feedback. Absent means an ordinary task failure.
 */
export type HarnessFailure =
  /** Quota exhausted. `resetsAtMs` is null when the provider stated no time we could read. */
  | { kind: "usage-limit"; resetsAtMs: number | null; detail: string }
  /** Login expired, key revoked, out of credits — a named repair only a human can do. */
  | { kind: "needs-human"; detail: string }
  /** Transient: 5xx, network, capacity. Self-resolves. */
  | { kind: "outage"; detail: string };

export type HarnessFailureKind = HarnessFailure["kind"];

export type HarnessEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  /** The provider's identifier for this session, used to continue it later. */
  | { type: "session"; sessionId: string }
  | { type: "result"; ok: boolean; text: string; failure?: HarnessFailure };

export interface HarnessResult {
  ok: boolean;
  /** The session's final result text (agents are told to end with their report). */
  text: string;
  exitCode: number;
  /**
   * Identifier a later spawn can pass as `continueSessionId` to continue this
   * conversation. Absent when the provider never reported one.
   */
  sessionId?: string;
  /** Set only when the provider failed, not the agent — see `HarnessFailure`. */
  failure?: HarnessFailure;
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
  /**
   * Continue an earlier session (its `HarnessResult.sessionId`) instead of
   * starting fresh: the agent keeps its conversation context and receives the
   * prompt as the next user message. Callers must handle failure by falling
   * back to a fresh spawn — providers forget sessions.
   */
  continueSessionId?: string;
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
