/**
 * How the pipeline narrates itself: the status line that ends every handoff
 * commit message and every ticket comment, and the append that puts it on the
 * note. One vocabulary, so `git log` and the ticket note tell the same story —
 * some humans only ever read one of them.
 *
 * Routing text always names where the run actually went, never where it
 * nominally goes next.
 */
import type { StageName } from "./events.js";
import { appendComment } from "./ticket-note.js";

/** Human-facing stage names. "JFDI" and the stage label are always capitalized. */
export const STAGE_LABELS: Record<StageName, string> = {
  implementation: "Implementation",
  "code-review": "Code Review",
  qa: "QA",
  integration: "Integration",
};

/** Where a run goes when nothing more is worth trying: a human. */
export const BLOCKED_ROUTING = "moving to Blocked for human review";

/** `JFDI <Stage> <outcome> — <routing>`: what happened, and where the run went. */
export function statusLine(stage: StageName, outcome: string, routing: string): string {
  return `JFDI ${STAGE_LABELS[stage]} ${outcome} — ${routing}`;
}

/** A failed round goes back to Implementation, unless it was the last one. */
export function retryRouting(round: number, maxRounds: number): string {
  return round < maxRounds ? `returning to Implementation for round ${round + 1}` : BLOCKED_ROUTING;
}

/**
 * Append one transition entry to the ticket note's `## Comments` trail — the
 * pipeline narrating a round to whoever reads the note instead of the log.
 */
export function recordTransition(
  notePath: string,
  stage: string,
  round: number,
  body: string,
): Promise<void> {
  return appendComment(notePath, {
    kind: "transition",
    timestamp: new Date().toISOString(),
    stage,
    round,
    body,
  });
}
