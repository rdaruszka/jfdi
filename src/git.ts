import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileExists, withPathLock } from "./util/fsx.js";

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
 * Every command that writes `<repo>/.git/worktrees/` runs under this key.
 *
 * `git worktree add` walks the entries already registered there while it
 * registers its own, and reads each one's `commondir`. A sibling `add` that has
 * created its entry directory but not yet written that file makes the walk fail
 * outright — `fatal: failed to read .git/worktrees/<other>/commondir` — and the
 * whole command exits non-zero. `remove`/`prune` delete the same entries a
 * concurrent `add` is reading. None of this is a corner case: the coordinator
 * dispatches up to `max_concurrent` cards from a single scan, so two adds on
 * one repo is the ordinary path, and the loser's run died with a git error
 * nothing in the pipeline could interpret.
 */
function worktreeRegistryKey(repo: string): string {
  return path.join(repo, ".git", "worktrees");
}

/**
 * Create a worktree for a ticket on branch jfdi/<id>, based on the target
 * branch. If the branch already exists (resume after Blocked), reuse it.
 */
export function createWorktree(
  repo: string,
  worktreesDir: string,
  ticketId: string,
  baseBranch: string,
): Promise<Worktree> {
  const branch = ticketBranch(ticketId);
  const worktreePath = path.join(worktreesDir, ticketId);
  return withPathLock(worktreeRegistryKey(repo), async () => {
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
  });
}

export function removeWorktree(
  repo: string,
  worktreePath: string,
  options: { shouldForce?: boolean } = {},
): Promise<void> {
  return withPathLock(worktreeRegistryKey(repo), async () => {
    const args = ["worktree", "remove", worktreePath];
    if (options.shouldForce) args.push("--force");
    await gitTry(repo, ...args);
    await gitTry(repo, "worktree", "prune");
  });
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await gitTry(repo, "branch", "-D", branch);
}

export interface MergeResult {
  ok: boolean;
  hasConflict: boolean;
  output: string;
}

/**
 * Merge `target` into the worktree's branch, so the merged state can be built
 * and tested where the run already lives. On conflict the merge is left in
 * progress for the Integration agent to resolve.
 */
export async function mergeTargetIntoBranch(
  worktree: string,
  target: string,
): Promise<MergeResult> {
  const result = await gitTry(worktree, "merge", "--no-edit", target);
  if (result.ok) return { ok: true, hasConflict: false, output: result.output };
  // git reports conflicts on stdout, which a failed run does not hand back, so
  // the merge state is the signal rather than the text: MERGE_HEAD exists only
  // for a merge git stopped mid-flight. Any other failure — a gone worktree, a
  // dirty tree, an unknown ref — started nothing, so there is nothing to undo.
  const hasConflict = (await fileExists(worktree)) && (await isMergeInProgress(worktree));
  return { ok: false, hasConflict, output: result.output };
}

export async function isMergeInProgress(worktree: string): Promise<boolean> {
  const gitDir = await git(worktree, "rev-parse", "--git-dir");
  const gitDirPath = path.isAbsolute(gitDir) ? gitDir : path.join(worktree, gitDir);
  try {
    await fs.access(path.join(gitDirPath, "MERGE_HEAD"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo a merge left in progress, restoring the pre-merge state. A failure here
 * is not survivable by the caller — the tree is still half-merged, so whatever
 * was about to use it (an agent session, a landing commit) would run over
 * conflict markers — so it throws rather than reporting an abort that did not
 * happen.
 */
export async function abortMerge(worktree: string): Promise<void> {
  try {
    await git(worktree, "merge", "--abort");
  } catch (error) {
    const failure = error as GitError;
    throw new GitError(
      `could not abort the merge in progress in ${worktree}: ${failure.message}; clear the worktree by hand (a stale index.lock or an unwritable file is the usual cause) before running this ticket again`,
      failure.stderr,
    );
  }
}

/**
 * An object name — the only thing `git commit-tree` may answer with. 40 hex
 * digits in a sha1 repository, 64 in a sha256 one.
 */
const OBJECT_NAME_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Build the landing merge commit for the tree currently at HEAD in `worktree` —
 * the tree the gate just ran against. `firstParent` is the target's prior head
 * and `secondParent` the signed-off branch head, in that order, so
 * `git log --first-parent <target>` keeps following the target line and the
 * signed-off commit stays reachable. Returns the new commit's sha; no ref moves.
 */
export async function commitMerge(
  worktree: string,
  parents: { firstParent: string; secondParent: string },
  message: string,
): Promise<string> {
  const tree = await git(worktree, "rev-parse", "HEAD^{tree}");
  const sha = await git(
    worktree,
    "commit-tree",
    tree,
    "-p",
    parents.firstParent,
    "-p",
    parents.secondParent,
    "-m",
    message,
  );
  // Subprocess output is a trust boundary, and this sha is about to become the
  // target branch: anything but an object name means git did not commit.
  if (!OBJECT_NAME_RE.test(sha))
    throw new GitError(
      `git commit-tree returned "${sha}" instead of a commit sha for tree ${tree} in ${worktree}`,
    );
  return sha;
}

/**
 * Fast-forward the target branch to `commitish` — the landing merge commit,
 * built with the target's current head as its first parent. The descendant
 * check is what makes the update safe: a target that moved since that commit
 * was built is not an ancestor of it, so nothing is overwritten. Works whether
 * or not the target is checked out in the main working tree:
 *  - target checked out here and tree clean → `git merge --ff-only`
 *  - target not checked out anywhere → `git branch -f` (ref update only)
 */
export async function fastForward(repo: string, target: string, commitish: string): Promise<void> {
  if (!(await isAncestor(repo, target, commitish)))
    throw new GitError(`cannot fast-forward ${target} to ${commitish}: not a descendant`);
  const head = await currentBranch(repo);
  if (head === target) {
    if (await hasTrackedChanges(repo))
      throw new GitError(
        `target branch "${target}" is checked out with uncommitted changes; commit or stash before merging`,
      );
    await git(repo, "merge", "--ff-only", commitish);
  } else {
    await git(repo, "branch", "-f", target, commitish);
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
