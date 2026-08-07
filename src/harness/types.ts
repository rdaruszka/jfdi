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

/**
 * Provider-neutral usage for one session: what it cost and how much it moved.
 *
 * Cost and tokens come from the provider — Claude reports USD directly, Codex
 * reports only tokens and its dollars are computed from a price table. `costUsd`
 * is null when no price is known ("unknown" is a deliberate signal to update the
 * table, never a fabricated number); the token counts are the fallback display
 * and the machine-record diagnostics. `durationMs` is NOT provider-reported: it
 * is wall-clock the pipeline measures around the session (Codex reports no
 * duration at all), so it is filled in later, not here — see the harness code.
 */
export interface SessionUsage {
  /** Wall-clock around the session, measured by the pipeline. Zero until set there. */
  durationMs: number;
  /** Provider/table dollars for this session; null means no price is known. */
  costUsd: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  /** Output tokens as the provider counts them, including Codex reasoning tokens. */
  outputTokens: number;
  /** The provider-confirmed model, carried into usage rows and reports. Absent when unreported. */
  model?: string;
  /**
   * True when `costUsd` is a price-table estimate (Codex) rather than a figure
   * the provider reported (Claude). A table estimate runs low — cache writes and
   * long-context tiers are unpriced — so surfaces that show the dollars say so.
   */
  isCostEstimated?: boolean;
}

export type HarnessEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "result"; ok: boolean; text: string; failure?: HarnessFailure; usage?: SessionUsage };

export interface HarnessResult {
  ok: boolean;
  /** The session's final result text (agents are told to end with their report). */
  text: string;
  /**
   * Identifier a later spawn can pass as `continueSessionId` to continue this
   * conversation. Absent when the provider never reported one.
   */
  sessionId?: string;
  /** Set only when the provider failed, not the agent — see `HarnessFailure`. */
  failure?: HarnessFailure;
  /**
   * What the session cost and moved. Absent when the provider reported nothing
   * usable (an early crash) — callers still have pipeline-measured duration to
   * fall back on. `durationMs` here is zero until the pipeline fills it in.
   */
  usage?: SessionUsage;
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
  /**
   * Session-wide framing appended to the provider's own system prompt.
   * Claude passes it via --append-system-prompt; Codex has no system-prompt
   * seam, so it degrades gracefully by prepending the text to the opening
   * user message.
   */
  systemPrompt?: string;
  /**
   * When true, the session must not ingest the project's own agent
   * instructions (AGENTS.md/CLAUDE.md) or other ambient customization — it
   * sees the project with fresh eyes. Claude maps this to --bare (skips
   * CLAUDE.md auto-discovery, hooks, auto-memory); Codex disables project-doc
   * loading via -c project_doc_max_bytes=0.
   */
  shouldIgnoreProjectContext?: boolean;
}

export interface Harness {
  spawn(prompt: string, options: SpawnOptions): HarnessSession;
  spawnInteractive(prompt: string, options: InteractiveSpawnOptions): Promise<number>;
}
