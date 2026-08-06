import * as fs from "node:fs/promises";
import * as path from "node:path";
import { abortMerge, commitAllIfDirty, commitCount, git, isMergeInProgress } from "./git.js";
import { atomicWrite, readIfExists } from "./util/fsx.js";

/**
 * A run killed between an agent's in-worktree verdict write and the pipeline's
 * collection leaves `<stage>.verdict.json` at the worktree root; checkpoint-
 * committing it would land run state in the branch. Removed before the dirty
 * check, never preserved — an uncollected verdict belongs to a session whose
 * round is already lost.
 */
async function removeStrayVerdicts(worktreePath: string): Promise<void> {
  const entries = await fs.readdir(worktreePath);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".verdict.json"))
      .map((entry) => fs.rm(path.join(worktreePath, entry))),
  );
}

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
  hasAbortedMerge: boolean;
  hasCheckpointedChanges: boolean;
}

/**
 * Sanitize a worktree an interrupted run may have left mid-flight, and report
 * what was found. Any in-progress merge (what an abandoned integration leaves)
 * is aborted and any dirty state is checkpoint-committed *before* the first
 * session, so the agent always starts from a clean, committed tree. Returns
 * null for a genuinely fresh ticket — nothing to resume, and the
 * implementation prompt stays as it was.
 *
 * Throws if the merge cannot be aborted: dispatching on a half-merged tree
 * would hand the agent conflict markers and checkpoint-commit them, so the run
 * fails loudly instead (the card lands in Blocked with the git failure).
 */
export async function prepareResume(
  worktreePath: string,
  targetBranch: string,
  ticketId: string,
): Promise<ResumeState | null> {
  const hasAbortedMerge = await isMergeInProgress(worktreePath);
  if (hasAbortedMerge) await abortMerge(worktreePath);
  await removeStrayVerdicts(worktreePath);
  const hasCheckpointedChanges = await commitAllIfDirty(
    worktreePath,
    `jfdi(${ticketId}): recovered from interrupted run`,
  );
  const count = await commitCount(worktreePath, targetBranch);
  if (count === 0 && !hasAbortedMerge && !hasCheckpointedChanges) return null;
  const recentCommits = await git(
    worktreePath,
    "log",
    "--oneline",
    "--no-decorate",
    `--max-count=${MAX_SUMMARY_COMMITS}`,
    `${targetBranch}..HEAD`,
  );
  return { commitCount: count, recentCommits, hasAbortedMerge, hasCheckpointedChanges };
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
  if (resume.hasAbortedMerge)
    parts.push(
      `An in-progress merge of \`${targetBranch}\` into this branch was aborted before this session started; the branch is back at its pre-merge state.\n`,
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

interface DroppedFeedbackMarker {
  type: "dropped-feedback";
  /** The run that produced the feedback removed by the cap. */
  run: number;
  droppedItemCount: number;
}

type FeedbackHistoryEntry = FeedbackItem | DroppedFeedbackMarker;

/** A tool-owned history.json violated the shape saveFeedbackHistory writes. */
export class FeedbackHistoryError extends Error {
  constructor(
    readonly filePath: string,
    readonly failure: string,
    readonly offendingContent: string,
  ) {
    super(`malformed feedback history at ${filePath}: ${failure}`);
    this.name = "FeedbackHistoryError";
  }
}

/**
 * Persist a run's unfinished feedback — the rounds a later dispatch still has
 * to answer. The in-memory history dies with the process, so it is written as
 * rounds complete; a run that finishes writes an empty list, because its
 * earlier rounds were addressed. Round verdicts stay on disk either way.
 */
export async function saveFeedbackHistory(runDir: string, history: FeedbackItem[]): Promise<void> {
  const dropped = history.slice(0, -MAX_CARRIED_FEEDBACK_ITEMS);
  const kept = history.slice(-MAX_CARRIED_FEEDBACK_ITEMS);
  const droppedCountsByRun = new Map<number, number>();
  for (const item of dropped) {
    droppedCountsByRun.set(item.run, (droppedCountsByRun.get(item.run) ?? 0) + 1);
  }
  const markers: DroppedFeedbackMarker[] = [...droppedCountsByRun].map(
    ([run, droppedItemCount]) => ({
      type: "dropped-feedback",
      run,
      droppedItemCount,
    }),
  );
  const entries: FeedbackHistoryEntry[] = [...markers, ...kept];
  await atomicWrite(historyPath(runDir), `${JSON.stringify(entries, null, 2)}\n`);
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

function isDroppedFeedbackMarker(value: unknown): value is DroppedFeedbackMarker {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "dropped-feedback" &&
    typeof record.run === "number" &&
    typeof record.droppedItemCount === "number"
  );
}

/** Read a previous run's feedback rounds. Missing is empty; malformed blocks the caller. */
export async function loadFeedbackHistory(runDir: string): Promise<FeedbackItem[]> {
  const filePath = historyPath(runDir);
  const content = await readIfExists(filePath);
  if (content === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new FeedbackHistoryError(
      filePath,
      `JSON parse failed: ${(error as Error).message}`,
      content,
    );
  }
  if (!Array.isArray(parsed))
    throw new FeedbackHistoryError(filePath, "top-level value is not an array", content);
  const entries: unknown[] = parsed;
  for (const [index, entry] of entries.entries()) {
    if (!isFeedbackItem(entry) && !isDroppedFeedbackMarker(entry))
      throw new FeedbackHistoryError(
        filePath,
        `entry at index ${index} is not a feedback item or dropped-feedback marker`,
        JSON.stringify(entry, null, 2),
      );
  }
  return entries.filter(isFeedbackItem);
}
