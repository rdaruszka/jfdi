import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(" ")} failed: ${e.stderr ?? e.message}`, e.stderr ?? "");
  }
}

/** git that may fail without throwing; returns exit ok + combined output. */
async function gitTry(cwd: string, ...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const out = await git(cwd, ...args);
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, output: (err as GitError).message };
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

export async function currentBranch(repo: string): Promise<string> {
  return git(repo, "rev-parse", "--abbrev-ref", "HEAD");
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return git(repo, "rev-parse", ref);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await gitTry(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
  return r.ok;
}

export async function isWorkingTreeClean(repo: string): Promise<boolean> {
  return (await git(repo, "status", "--porcelain")) === "";
}

/** True if `ancestor` is contained in `ref` (already-merged detection). */
export async function isAncestor(repo: string, ancestor: string, ref: string): Promise<boolean> {
  const r = await gitTry(repo, "merge-base", "--is-ancestor", ancestor, ref);
  return r.ok;
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
  const wtPath = path.join(worktreesDir, ticketId);
  await fs.mkdir(worktreesDir, { recursive: true });
  // Clean up a stale registration for this path if the dir vanished.
  await gitTry(repo, "worktree", "prune");
  try {
    await fs.access(wtPath);
    // Worktree dir already exists — reuse it (resume case).
    return { path: wtPath, branch };
  } catch {
    // continue to create
  }
  if (await branchExists(repo, branch)) {
    await git(repo, "worktree", "add", wtPath, branch);
  } else {
    await git(repo, "worktree", "add", "-b", branch, wtPath, baseBranch);
  }
  return { path: wtPath, branch };
}

export async function removeWorktree(
  repo: string,
  wtPath: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const args = ["worktree", "remove", wtPath];
  if (opts.force) args.push("--force");
  await gitTry(repo, ...args);
  await gitTry(repo, "worktree", "prune");
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await gitTry(repo, "branch", "-D", branch);
}

export interface RebaseResult {
  ok: boolean;
  conflict: boolean;
  output: string;
}

/** Rebase the worktree's branch onto `target`. On conflict the rebase is left in progress. */
export async function rebaseOnto(worktree: string, target: string): Promise<RebaseResult> {
  const r = await gitTry(worktree, "rebase", target);
  if (r.ok) return { ok: true, conflict: false, output: r.output };
  const conflict = /CONFLICT|could not apply|needs merge/i.test(r.output);
  if (!conflict) await gitTry(worktree, "rebase", "--abort");
  return { ok: false, conflict, output: r.output };
}

export async function rebaseInProgress(worktree: string): Promise<boolean> {
  const gitDir = await git(worktree, "rev-parse", "--git-dir");
  const abs = path.isAbsolute(gitDir) ? gitDir : path.join(worktree, gitDir);
  for (const d of ["rebase-merge", "rebase-apply"]) {
    try {
      await fs.access(path.join(abs, d));
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
    if (!(await isWorkingTreeClean(repo)))
      throw new GitError(
        `target branch "${target}" is checked out with uncommitted changes; commit or stash before merging`,
      );
    await git(repo, "merge", "--ff-only", branch);
  } else {
    await git(repo, "branch", "-f", target, branch);
  }
}

/** Diff of the branch against its merge-base with target (what the reviews look at). */
export async function branchDiff(worktree: string, target: string): Promise<string> {
  return git(worktree, "diff", `${target}...HEAD`);
}

export async function commitCount(worktree: string, target: string): Promise<number> {
  const out = await git(worktree, "rev-list", "--count", `${target}..HEAD`);
  return Number.parseInt(out, 10);
}

/** Commit anything left uncommitted in the worktree (agent safety net). */
export async function commitAllIfDirty(worktree: string, message: string): Promise<boolean> {
  if (await isWorkingTreeClean(worktree)) return false;
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-m", message);
  return true;
}
