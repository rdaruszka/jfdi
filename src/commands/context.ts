import * as path from "node:path";
import { JFDI_DIRECTORY, loadConfig } from "../config.js";
import { EventLog, type JfdiEvent } from "../events.js";
import { projectRoot } from "../git.js";
import { createSessionHarnesses } from "../harness/index.js";
import { PauseController } from "../pause.js";
import type { PipelineContext } from "../pipeline.js";
import { projectStateDirectory } from "../state-dir.js";
import { UsageRegistry } from "../usage.js";

export async function buildContext(
  cwd: string = process.cwd(),
  injectedStateDirectory?: string,
): Promise<PipelineContext> {
  let resolvedProjectRoot: string;
  try {
    resolvedProjectRoot = await projectRoot(cwd);
  } catch {
    throw new Error(
      "not inside a git repository — jfdi operates on the repo in the current directory",
    );
  }
  const config = await loadConfig(resolvedProjectRoot);
  const jfdiDirectory = path.join(resolvedProjectRoot, JFDI_DIRECTORY);
  const stateDirectory = injectedStateDirectory ?? projectStateDirectory(resolvedProjectRoot);
  const log = new EventLog(stateDirectory);
  return {
    projectRoot: resolvedProjectRoot,
    jfdiDirectory,
    stateDirectory,
    config,
    harnesses: createSessionHarnesses(config),
    log,
    pause: new PauseController(log),
    usage: new UsageRegistry(),
  };
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

/** Inline streaming renderer for single-ticket mode: plain lines over the event stream. */
export function attachInlinePrinter(log: EventLog): () => void {
  return log.on((event: JfdiEvent) => {
    const id = event.ticketId ? `${DIM}[${event.ticketId}]${RESET} ` : "";
    switch (event.type) {
      case "dispatch":
        console.log(`${id}${BOLD}dispatched${RESET} on ${event.data?.branch}`);
        break;
      case "resumed":
        console.log(
          `${id}${YELLOW}resuming${RESET} ${event.data?.commitCount} commits of prior work`,
        );
        break;
      case "round_start":
        console.log(`${id}${BOLD}— round ${event.data?.round} —${RESET}`);
        break;
      case "stage_start":
        console.log(
          `${id}${BOLD}${event.data?.stage}${RESET} started ${DIM}${stageAgent(event.data)}${RESET}`,
        );
        break;
      case "stage_end": {
        const verdict = String(event.data?.verdict ?? "");
        const color =
          verdict === "pass" || verdict === "done" || verdict === "clean" ? GREEN : YELLOW;
        console.log(`${id}${event.data?.stage} → ${color}${verdict}${RESET}`);
        break;
      }
      case "gate_start":
        console.log(`${id}gate running…`);
        break;
      case "gate_result":
        console.log(
          event.data?.ok
            ? `${id}gate ${GREEN}passed${RESET}`
            : `${id}gate ${RED}failed${RESET} at ${event.data?.step}`,
        );
        break;
      case "session_activity":
        console.log(`${id}${DIM}${event.data?.text}${RESET}`);
        break;
      case "escalation":
        console.log(`${id}${YELLOW}escalated:${RESET} ${event.data?.question}`);
        break;
      case "blocked":
        console.log(`${id}${RED}blocked:${RESET} ${event.data?.reason}`);
        break;
      case "complicated_merge":
        console.log(`${id}${YELLOW}complicated merge — re-running QA${RESET}`);
        break;
      case "merge_start":
        console.log(`${id}integrating…`);
        break;
      case "merge_ready":
        console.log(
          `${id}${GREEN}ready to merge${RESET} — approve with: jfdi merge ${event.ticketId}`,
        );
        break;
      case "merged":
        console.log(`${id}${GREEN}merged${RESET}`);
        break;
      case "harness_paused":
        console.log(`${YELLOW}paused${RESET} — ${pauseLine(event.data)}`);
        break;
      case "harness_resumed":
        console.log(`${GREEN}resumed${RESET} (${event.data?.trigger})`);
        break;
      default:
        break;
    }
  });
}

/** Which agent a starting stage got, from the selection `stage_start` carries. */
function stageAgent(data: Record<string, unknown> | undefined): string {
  const parts = ["harness", "model", "effort"]
    .map((key) => data?.[key])
    .filter((value): value is string => typeof value === "string");
  return parts.length > 0 ? `(${parts.join(" ")})` : "";
}

/** The one-line "why we stopped, and what ends it" a paused terminal shows. */
function pauseLine(data: Record<string, unknown> | undefined): string {
  const what = `${data?.kind}: ${data?.detail}`;
  const resumesAt = data?.resumesAt;
  return typeof resumesAt === "string"
    ? `${what} — retrying at ${new Date(resumesAt).toLocaleTimeString()}, or press R now`
    : `${what} — repair it, then press R`;
}

/** Ctrl-C, which raw mode delivers as a byte on stdin instead of as a signal. */
const END_OF_TEXT = "\u0003";

/** The slice of a TTY stdin the retry key needs — narrow enough for a test to stand one up. */
export interface KeyInput {
  isTTY?: boolean | undefined;
  setRawMode(isRaw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

/**
 * The human's "retry now" key for a paused run.
 *
 * Raw mode is what makes a bare R a keypress rather than a line to submit, but
 * it also clears ISIG: while it is on, Ctrl-C is a byte on stdin and the
 * terminal generates no SIGINT for the foreground process group — neither for
 * this process nor for the agent subprocess inside it. So the terminal is taken
 * for the pause only and given straight back on resume; at every other moment
 * Ctrl-C keeps its ordinary meaning and takes the whole group down.
 *
 * Holding it for that window is safe because a pause begins only after the
 * session that provoked it has ended — `runHeldSession` awaits the session,
 * then holds — so there is no live child to orphan. The one interrupt raw mode
 * does swallow is handed to `onInterrupt` to answer by hand.
 *
 * Without a TTY there is no keyboard at all: a needs-human pause then waits for
 * an ordinary Ctrl-C.
 */
export function attachRetryKey(
  pause: PauseController,
  onInterrupt: () => void,
  input: KeyInput = process.stdin,
): () => void {
  if (!input.isTTY) return () => undefined;
  let isListening = false;

  function stopListening(): void {
    if (!isListening) return;
    isListening = false;
    input.off("data", onKey);
    input.setRawMode(false);
    input.pause();
  }

  const onKey = (chunk: Buffer) => {
    const key = chunk.toString();
    if (key === "r" || key === "R") pause.retryNow();
    if (key === END_OF_TEXT) {
      stopListening();
      onInterrupt();
    }
  };

  function startListening(): void {
    if (isListening) return;
    isListening = true;
    input.setRawMode(true);
    input.resume();
    input.on("data", onKey);
  }

  const unsubscribe = pause.subscribe(() => {
    if (pause.isPaused()) startListening();
    else stopListening();
  });
  return () => {
    unsubscribe();
    stopListening();
  };
}
