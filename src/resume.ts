import * as path from "node:path";
import { abortRebase, commitAllIfDirty, commitCount, git, isRebaseInProgress } from "./git.js";
import { atomicWrite, readIfExists } from "./util/fsx.js";

/**
 * One round's feedback. Carried between rounds of a run and — persisted as
 * history.json — into the next run of the same ticket, so a re-dispatch knows
 * why the interrupted attempt failed.
 */
export interface FeedbackItem {
  /** Which run-<k> produced it; a resumed run seeds history from the previous run. */
  run: number;
  round: number;
  source: "implementation" | "gate" | "code-review" | "qa";
  feedback: string;
}

/** Newest commits quoted into the resume section — enough to orient, not the whole branch. */
const MAX_SUMMARY_COMMITS = 10;

/** What an interrupted attempt left behind, after the worktree was sanitized. */
export interface ResumeState {
  /** Commits the branch already holds ahead of the target branch. */
  commitCount: number;
  /** `git log --oneline` of the newest commits, newest first. */
  recentCommits: string;
  hasAbortedRebase: boolean;
  hasCheckpointedChanges: boolean;
}

/**
 * Sanitize a worktree an interrupted run may have left mid-flight, and report
 * what was found. Any in-progress rebase is aborted and any dirty state is
 * checkpoint-committed *before* the first session, so the agent always starts
 * from a clean, committed tree. Returns null for a genuinely fresh ticket —
 * nothing to resume, and the implementation prompt stays as it was.
 */
export async function prepareResume(
  worktreePath: string,
  targetBranch: string,
  ticketId: string,
): Promise<ResumeState | null> {
  const hasAbortedRebase = await isRebaseInProgress(worktreePath);
  if (hasAbortedRebase) await abortRebase(worktreePath);
  const hasCheckpointedChanges = await commitAllIfDirty(
    worktreePath,
    `jfdi(${ticketId}): recovered from interrupted run`,
  );
  const count = await commitCount(worktreePath, targetBranch);
  if (count === 0 && !hasAbortedRebase && !hasCheckpointedChanges) return null;
  const recentCommits = await git(
    worktreePath,
    "log",
    "--oneline",
    "--no-decorate",
    `--max-count=${MAX_SUMMARY_COMMITS}`,
    `${targetBranch}..HEAD`,
  );
  return { commitCount: count, recentCommits, hasAbortedRebase, hasCheckpointedChanges };
}

/** The implementation prompt's RESUME_SECTION: empty for a fresh ticket. */
export function formatResumeSection(
  resume: ResumeState | null,
  branch: string,
  targetBranch: string,
): string {
  if (resume === null) return "";
  const commits = `${resume.commitCount} commit${resume.commitCount === 1 ? "" : "s"}`;
  const parts = [
    "\n## Resuming an interrupted attempt\n",
    `This ticket was attempted before and the attempt did not finish. Branch \`${branch}\` already holds ${commits} of partial work. Review what is there and continue it — do not start over, and do not redo work that is already done.\n`,
  ];
  if (resume.recentCommits)
    parts.push(`Commits so far (newest first):\n\n\`\`\`\n${resume.recentCommits}\n\`\`\`\n`);
  if (resume.hasCheckpointedChanges)
    parts.push(
      'The interrupted session left uncommitted changes; they were committed as "recovered from interrupted run" before this session started. Treat that commit as unreviewed work that may be incomplete or broken.\n',
    );
  if (resume.hasAbortedRebase)
    parts.push(
      `An in-progress rebase onto \`${targetBranch}\` was aborted before this session started; the branch is back at its pre-rebase state.\n`,
    );
  parts.push(
    `Inspect the state with \`git log ${targetBranch}..HEAD\` and \`git diff ${targetBranch}...HEAD\` before writing any code.\n`,
  );
  return `${parts.join("\n")}\n`;
}

function historyPath(runDir: string): string {
  return path.join(runDir, "history.json");
}

/**
 * Newest items kept when a run's unfinished feedback is written. A run that
 * ends blocked carries what it inherited forward, so a chain of runs that each
 * escalate without ever completing a round would otherwise grow the list — and
 * the whole list is rendered into the next implementation prompt.
 */
const MAX_CARRIED_FEEDBACK_ITEMS = 10;

/**
 * Persist a run's unfinished feedback — the rounds a later dispatch still has
 * to answer. The in-memory history dies with the process, so it is written as
 * rounds complete; a run that finishes writes an empty list, because its
 * earlier rounds were addressed. Round verdicts stay on disk either way.
 */
export async function saveFeedbackHistory(runDir: string, history: FeedbackItem[]): Promise<void> {
  const kept = history.slice(-MAX_CARRIED_FEEDBACK_ITEMS);
  await atomicWrite(historyPath(runDir), `${JSON.stringify(kept, null, 2)}\n`);
}

/**
 * Every `FeedbackItem["source"]`, as a runtime lookup. Keyed by the union so
 * adding a source without adding it here fails the build rather than silently
 * making loaded history reject it.
 */
const FEEDBACK_SOURCES: Record<FeedbackItem["source"], true> = {
  implementation: true,
  gate: true,
  "code-review": true,
  qa: true,
};

// history.json is our own file, but a crashed write or a hand edit can leave
// anything there, and the renderer of the feedback section dereferences every
// field. Check the shape before believing it.
function isFeedbackItem(value: unknown): value is FeedbackItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.run === "number" &&
    typeof record.round === "number" &&
    typeof record.feedback === "string" &&
    // `hasOwn`, not `in`: `in` walks the prototype chain, so a corrupt item
    // carrying source "toString" would pass.
    typeof record.source === "string" &&
    Object.hasOwn(FEEDBACK_SOURCES, record.source)
  );
}

/**
 * Read a previous run's feedback rounds. A missing, truncated or mangled file
 * reads as no history: the resumed run loses the *why* but still runs, which
 * beats refusing to dispatch over an unreadable log.
 */
export async function loadFeedbackHistory(runDir: string): Promise<FeedbackItem[]> {
  const content = await readIfExists(historyPath(runDir));
  if (content === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: unknown[] = parsed;
  return items.every(isFeedbackItem) ? items : [];
}
