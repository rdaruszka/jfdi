/**
 * Mechanical context the pipeline injects into stage prompts, so sessions
 * start with the facts they would otherwise burn turns fetching: the change
 * under review, what moved since a stage last looked, and why it moved.
 */
import { git } from "./git.js";
import type { FeedbackItem } from "./resume.js";

/**
 * Largest diff inlined into a review prompt. Bigger changes fall back to
 * commits + diffstat with an instruction to read the diff per file — inlining
 * an arbitrarily large diff would blow the session's context for no gain.
 */
const MAX_INLINE_DIFF_CHARS = 40_000;

export interface ChangeContext {
  /** `git log --oneline` of the branch's commits over the target. */
  commitLog: string;
  /** `git diff --stat` against the target branch. */
  diffStat: string;
  /** The full diff fenced for the prompt, or a pointer when it is too large. */
  diffSection: string;
  headCommit: string;
}

/** Everything a fresh reviewer fetches first, collected once by the pipeline. */
export async function collectChangeContext(
  worktreePath: string,
  targetBranch: string,
): Promise<ChangeContext> {
  const commitLog = await git(worktreePath, "log", "--oneline", `${targetBranch}..HEAD`);
  const diffStat = await git(worktreePath, "diff", "--stat", `${targetBranch}...HEAD`);
  const diff = await git(worktreePath, "diff", `${targetBranch}...HEAD`);
  const headCommit = await git(worktreePath, "rev-parse", "HEAD");
  const diffSection =
    diff.length <= MAX_INLINE_DIFF_CHARS
      ? `Full diff against \`${targetBranch}\`:\n\n\`\`\`diff\n${diff}\n\`\`\``
      : `The full diff is too large to inline (${diff.length} chars). Read it per file with \`git diff ${targetBranch}...HEAD -- <path>\`.`;
  return { commitLog, diffStat, diffSection, headCommit };
}

export interface StageDelta {
  /** Commits added since the stage last saw the branch. */
  newCommits: string;
  /** Files those commits touched. */
  touchedFiles: string;
}

/** What changed since `sinceCommit` — the continued stage's catch-up brief. */
export async function collectStageDelta(
  worktreePath: string,
  sinceCommit: string,
): Promise<StageDelta> {
  const newCommits = await git(worktreePath, "log", "--oneline", `${sinceCommit}..HEAD`);
  const touchedFiles = await git(worktreePath, "diff", "--name-only", `${sinceCommit}..HEAD`);
  return { newCommits, touchedFiles };
}

const CONTINUATION_FEEDBACK_HEADERS: Record<FeedbackItem["source"], string> = {
  implementation: "Your previous session ended without completing its report:",
  gate: "After your session ended, the mechanical gate failed on your commit:",
  "code-review": "Code review examined your branch and failed it with this feedback:",
  qa: "QA exercised the behavior and failed it with this feedback:",
};

/** The "what happened" section of a continued implementation session's prompt. */
export function formatContinuationFeedback(item: FeedbackItem): string {
  return `${CONTINUATION_FEEDBACK_HEADERS[item.source]}\n\n${item.feedback}`;
}

/**
 * Tell a continued reviewer why the branch moved. A reviewer who passed the
 * last round would otherwise read new commits as the author second-guessing
 * its sign-off, when they actually answer QA or a gate failure.
 */
export function formatReviewProvenance(previousFailure: FeedbackItem): string {
  switch (previousFailure.source) {
    case "code-review":
      return "The new commits respond to the feedback YOU gave when you failed the previous round. Verify each item was actually addressed — do not re-litigate what you already passed.";
    case "qa":
      return `Note: you PASSED your previous review; nothing here second-guesses it. The new commits respond to QA, which failed the round with this feedback:\n\n${previousFailure.feedback}`;
    case "gate":
      return "Note: the most recent commits fix a mechanical gate failure that appeared after your last review; earlier new commits (if any) respond to prior round feedback.";
    case "implementation":
      return "Note: the previous implementation session had to be re-run; the commits since your last review are its completed work.";
  }
}

/** Same catch-up framing for a continued QA session. */
export function formatQaProvenance(previousFailure: FeedbackItem): string {
  switch (previousFailure.source) {
    case "qa":
      return "The new commits respond to the failures YOU reported. Your previous feedback is the checklist: verify each reported failure is actually fixed, and re-run enough of your earlier checks to catch regressions.";
    case "gate":
      return "Note: you PASSED your previous validation, but the mechanical gate then failed on the committed state (this can include the tests you committed). Re-validate the revised branch.";
    case "code-review":
      return "Note: since your last look the branch changed to address code-review feedback. Re-validate the behavior against the ticket.";
    case "implementation":
      return "Note: the previous implementation session had to be re-run; re-validate its completed work against the ticket.";
  }
}
