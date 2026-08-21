import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  git,
  isMergeInProgress,
  mergeTargetIntoBranch,
  type Worktree,
} from "./git.js";
import {
  type FeedbackItem,
  formatResumeSection,
  loadFeedbackHistory,
  prepareResume,
  saveFeedbackHistory,
} from "./resume.js";
import { commitFile, type Fixture, makeFixture } from "./test-helpers.js";

let fixture: Fixture;
let worktree: Worktree;

beforeEach(async () => {
  fixture = await makeFixture();
  worktree = await createWorktree(
    fixture.projectRoot,
    path.join(fixture.jfdiDirectory, "worktrees"),
    "ticket",
    "main",
  );
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("prepareResume", () => {
  it("reports nothing to resume for a freshly created worktree", async () => {
    expect(await prepareResume(worktree.path, "main", "ticket")).toBeNull();
  });

  it("summarizes commits the interrupted run already made", async () => {
    await commitFile(worktree.path, "partial.txt", "half\n", "start the feature");
    const resume = await prepareResume(worktree.path, "main", "ticket");
    expect(resume?.commitCount).toBe(1);
    expect(resume?.recentCommits).toContain("start the feature");
    expect(resume?.hasCheckpointedChanges).toBe(false);
    expect(resume?.hasAbortedMerge).toBe(false);
  });

  it("checkpoint-commits what a killed session left uncommitted", async () => {
    await fs.writeFile(path.join(worktree.path, "scratch.txt"), "half-written\n");
    const resume = await prepareResume(worktree.path, "main", "ticket");
    expect(resume?.hasCheckpointedChanges).toBe(true);
    expect(await git(worktree.path, "status", "--porcelain")).toBe("");
    expect(await git(worktree.path, "log", "-1", "--format=%s")).toBe(
      "jfdi(ticket): recovered from interrupted run",
    );
    expect(resume?.commitCount).toBe(1);
  });

  it("discards a stray agent verdict instead of checkpoint-committing run state", async () => {
    // A run killed between the agent's in-worktree verdict write and the
    // pipeline's collection leaves this file; it must never reach the branch.
    await fs.writeFile(
      path.join(worktree.path, "implementation.verdict.json"),
      '{"status":"done"}',
    );
    const resume = await prepareResume(worktree.path, "main", "ticket");
    expect(resume).toBeNull();
    await expect(
      fs.access(path.join(worktree.path, "implementation.verdict.json")),
    ).rejects.toThrow();
  });

  it("aborts a merge the interrupted run left in progress", async () => {
    await commitFile(worktree.path, "shared.txt", "branch version\n", "branch edit");
    await commitFile(fixture.projectRoot, "shared.txt", "main version\n", "main edit");
    const merge = await mergeTargetIntoBranch(worktree.path, "main");
    expect(merge.hasConflict).toBe(true);
    expect(await isMergeInProgress(worktree.path)).toBe(true);

    const resume = await prepareResume(worktree.path, "main", "ticket");
    expect(resume?.hasAbortedMerge).toBe(true);
    expect(await isMergeInProgress(worktree.path)).toBe(false);
    // Pre-merge state restored: the branch's own commit is back and intact.
    expect(await fs.readFile(path.join(worktree.path, "shared.txt"), "utf8")).toBe(
      "branch version\n",
    );
  });

  /**
   * Sanitizing is what earns the "clean, committed tree" promise the resume
   * section makes. A merge git cannot abort (here a stale `index.lock`) must
   * stop the dispatch, not get checkpoint-committed with its conflict markers
   * and announced to the agent as recovered.
   */
  it("refuses to resume when the in-progress merge cannot be aborted", async () => {
    await commitFile(worktree.path, "shared.txt", "branch version\n", "branch edit");
    await commitFile(fixture.projectRoot, "shared.txt", "main version\n", "main edit");
    expect((await mergeTargetIntoBranch(worktree.path, "main")).hasConflict).toBe(true);
    const gitDirectory = await git(worktree.path, "rev-parse", "--absolute-git-dir");
    await fs.writeFile(path.join(gitDirectory, "index.lock"), "");

    await expect(prepareResume(worktree.path, "main", "ticket")).rejects.toThrow(
      /could not abort the merge in progress/,
    );

    // No checkpoint commit over the conflicted tree, and the merge still stands.
    expect(await git(worktree.path, "log", "-1", "--format=%s")).toBe("branch edit");
    expect(await isMergeInProgress(worktree.path)).toBe(true);
  });
});

describe("formatResumeSection", () => {
  it("is empty for a fresh ticket", () => {
    expect(formatResumeSection(null, "jfdi/ticket", "main")).toBe("");
  });

  it("tells the agent to continue the existing work, with the commit summary", async () => {
    await commitFile(worktree.path, "partial.txt", "half\n", "start the feature");
    const resume = await prepareResume(worktree.path, "main", "ticket");
    const section = formatResumeSection(resume, "jfdi/ticket", "main");
    expect(section).toContain("Resuming an interrupted attempt");
    expect(section).toContain("1 commit of partial work");
    expect(section).toContain("start the feature");
    expect(section).toContain("do not start over");
    // Nothing was recovered or aborted, so neither is claimed.
    expect(section).not.toContain("recovered from interrupted run");
    expect(section).not.toContain("was aborted");
  });

  it("names the recovery steps it took", async () => {
    await commitFile(worktree.path, "shared.txt", "branch version\n", "branch edit");
    await commitFile(fixture.projectRoot, "shared.txt", "main version\n", "main edit");
    await mergeTargetIntoBranch(worktree.path, "main");
    await fs.writeFile(path.join(worktree.path, "scratch.txt"), "half-written\n");

    const section = formatResumeSection(
      await prepareResume(worktree.path, "main", "ticket"),
      "jfdi/ticket",
      "main",
    );
    expect(section).toContain("recovered from interrupted run");
    expect(section).toContain("merge of `main` into this branch was aborted");
  });
});

describe("feedback history", () => {
  const items: FeedbackItem[] = [
    { run: 1, round: 2, source: "code-review", feedback: "rename the helper" },
  ];

  it("round-trips through the run directory", async () => {
    await saveFeedbackHistory(fixture.stateDirectory, items);
    expect(await loadFeedbackHistory(fixture.stateDirectory)).toEqual(items);
  });

  it("records feedback dropped by the carry cap and its originating run", async () => {
    const cappedItems: FeedbackItem[] = [
      { run: 7, round: 1, source: "qa", feedback: "oldest" },
      { run: 7, round: 2, source: "gate", feedback: "second oldest" },
      { run: 8, round: 1, source: "implementation", feedback: "third oldest" },
      ...Array.from({ length: 10 }, (_, index) => ({
        run: 9,
        round: index + 1,
        source: "code-review" as const,
        feedback: `kept ${index + 1}`,
      })),
    ];

    await saveFeedbackHistory(fixture.stateDirectory, cappedItems);

    const saved = JSON.parse(
      await fs.readFile(path.join(fixture.stateDirectory, "history.json"), "utf8"),
    );
    expect(saved).toEqual([
      { type: "dropped-feedback", run: 7, droppedItemCount: 2 },
      { type: "dropped-feedback", run: 8, droppedItemCount: 1 },
      ...cappedItems.slice(3),
    ]);
    expect(await loadFeedbackHistory(fixture.stateDirectory)).toEqual(cappedItems.slice(3));
  });

  it("reads as empty when absent", async () => {
    expect(await loadFeedbackHistory(path.join(fixture.stateDirectory, "never-ran"))).toEqual([]);
  });

  it("rejects a mangled file rather than feeding junk to the next run", async () => {
    const historyFile = path.join(fixture.stateDirectory, "history.json");
    await fs.mkdir(fixture.stateDirectory, { recursive: true });

    await fs.writeFile(historyFile, "{ truncated");
    await expect(loadFeedbackHistory(fixture.stateDirectory)).rejects.toThrow(
      `malformed feedback history at ${historyFile}: JSON parse failed`,
    );

    const malformedItem = { run: 1, round: 1, source: "toString" };
    await fs.writeFile(historyFile, JSON.stringify([items[0], malformedItem]));
    await expect(loadFeedbackHistory(fixture.stateDirectory)).rejects.toMatchObject({
      filePath: historyFile,
      failure: "entry at index 1 is not a feedback item or dropped-feedback marker",
      offendingContent: JSON.stringify(malformedItem, null, 2),
    });

    await fs.writeFile(historyFile, JSON.stringify({ round: 1 }));
    await expect(loadFeedbackHistory(fixture.stateDirectory)).rejects.toThrow(
      "top-level value is not an array",
    );
  });
});
