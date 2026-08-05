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
 *
 * Everything that reaches a commit message here comes from outside the
 * pipeline: the scribe's answer is subprocess output, the completing stage's
 * summary is agent verdict text, and an interrupted session's outcome quotes
 * that session's own output back. All of it is about to become permanent
 * repository history, so `assembleCommitMessage` treats the lot as a trust
 * boundary: the shipped contract's limits are enforced here, not asked for in
 * the prompt and hoped for. Every bound below is a rule the message must
 * satisfy no matter what came back.
 */
import type { StageName } from "./events.js";
import { git } from "./git.js";
import type { SessionUsage } from "./harness/types.js";
import { STAGE_LABELS, statusLine } from "./transitions.js";
import { COST_ESTIMATE_NOTE, formatCostUsd, formatDurationMs } from "./usage.js";

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
  /** What the session cost and took — rendered into the JFDI-Cost/JFDI-Duration trailers. */
  usage: SessionUsage;
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
 * Longest summary the shipped contract allows in a subject — git's own
 * convention, and what the commit-message template asks for. The pipeline adds
 * the `<ticket-id>: ` prefix on top, so this bounds the scribe's half alone.
 * A longer first line is not a subject the scribe shortened badly; it is a
 * scribe that ignored the format, so the whole answer is treated as body text
 * and the subject falls back to the pipeline's own.
 */
const MAX_SUBJECT_SUMMARY_CHARS = 72;

/**
 * Longest body kept from the scribe. A scribe that echoed the diff back would
 * otherwise write a megabyte into every `git log`; the cut is loud (it ends in
 * a marker) rather than silent.
 */
const MAX_BODY_CHARS = 8_000;

/** What a truncated body ends with, so a reader knows the message is not all there. */
const BODY_TRUNCATION_MARKER = "\n\n[commit message truncated by JFDI]";

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
    STAGE_SUMMARY:
      handoff.summary.trim().slice(0, MAX_SUMMARY_CHARS) || "(the session recorded none)",
    STAGED_DIFF: commitContext.stagedDiff,
    RECENT_LOG: commitContext.recentLog,
  };
}

/**
 * The final message: the scribe's subject and body under a ticket-id subject
 * prefix, over the status line and the round trailer.
 *
 * Three of the fragments here are external, not just the scribe's answer: the
 * handoff's `summary` is agent verdict text, and its `outcome` can quote a dead
 * session's own output. All three are scrubbed, the ones that must stay on one
 * line are flattened to one, and the assembled message is scrubbed once more at
 * the end — so the guarantee is about the message, not about remembering to
 * treat each new fragment as external.
 */
export function assembleCommitMessage(
  scribeText: string,
  ticketId: string,
  handoff: SessionHandoff,
): string {
  const written = withoutPipelineMetadata(stripFences(scrubControlCharacters(scribeText)));
  const lines = written.length > 0 ? written.split("\n") : [];
  const summary = subjectSummary(ticketId, lines[0] ?? "");
  const subject = `${ticketId}: ${handoff.isInterrupted ? "WIP — " : ""}${
    summary ?? `${STAGE_LABELS[handoff.stage]} round ${handoff.round}`
  }`;
  // A first line the scribe overran is not a subject it wrote badly; it is
  // prose that landed where the subject belongs. It stays, as body, under the
  // pipeline's own subject — dropping it would throw away the only account of
  // the change there is.
  const writtenBody = summary === null ? written : lines.slice(1).join("\n");
  const fallbackBody = scrubControlCharacters(handoff.summary);
  const body = boundBody((writtenBody.trim() !== "" ? writtenBody : fallbackBody).trim());
  // The status line is one line by definition: a reason quoted from a dead
  // session's output would otherwise wrap onto a line of its own. It is NOT
  // part of the trailer paragraph: git only treats the last paragraph as a
  // trailer block when every line in it is trailer-shaped, so the status line
  // sharing a paragraph with `JFDI-Round:` would make the trailer invisible
  // to `git log --format='%(trailers:…)'`.
  const status = statusLine(
    handoff.stage,
    flattenToLine(handoff.outcome),
    flattenToLine(handoff.routing),
  );
  // One all-trailer paragraph, every line trailer-shaped, so git parses the
  // block: JFDI-Cost/JFDI-Duration join JFDI-Round here, never in the prose.
  const trailers = [
    `JFDI-Round: ${handoff.round}/${handoff.maxRounds}`,
    `JFDI-Duration: ${formatDurationMs(handoff.usage.durationMs)}`,
    `JFDI-Cost: ${trailerCost(handoff.usage)}`,
  ].join("\n");
  const message = `${[subject, body, status, trailers].filter((part) => part !== "").join("\n\n")}\n`;
  // Belt and braces over every fragment at once: newlines survive this, so the
  // shape above is untouched and a fragment nobody scrubbed still cannot put a
  // NUL — which `git commit -m` rejects outright — into repository history.
  return scrubControlCharacters(message);
}

/**
 * The JFDI-Cost value: dollars when priced, a token count when the price is
 * unknown. A Codex figure is a table estimate that runs low, so it says so in a
 * brief parenthetical; a Claude figure is provider-reported and stands alone.
 */
function trailerCost(usage: SessionUsage): string {
  const cost = formatCostUsd(usage.costUsd, usage.inputTokens + usage.outputTokens);
  return usage.isCostEstimated ? `${cost} (${COST_ESTIMATE_NOTE})` : cost;
}

/**
 * One line, whatever came in: control characters gone and every run of
 * whitespace — newlines included — collapsed to a single space.
 */
function flattenToLine(text: string): string {
  return scrubControlCharacters(text).replace(/\s+/g, " ").trim();
}

/**
 * The scribe's subject, or null when what it wrote cannot be one: empty, or
 * longer than the contract's bound. The `<ticket-id>: ` prefix is the
 * pipeline's to add, so a scribe that added it too is not punished for it.
 */
function subjectSummary(ticketId: string, written: string): string | null {
  const stripped = written.trim().replace(new RegExp(`^${escapeForRegExp(ticketId)}:\\s*`), "");
  if (stripped === "" || stripped.length > MAX_SUBJECT_SUMMARY_CHARS) return null;
  return stripped;
}

/** Cut a body no reader would finish, and say that it was cut. */
function boundBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS).trimEnd()}${BODY_TRUNCATION_MARKER}`;
}

/** Code point below which every character is a C0 control. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;
/** DEL, the one control character that sits above the printable range. */
const DELETE_CODE_POINT = 0x7f;

/**
 * Strip what a commit message must not carry. A NUL byte makes `git commit -m`
 * fail outright, and a terminal escape sequence in a message is a hazard for
 * every later `git log` — neither is something an agent should be able to put
 * into repository history by writing it. Tabs and newlines are legitimate text
 * and are the only control characters kept; a CRLF is normalized rather than
 * left to split a line in two.
 */
function scrubControlCharacters(text: string): string {
  const kept: string[] = [];
  for (const character of text.replace(/\r\n?/g, "\n")) {
    const code = character.codePointAt(0) ?? 0;
    const isControl =
      (code < FIRST_PRINTABLE_CODE_POINT && character !== "\n" && character !== "\t") ||
      code === DELETE_CODE_POINT;
    if (!isControl) kept.push(character);
  }
  return kept.join("");
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
