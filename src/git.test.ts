import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  branchExists,
  commitAllIfDirty,
  commitCount,
  createWorktree,
  currentBranch,
  fastForward,
  GitError,
  git,
  isAncestor,
  rebaseInProgress,
  rebaseOnto,
  removeWorktree,
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
    await removeWorktree(repo, worktree.path, { force: true });
    await expect(fs.access(worktree.path)).rejects.toThrow();
    // Branch survives removal (kept for inspection until merged).
    expect(await branchExists(repo, "jfdi/gone")).toBe(true);
  });
});

describe("rebase and merge", () => {
  it("clean rebase onto a moved target, then fast-forward when target not checked out elsewhere", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "feat", "main");
    await write(worktree.path, "feat.txt", "feature\n");
    await commit(worktree.path, "feat");
    // Move main forward with a non-conflicting change.
    await write(repo, "other.txt", "other\n");
    await commit(repo, "other");

    const rebase = await rebaseOnto(worktree.path, "main");
    expect(rebase).toMatchObject({ ok: true, conflict: false });
    expect(await commitCount(worktree.path, "main")).toBe(1);

    // main is checked out in the primary worktree and clean → ff merge.
    await fastForward(repo, "main", "jfdi/feat");
    expect(await isAncestor(repo, "jfdi/feat", "main")).toBe(true);
    expect(await fs.readFile(path.join(repo, "feat.txt"), "utf8")).toBe("feature\n");
  });

  it("detects conflicts and leaves the rebase in progress for the agent", async () => {
    const worktree = await createWorktree(repo, worktreesDir, "clash", "main");
    await write(worktree.path, "README.md", "branch version\n");
    await commit(worktree.path, "branch edit");
    await write(repo, "README.md", "main version\n");
    await commit(repo, "main edit");

    const rebase = await rebaseOnto(worktree.path, "main");
    expect(rebase.ok).toBe(false);
    expect(rebase.conflict).toBe(true);
    expect(await rebaseInProgress(worktree.path)).toBe(true);
    // Resolve as the integration agent would.
    await write(worktree.path, "README.md", "merged version\n");
    await git(worktree.path, "add", "README.md");
    await git(worktree.path, "-c", "core.editor=true", "rebase", "--continue");
    expect(await rebaseInProgress(worktree.path)).toBe(false);
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
