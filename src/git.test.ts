import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortMerge,
  branchExists,
  commitAllIfDirty,
  commitCount,
  commitMerge,
  createWorktree,
  currentBranch,
  fastForward,
  GitError,
  git,
  isAncestor,
  isMergeInProgress,
  mergeTargetIntoBranch,
  removeWorktree,
  revParse,
  ticketBranch,
} from "./git.js";

// Fixtures live under the OS temp dir — never inside a parent git repo
// (Claude Code and git both walk up the tree; iteration 1 got bitten).
let root: string;
let repo: string;
let worktreesDir: string;

async function write(repoDir: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
  await fs.writeFile(path.join(repoDir, file), content);
}

async function commit(repoDir: string, message: string): Promise<void> {
  await git(repoDir, "add", "-A");
  await git(repoDir, "commit", "-m", message);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-git-"));
  repo = path.join(root, "repo");
  worktreesDir = path.join(root, "worktrees");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@jfdi.local");
  await git(repo, "config", "user.name", "JFDI Test");
  await write(repo, "README.md", "hello\n");
  await commit(repo, "initial");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("worktrees", () => {
  it("creates a worktree on a fresh jfdi/<id> branch from the base", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "my-ticket", "main");
    expect(worktree.branch).toBe(ticketBranch("my-ticket"));
    expect(await currentBranch(worktree.path)).toBe("jfdi/my-ticket");
    expect(await fs.readFile(path.join(worktree.path, "README.md"), "utf8")).toBe("hello\n");
  });

  /**
   * The coordinator dispatches up to `max_concurrent` cards from one scan, so
   * several `createWorktree` calls on one repo start together. `git worktree
   * add` reads every entry already under `.git/worktrees/` while registering
   * its own, so a sibling still writing its entry made the whole command fail
   * ("failed to read .git/worktrees/<other>/commondir") and killed that run.
   *
   * These two pin the observable contract — every concurrent caller gets a
   * registered worktree. They cannot pin the serialization itself: the git
   * window is a few syscalls wide and only loses the race on a loaded
   * filesystem, so a test that demanded a failure without the lock would be
   * the flaky kind. `withPathLock`'s own tests are the deterministic guard.
   */
  it("creates concurrent worktrees on one repo without them tripping over each other", async () => {
    const ticketIds = ["alpha", "beta", "gamma", "delta"];
    const worktrees = await Promise.all(
      ticketIds.map((ticketId) => createWorktree(repo, worktreesDir, ticketId, "main")),
    );

    expect(worktrees.map((worktree) => worktree.branch)).toEqual(ticketIds.map(ticketBranch));
    for (const worktree of worktrees) {
      expect(await currentBranch(worktree.path)).toBe(ticketBranch(path.basename(worktree.path)));
    }
    // git agrees they are all registered, not just that the directories exist.
    const registered = await git(repo, "worktree", "list", "--porcelain");
    for (const ticketId of ticketIds) expect(registered).toContain(ticketBranch(ticketId));
  });

  it("removes a worktree while another is being created on the same repo", async () => {
    const doomed = await createWorktree(repo, worktreesDir, "doomed", "main");
    // remove and add write the same registry; neither may see the other's
    // half-written entry.
    const [, created] = await Promise.all([
      removeWorktree(repo, doomed.path),
      createWorktree(repo, worktreesDir, "survivor", "main"),
    ]);
    expect(await currentBranch(created.path)).toBe(ticketBranch("survivor"));
    const registered = await git(repo, "worktree", "list", "--porcelain");
    expect(registered).toContain(ticketBranch("survivor"));
    expect(registered).not.toContain(ticketBranch("doomed"));
  });

  it("reuses an existing branch and worktree on resume", async () => {
    const worktree1 = await createWorktree(repo, worktreesDir, "t", "main");
    await write(worktree1.path, "work.txt", "wip\n");
    await commit(worktree1.path, "wip");
    const worktree2 = await createWorktree(repo, worktreesDir, "t", "main");
    expect(worktree2.path).toBe(worktree1.path);
    expect(await fs.readFile(path.join(worktree2.path, "work.txt"), "utf8")).toBe("wip\n");
  });

  it("removes a worktree", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "gone", "main");
    await removeWorktree(repo, worktree.path, { shouldForce: true });
    await expect(fs.access(worktree.path)).rejects.toThrow();
    // Branch survives removal (kept for inspection until merged).
    expect(await branchExists(repo, "jfdi/gone")).toBe(true);
  });
});

describe("merge and land", () => {
  it("clean merge of a moved target, then lands a merge commit with the target first", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "feat", "main");
    await write(worktree.path, "feat.txt", "feature\n");
    await commit(worktree.path, "feat");
    const signedOff = await revParse(repo, "jfdi/feat");
    // Move main forward with a non-conflicting change.
    await write(repo, "other.txt", "other\n");
    await commit(repo, "other");
    const targetHead = await revParse(repo, "main");
    expect(await commitCount(worktree.path, "main")).toBe(1);

    const merge = await mergeTargetIntoBranch(worktree.path, "main");
    expect(merge).toMatchObject({ ok: true, hasConflict: false });
    const testedTree = await git(worktree.path, "rev-parse", "HEAD^{tree}");

    const landing = await commitMerge(
      worktree.path,
      { firstParent: targetHead, secondParent: signedOff },
      "Merge jfdi/feat into main",
    );
    // main is checked out in the primary worktree and clean → ff merge.
    await fastForward(repo, "main", landing);

    expect(await revParse(repo, "main")).toBe(landing);
    expect(await git(repo, "rev-parse", "main^1")).toBe(targetHead);
    expect(await git(repo, "rev-parse", "main^2")).toBe(signedOff);
    expect(await git(repo, "rev-parse", "main^{tree}")).toBe(testedTree);
    expect(await isAncestor(repo, signedOff, "main")).toBe(true);
    expect(await fs.readFile(path.join(repo, "feat.txt"), "utf8")).toBe("feature\n");
    expect(await fs.readFile(path.join(repo, "other.txt"), "utf8")).toBe("other\n");
  });

  it("lands a merge commit even when the target could fast-forward", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "noff", "main");
    await write(worktree.path, "only.txt", "only\n");
    await commit(worktree.path, "only");
    const signedOff = await revParse(repo, "jfdi/noff");
    const targetHead = await revParse(repo, "main");

    // Target has not moved: nothing to merge, but the landing shape is uniform.
    const merge = await mergeTargetIntoBranch(worktree.path, "main");
    expect(merge.ok).toBe(true);
    expect(await revParse(worktree.path, "HEAD")).toBe(signedOff);

    const landing = await commitMerge(
      worktree.path,
      { firstParent: targetHead, secondParent: signedOff },
      "Merge jfdi/noff into main",
    );
    await fastForward(repo, "main", landing);

    expect(await git(repo, "rev-list", "--count", "--first-parent", `${targetHead}..main`)).toBe(
      "1",
    );
    expect(await git(repo, "rev-parse", "main^2")).toBe(signedOff);
  });

  it("detects conflicts and leaves the merge in progress for the agent", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "clash", "main");
    await write(worktree.path, "README.md", "branch version\n");
    await commit(worktree.path, "branch edit");
    const signedOff = await revParse(repo, "jfdi/clash");
    await write(repo, "README.md", "main version\n");
    await commit(repo, "main edit");

    const merge = await mergeTargetIntoBranch(worktree.path, "main");
    expect(merge.ok).toBe(false);
    expect(merge.hasConflict).toBe(true);
    expect(await isMergeInProgress(worktree.path)).toBe(true);
    // A conflicted merge commits nothing: the signed-off tip is untouched.
    expect(await revParse(repo, "jfdi/clash")).toBe(signedOff);
    // Resolve as the integration agent would.
    await write(worktree.path, "README.md", "merged version\n");
    await git(worktree.path, "add", "README.md");
    await git(worktree.path, "commit", "--no-edit");
    expect(await isMergeInProgress(worktree.path)).toBe(false);
  });

  it("aborts a conflicted merge losslessly", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "abandoned", "main");
    await write(worktree.path, "README.md", "branch version\n");
    await commit(worktree.path, "branch edit");
    const signedOff = await revParse(repo, "jfdi/abandoned");
    await write(repo, "README.md", "main version\n");
    await commit(repo, "main edit");
    expect((await mergeTargetIntoBranch(worktree.path, "main")).hasConflict).toBe(true);

    await abortMerge(worktree.path);

    expect(await isMergeInProgress(worktree.path)).toBe(false);
    expect(await revParse(repo, "jfdi/abandoned")).toBe(signedOff);
    expect(await fs.readFile(path.join(worktree.path, "README.md"), "utf8")).toBe(
      "branch version\n",
    );
  });

  it("fastForward refuses non-descendants", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "diverged", "main");
    await write(worktree.path, "a.txt", "a\n");
    await commit(worktree.path, "a");
    await write(repo, "b.txt", "b\n");
    await commit(repo, "b");
    await expect(fastForward(repo, "main", "jfdi/diverged")).rejects.toThrow(GitError);
  });

  it("fastForward refuses when target checkout is dirty", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "clean-req", "main");
    await write(worktree.path, "c.txt", "c\n");
    await commit(worktree.path, "c");
    await write(repo, "README.md", "uncommitted local edit\n");
    await expect(fastForward(repo, "main", "jfdi/clean-req")).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it("already-merged detection via isAncestor", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "dup", "main");
    await write(worktree.path, "d.txt", "d\n");
    await commit(worktree.path, "d");
    await fastForward(repo, "main", "jfdi/dup");
    // A second merge attempt would see the branch already contained.
    expect(await isAncestor(repo, "jfdi/dup", "main")).toBe(true);
  });
});

describe("commitAllIfDirty", () => {
  it("commits leftover changes and reports true", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "dirty", "main");
    await write(worktree.path, "left.txt", "over\n");
    expect(await commitAllIfDirty(worktree.path, "jfdi: checkpoint")).toBe(true);
    expect(await commitAllIfDirty(worktree.path, "jfdi: checkpoint")).toBe(false);
  });
});
