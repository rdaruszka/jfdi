import * as path from "node:path";
import { JFDI_DIR, loadConfig } from "../config.js";
import { EventLog, type JfdiEvent } from "../events.js";
import { repoRoot } from "../git.js";
import { createHarness } from "../harness/index.js";
import type { PipelineContext } from "../pipeline.js";

export interface CliContext extends PipelineContext {
  repoRoot: string;
  jfdiDir: string;
}

export async function buildContext(cwd: string = process.cwd()): Promise<CliContext> {
  let root: string;
  try {
    root = await repoRoot(cwd);
  } catch {
    throw new Error(
      "not inside a git repository — jfdi operates on the repo in the current directory",
    );
  }
  const config = await loadConfig(root);
  const jfdiDir = path.join(root, JFDI_DIR);
  return {
    repoRoot: root,
    jfdiDir,
    config,
    harness: createHarness(config),
    log: new EventLog(jfdiDir),
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
  return log.on((evt: JfdiEvent) => {
    const id = evt.ticketId ? `${DIM}[${evt.ticketId}]${RESET} ` : "";
    switch (evt.type) {
      case "dispatch":
        console.log(`${id}${BOLD}dispatched${RESET} on ${evt.data?.branch}`);
        break;
      case "round_start":
        console.log(`${id}${BOLD}— round ${evt.data?.round} —${RESET}`);
        break;
      case "stage_start":
        console.log(`${id}${BOLD}${evt.data?.stage}${RESET} started`);
        break;
      case "stage_end": {
        const verdict = String(evt.data?.verdict ?? "");
        const color =
          verdict === "pass" || verdict === "done" || verdict === "clean" ? GREEN : YELLOW;
        console.log(`${id}${evt.data?.stage} → ${color}${verdict}${RESET}`);
        break;
      }
      case "gate_start":
        console.log(`${id}gate running…`);
        break;
      case "gate_result":
        console.log(
          evt.data?.ok
            ? `${id}gate ${GREEN}passed${RESET}`
            : `${id}gate ${RED}failed${RESET} at ${evt.data?.step}`,
        );
        break;
      case "session_activity":
        console.log(`${id}${DIM}${evt.data?.text}${RESET}`);
        break;
      case "escalation":
        console.log(`${id}${YELLOW}escalated:${RESET} ${evt.data?.question}`);
        break;
      case "blocked":
        console.log(`${id}${RED}blocked:${RESET} ${evt.data?.reason}`);
        break;
      case "complicated_merge":
        console.log(`${id}${YELLOW}complicated merge — re-running QA${RESET}`);
        break;
      case "merge_start":
        console.log(`${id}integrating…`);
        break;
      case "merge_ready":
        console.log(
          `${id}${GREEN}ready to merge${RESET} — approve with: jfdi merge ${evt.ticketId}`,
        );
        break;
      case "merged":
        console.log(`${id}${GREEN}merged${RESET}`);
        break;
      default:
        break;
    }
  });
}
