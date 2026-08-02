import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 16 MiB — a full-branch `git diff` for review has to fit in one buffer. */
const MAX_GIT_OUTPUT_BYTES = 16_777_216;

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string = "",
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES });
    return stdout.trimEnd();
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new GitError(
      `git ${args.join(" ")} failed: ${failure.stderr ?? failure.message}`,
      failure.stderr ?? "",
    );
  }
}

/** git that may fail without throwing; returns exit ok + combined output. */
async function gitTry(cwd: string, ...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const output = await git(cwd, ...args);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: (error as GitError).message };
  }
}

export function repoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

export function currentBranch(repo: string): Promise<string> {
  return git(repo, "rev-parse", "--abbrev-ref", "HEAD");
}

export function revParse(repo: string, ref: string): Promise<string> {
  return git(repo, "rev-parse", ref);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await gitTry(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
  return result.ok;
}

export async function isWorkingTreeClean(repo: string): Promise<boolean> {
  return (await git(repo, "status", "--porcelain")) === "";
}

/**
 * Like isWorkingTreeClean but ignoring untracked files — the right check
 * before a fast-forward, where only tracked modifications can conflict
 * (git itself refuses if a checkout would clobber an untracked file).
 */
export async function hasTrackedChanges(repo: string): Promise<boolean> {
  return (await git(repo, "status", "--porcelain", "--untracked-files=no")) !== "";
}

/** True if `ancestor` is contained in `ref` (already-merged detection). */
export async function isAncestor(repo: string, ancestor: string, ref: string): Promise<boolean> {
  const result = await gitTry(repo, "merge-base", "--is-ancestor", ancestor, ref);
  return result.ok;
}

export interface Worktree {
  path: string;
  branch: string;
}

export function ticketBranch(ticketId: string): string {
  return `jfdi/${ticketId}`;
}

/**
 * Create a worktree for a ticket on branch jfdi/<id>, based on the target
 * branch. If the branch already exists (resume after Blocked), reuse it.
 */
export async function createWorktree(
  repo: string,
  worktreesDir: string,
  ticketId: string,
  baseBranch: string,
): Promise<Worktree> {
  const branch = ticketBranch(ticketId);
  const worktreePath = path.join(worktreesDir, ticketId);
  await fs.mkdir(worktreesDir, { recursive: true });
  // Clean up a stale registration for this path if the dir vanished.
  await gitTry(repo, "worktree", "prune");
  try {
    await fs.access(worktreePath);
    // Worktree dir already exists — reuse it (resume case).
    return { path: worktreePath, branch };
  } catch {
    // continue to create
  }
  if (await branchExists(repo, branch)) {
    await git(repo, "worktree", "add", worktreePath, branch);
  } else {
    await git(repo, "worktree", "add", "-b", branch, worktreePath, baseBranch);
  }
  return { path: worktreePath, branch };
}

export async function removeWorktree(
  repo: string,
  worktreePath: string,
  options: { shouldForce?: boolean } = {},
): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (options.shouldForce) args.push("--force");
  await gitTry(repo, ...args);
  await gitTry(repo, "worktree", "prune");
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await gitTry(repo, "branch", "-D", branch);
}

export interface RebaseResult {
  ok: boolean;
  hasConflict: boolean;
  output: string;
}

/** Rebase the worktree's branch onto `target`. On conflict the rebase is left in progress. */
export async function rebaseOnto(worktree: string, target: string): Promise<RebaseResult> {
  const result = await gitTry(worktree, "rebase", target);
  if (result.ok) return { ok: true, hasConflict: false, output: result.output };
  const hasConflict = /CONFLICT|could not apply|needs merge/i.test(result.output);
  if (!hasConflict) await gitTry(worktree, "rebase", "--abort");
  return { ok: false, hasConflict, output: result.output };
}

export async function isRebaseInProgress(worktree: string): Promise<boolean> {
  const gitDir = await git(worktree, "rev-parse", "--git-dir");
  const gitDirPath = path.isAbsolute(gitDir) ? gitDir : path.join(worktree, gitDir);
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    try {
      await fs.access(path.join(gitDirPath, marker));
      return true;
    } catch {
      // not present
    }
  }
  return false;
}

export async function abortRebase(worktree: string): Promise<void> {
  await gitTry(worktree, "rebase", "--abort");
}

/**
 * Fast-forward the target branch to the ticket branch. Works whether or not
 * the target is checked out in the main working tree:
 *  - target checked out here and tree clean → `git merge --ff-only`
 *  - target not checked out anywhere → `git branch -f` (ref update only)
 */
export async function fastForward(repo: string, target: string, branch: string): Promise<void> {
  if (!(await isAncestor(repo, target, branch)))
    throw new GitError(`cannot fast-forward ${target} to ${branch}: not a descendant`);
  const head = await currentBranch(repo);
  if (head === target) {
    if (await hasTrackedChanges(repo))
      throw new GitError(
        `target branch "${target}" is checked out with uncommitted changes; commit or stash before merging`,
      );
    await git(repo, "merge", "--ff-only", branch);
  } else {
    await git(repo, "branch", "-f", target, branch);
  }
}

/** Diff of the branch against its merge-base with target (what the reviews look at). */
export function branchDiff(worktree: string, target: string): Promise<string> {
  return git(worktree, "diff", `${target}...HEAD`);
}

export async function commitCount(worktree: string, target: string): Promise<number> {
  const output = await git(worktree, "rev-list", "--count", `${target}..HEAD`);
  const count = Number.parseInt(output, 10);
  // Subprocess output is a trust boundary: a non-numeric answer means git told
  // us something we do not understand, not that there are zero commits.
  if (!Number.isInteger(count))
    throw new GitError(`git rev-list --count returned non-numeric output: ${output}`);
  return count;
}

/** Commit anything left uncommitted in the worktree (agent safety net). */
export async function commitAllIfDirty(worktree: string, message: string): Promise<boolean> {
  if (await isWorkingTreeClean(worktree)) return false;
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-m", message);
  return true;
}
