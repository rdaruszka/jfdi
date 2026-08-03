import type { EventLog } from "./events.js";
import type { HarnessFailure, HarnessFailureKind } from "./harness/types.js";

/**
 * Stage-local backoff before an outage escalates to a global pause. A 5xx or a
 * dropped connection is usually over before the third step, and retrying one
 * stage is cheaper than stopping the tool.
 */
const OUTAGE_RETRY_FIRST_MS = 5_000;
const OUTAGE_RETRY_SECOND_MS = 20_000;
const OUTAGE_RETRY_THIRD_MS = 60_000;
const OUTAGE_STAGE_RETRY_DELAYS_MS = [
  OUTAGE_RETRY_FIRST_MS,
  OUTAGE_RETRY_SECOND_MS,
  OUTAGE_RETRY_THIRD_MS,
] as const;

/**
 * How long a global pause waits before probing again, stepped then held at the
 * last entry. Every pause episode walks this list from the top; a session that
 * reaches the provider resets it.
 */
const PROBE_FIRST_MS = 60_000;
const PROBE_SECOND_MS = 300_000;
const PROBE_HELD_MS = 900_000;
const PAUSE_PROBE_DELAYS_MS = [PROBE_FIRST_MS, PROBE_SECOND_MS, PROBE_HELD_MS] as const;

/** Slack after a provider's stated reset instant, for clock skew on either side. */
const USAGE_LIMIT_BUFFER_MS = 60_000;

/**
 * Longest single pause wait. Reset times are read out of prose meant for a
 * human, so one can be badly wrong; this caps what a misreading costs to one
 * wasted probe that re-pauses, rather than a night of silence. Six hours.
 */
const MAX_PAUSE_WAIT_MS = 21_600_000;

export interface PauseDelays {
  /** One entry per stage-local outage retry; its length is how many are allowed. */
  outageStageRetryMs: readonly number[];
  probeMs: readonly number[];
  usageLimitBufferMs: number;
  maxWaitMs: number;
}

export const DEFAULT_PAUSE_DELAYS: PauseDelays = {
  outageStageRetryMs: OUTAGE_STAGE_RETRY_DELAYS_MS,
  probeMs: PAUSE_PROBE_DELAYS_MS,
  usageLimitBufferMs: USAGE_LIMIT_BUFFER_MS,
  maxWaitMs: MAX_PAUSE_WAIT_MS,
};

export interface PauseState {
  kind: HarnessFailureKind;
  detail: string;
  /** When the automatic retry fires; null means only a human can end this pause. */
  resumesAtMs: number | null;
}

/** What ended a pause — the difference between "it healed" and "you fixed it". */
export type ResumeTrigger = "timer" | "human";

/**
 * The tool-wide hold on agent sessions while the provider under the harness is
 * down. One instance lives on the `PipelineContext`, so `jfdi run` and every
 * coordinator-dispatched pipeline share the same pause: one infrastructure
 * failure holds them all, and one resume releases them all.
 *
 * Nothing here is persisted. A pause is a fact about the provider right now,
 * not about the run — a restarted JFDI simply spawns, fails, and pauses again.
 */
export class PauseController {
  private readonly delays: PauseDelays;
  private readonly listeners = new Set<() => void>();
  /** Resolvers of every `waitWhilePaused` promise outstanding on this pause. */
  private readonly pauseWaiters = new Set<() => void>();
  /** Wake callbacks of every stage-local backoff currently sleeping. */
  private readonly sleepers = new Set<() => void>();
  private paused: PauseState | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private probeStep = 0;
  private isStopped = false;

  constructor(
    private readonly log: EventLog,
    delays: PauseDelays = DEFAULT_PAUSE_DELAYS,
  ) {
    this.delays = delays;
  }

  /** The current pause, or null when sessions may run. */
  get state(): PauseState | null {
    return this.paused;
  }

  isPaused(): boolean {
    return this.paused !== null;
  }

  /** Notified whenever a pause begins or ends — the coordinator rescans on both. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Hold until the current pause lifts. Callers use this at stage boundaries
   * and before dispatch; with nothing paused it resolves immediately, so it is
   * cheap to put in front of every session.
   */
  waitWhilePaused(): Promise<void> {
    if (this.paused === null || this.isStopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pauseWaiters.add(resolve);
    });
  }

  /**
   * Hold a stage that just lost its session to the provider, and report whether
   * to run it again. `attempt` counts this stage's infrastructure failures, so
   * early outages back off locally and everything else pauses the whole tool.
   * Returns false only when the tool is stopping — the caller's exit.
   */
  async holdAfterFailure(failure: HarnessFailure, attempt: number): Promise<boolean> {
    if (this.isStopped) return false;
    const stageRetries = this.delays.outageStageRetryMs;
    const stageDelayMs = stageRetries[attempt - 1];
    if (failure.kind === "outage" && stageDelayMs !== undefined) {
      await this.sleep(stageDelayMs);
      return !this.isStopped;
    }
    this.enterPause(failure);
    await this.waitWhilePaused();
    return !this.isStopped;
  }

  /** A session reached the provider: the next pause starts its backoff from the top. */
  reportHealthy(): void {
    this.probeStep = 0;
  }

  /** The human's "retry now" signal (R in the TUI, R on a `jfdi run` terminal). */
  retryNow(): void {
    this.wakeSleepers();
    this.resume("human");
  }

  /** Release every waiter and drop the timers; waits after this resolve at once. */
  stop(): void {
    this.isStopped = true;
    this.clearPauseTimer();
    this.paused = null;
    this.wakeSleepers();
    for (const wake of [...this.pauseWaiters]) wake();
    this.pauseWaiters.clear();
    this.notify();
  }

  /**
   * Begin a pause. A pause already under way is left alone: whichever failure
   * arrived first owns the wait, and a pipeline released into a provider that
   * is still broken re-pauses on its own failure a moment later.
   */
  private enterPause(failure: HarnessFailure): void {
    if (this.paused !== null) return;
    const resumesAtMs = this.nextResumeAtMs(failure);
    this.paused = { kind: failure.kind, detail: failure.detail, resumesAtMs };
    this.log.emit("harness_paused", undefined, {
      kind: failure.kind,
      detail: failure.detail,
      ...(resumesAtMs === null ? {} : { resumesAt: new Date(resumesAtMs).toISOString() }),
    });
    // Deliberately not unref'd: a pause is work in progress, and a paused
    // `jfdi run` whose only pending timer was unref'd would simply exit.
    if (resumesAtMs !== null)
      this.pauseTimer = setTimeout(
        () => this.resume("timer"),
        Math.max(0, resumesAtMs - Date.now()),
      );
    this.notify();
  }

  /**
   * When to probe the provider again, or null when nothing but a human can
   * help. A usage limit that named its reset waits for it; an outage — and a
   * limit whose reset we could not read — walks the probe backoff instead.
   */
  private nextResumeAtMs(failure: HarnessFailure): number | null {
    if (failure.kind === "needs-human") return null;
    const nowMs = Date.now();
    if (failure.kind === "usage-limit" && failure.resetsAtMs !== null)
      return Math.min(failure.resetsAtMs + this.delays.usageLimitBufferMs, nowMs + this.maxWaitMs);
    const step = Math.min(this.probeStep, this.delays.probeMs.length - 1);
    const probeMs = this.delays.probeMs[step];
    // An empty schedule would index -1 and there is no sane delay to invent:
    // zero would busy-probe the very provider we are backing off from.
    if (probeMs === undefined)
      throw new Error(
        "pause probe schedule is empty — PauseDelays.probeMs needs at least one delay",
      );
    this.probeStep += 1;
    return nowMs + Math.min(probeMs, this.maxWaitMs);
  }

  private get maxWaitMs(): number {
    return this.delays.maxWaitMs;
  }

  private resume(trigger: ResumeTrigger): void {
    const paused = this.paused;
    if (paused === null) return;
    this.paused = null;
    this.clearPauseTimer();
    this.log.emit("harness_resumed", undefined, {
      kind: paused.kind,
      detail: paused.detail,
      trigger,
    });
    for (const wake of [...this.pauseWaiters]) wake();
    this.pauseWaiters.clear();
    this.notify();
  }

  /** Resolve after `delayMs`, or as soon as a human or a shutdown says otherwise. */
  private sleep(delayMs: number): Promise<void> {
    if (this.isStopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const wake = () => {
        if (timer !== null) clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, delayMs);
      this.sleepers.add(wake);
    });
  }

  private wakeSleepers(): void {
    for (const wake of [...this.sleepers]) wake();
    this.sleepers.clear();
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer === null) return;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
