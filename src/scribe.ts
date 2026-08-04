/**
 * The scribe: the cheap, read-only session that turns one session's handoff
 * into a commit message. It is not a stage — no verdict, no round, no sign-off
 * — it is pipeline plumbing that happens to use a session, selected by the
 * `stages["commit-message"]` config entry.
 *
 * The scribe writes only the subject and body. The status line and the
 * `JFDI-Round` trailer are bolted on here, because a message that has to stay
 * machine-parseable (`git log --format='%(trailers:key=JFDI-Round)'`) cannot
 * depend on an agent getting a format right. The same rendered text goes to
 * the commit and to the ticket note's `## Comments` trail.
 */
import type { StageName } from "./events.js";
import { git } from "./git.js";
import { STAGE_LABELS, statusLine } from "./transitions.js";

/** What the pipeline knows about the session it is committing for. */
export interface SessionHandoff {
  stage: StageName;
  round: number;
  maxRounds: number;
  /** What the session did, as the status line says it: `complete`, `FAILED`, `interrupted: …`. */
  outcome: string;
  /** Where the run actually went after this session. */
  routing: string;
  /** The stage's own account of what it did — the "why" the diff cannot carry. */
  summary: string;
  /** Partial work: the session did not finish, so the subject carries a WIP marker. */
  isInterrupted: boolean;
}

/** The mechanical context the scribe writes from, collected by the pipeline. */
export interface CommitContext {
  /** The diff about to be committed. */
  stagedDiff: string;
  /** Recent commit messages — the house style to match. */
  recentLog: string;
}

/**
 * Largest staged diff handed to the scribe. A message is a summary, so a diff
 * past this size buys nothing but context: the scribe is told it was truncated
 * and writes from the summary and the diffstat-sized head of it.
 */
const MAX_STAGED_DIFF_CHARS = 40_000;

/** Commits quoted as the house style. Enough to show a pattern, not a history. */
const HOUSE_STYLE_COMMIT_COUNT = 5;

/** Longest excerpt of a session's own account quoted into the scribe's prompt. */
const MAX_SUMMARY_CHARS = 4_000;

/**
 * A commit message's own trailing metadata, which the pipeline owns and the
 * scribe is told not to write. Matched narrowly — a status line names a stage
 * and its routing — so a body sentence that merely opens with the tool's name
 * is not mistaken for one.
 */
const PIPELINE_TRAILER_RE = /^JFDI-[A-Za-z-]+:/;
const PIPELINE_STATUS_LINE_RE = new RegExp(
  `^JFDI (${Object.values(STAGE_LABELS).join("|")}) .+ — .+$`,
);

/** The two mechanical inputs: what is being committed, and how this repo writes messages. */
export async function collectCommitContext(worktreePath: string): Promise<CommitContext> {
  const diff = await git(worktreePath, "diff", "--cached");
  const recentLog = await git(
    worktreePath,
    "log",
    `--max-count=${HOUSE_STYLE_COMMIT_COUNT}`,
    "--format=%s%n%n%b",
  );
  return {
    stagedDiff:
      diff.length <= MAX_STAGED_DIFF_CHARS
        ? diff
        : `${diff.slice(0, MAX_STAGED_DIFF_CHARS)}\n\n[diff truncated at ${MAX_STAGED_DIFF_CHARS} characters — describe the change from the summary above]`,
    recentLog,
  };
}

/** Everything the commit-message prompt template renders. */
export function scribeVariables(
  ticketId: string,
  ticketDescription: string,
  handoff: SessionHandoff,
  commitContext: CommitContext,
): Record<string, string> {
  return {
    TICKET_ID: ticketId,
    SPEC: ticketDescription,
    STAGE: STAGE_LABELS[handoff.stage],
    ROUND: String(handoff.round),
    MAX_ROUNDS: String(handoff.maxRounds),
    STATUS_LINE: statusLine(handoff.stage, handoff.outcome, handoff.routing),
    STAGE_SUMMARY: handoff.summary.slice(0, MAX_SUMMARY_CHARS) || "(the session recorded none)",
    STAGED_DIFF: commitContext.stagedDiff,
    RECENT_LOG: commitContext.recentLog,
  };
}

/**
 * The final message: the scribe's subject and body under a ticket-id subject
 * prefix, over the status line and the round trailer. Text the scribe did not
 * write usably — an empty answer, a session that died — falls back to the
 * stage's own summary, so a commit never waits on prose.
 */
export function assembleCommitMessage(
  scribeText: string,
  ticketId: string,
  handoff: SessionHandoff,
): string {
  const written = withoutPipelineMetadata(stripFences(scribeText));
  const lines = written.length > 0 ? written.split("\n") : [];
  const subject = subjectLine(ticketId, lines[0] ?? "", handoff);
  const body = (lines.length > 0 ? lines.slice(1).join("\n") : handoff.summary).trim();
  const trailers = [
    statusLine(handoff.stage, handoff.outcome, handoff.routing),
    `JFDI-Round: ${handoff.round}/${handoff.maxRounds}`,
  ].join("\n");
  return `${[subject, body, trailers].filter((part) => part !== "").join("\n\n")}\n`;
}

function subjectLine(ticketId: string, written: string, handoff: SessionHandoff): string {
  const stripped = written.trim().replace(new RegExp(`^${escapeForRegExp(ticketId)}:\\s*`), "");
  const summary =
    stripped !== "" ? stripped : `${STAGE_LABELS[handoff.stage]} round ${handoff.round}`;
  return `${ticketId}: ${handoff.isInterrupted ? "WIP — " : ""}${summary}`;
}

/** Agents fence things they were told not to fence; the fence is not the message. */
function stripFences(text: string): string {
  return text.replace(/^```(?:\w+)?\s*\n?|\n?```\s*$/g, "").trim();
}

/**
 * Drop a status line or trailer the scribe wrote despite being told not to —
 * only from the end, where they live, so a body sentence that opens with the
 * tool's own name survives.
 */
function withoutPipelineMetadata(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? "";
    if (
      last.trim() !== "" &&
      !PIPELINE_TRAILER_RE.test(last) &&
      !PIPELINE_STATUS_LINE_RE.test(last)
    )
      break;
    lines.pop();
  }
  return lines.join("\n").trim();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
