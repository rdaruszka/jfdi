import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, isAncestor, isRebaseInProgress } from "./git.js";
import { IntegrationQueue, integrateTicket } from "./integrate.js";
import { runPipeline } from "./pipeline.js";
import { commitFile, type Fixture, makeFixture, stageOf, writeVerdict } from "./test-helpers.js";
import { resolveTicket } from "./tickets.js";

let fixture: Fixture;

/** Handler that sails a ticket through the pipeline (no gate configured). */
function passingHandler(file: string) {
  return async (spec: { prompt: string }, options: { cwd: string }) => {
    const stage = stageOf(spec.prompt);
    if (stage === "implementation") {
      await commitFile(options.cwd, file, "feature\n", `implement ${file}`);
      await writeVerdict(spec.prompt, { status: "done", summary: `built ${file}` });
    } else if (stage === "integration") {
      throw new Error("integration agent should not run for clean rebases");
    } else {
      await writeVerdict(spec.prompt, { verdict: "pass" });
    }
    return { ok: true, text: "" };
  };
}

beforeEach(async () => {
  fixture = await makeFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("integrateTicket", () => {
  it("clean rebase → merge, cleanup, report", async () => {
    const context = fixture.context(passingHandler("feat.txt"));
    const ticket = await resolveTicket("Ship feature", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Move main forward (non-conflicting) to force a real rebase.
    await commitFile(fixture.repo, "other.txt", "other\n", "unrelated");

    const result = await integrateTicket(context, ticket, outcome.worktree, outcome.report);
    expect(result).toEqual({ status: "merged" });
    expect(await fs.readFile(path.join(fixture.repo, "feat.txt"), "utf8")).toBe("feature\n");
    // Worktree removed.
    await expect(fs.access(outcome.worktree.path)).rejects.toThrow();
    // Report appended to the note.
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Report");
    expect(note).toContain("built feat.txt");
    expect(note).toContain("Merged into `main`");
  });

  it("conflicting rebase: agent resolves, clean verdict → merged", async () => {
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "README.md", "branch version\n", "edit readme");
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "integration") {
        // Resolve the conflict like the real agent would.
        await commitFile(options.cwd, "README.md", "merged version\n", "never used");
        // commitFile committed; but a rebase is in progress — emulate properly:
        return { ok: true, text: "" };
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Conflicting edit", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Conflicting change on main.
    await commitFile(fixture.repo, "README.md", "main version\n", "main edit");

    // Swap in a proper conflict-resolving integration handler.
    const integrationContext = fixture.context(async (spec, options) => {
      expect(stageOf(spec.prompt)).toBe("integration");
      await fs.writeFile(path.join(options.cwd, "README.md"), "merged version\n");
      await git(options.cwd, "add", "README.md");
      await git(options.cwd, "-c", "core.editor=true", "rebase", "--continue");
      await writeVerdict(spec.prompt, { resolution: "clean", notes: "kept both edits" });
      return { ok: true, text: "" };
    });
    const result = await integrateTicket(
      integrationContext,
      ticket,
      outcome.worktree,
      outcome.report,
    );
    expect(result.status).toBe("merged");
    expect(await fs.readFile(path.join(fixture.repo, "README.md"), "utf8")).toBe(
      "merged version\n",
    );
  });

  it("complicated resolution goes back through QA before landing", async () => {
    const context = fixture.context(passingHandler("feat2.txt"));
    const ticket = await resolveTicket("Complicated landing", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    await commitFile(fixture.repo, "feat2.txt", "main took the name\n", "collide");

    const stages: string[] = [];
    const integrationContext = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      if (stage === "integration") {
        await fs.writeFile(path.join(options.cwd, "feat2.txt"), "reconciled\n");
        await git(options.cwd, "add", "-A");
        await git(options.cwd, "-c", "core.editor=true", "rebase", "--continue");
        await writeVerdict(spec.prompt, {
          resolution: "complicated",
          notes: "had to rework logic",
        });
      } else if (stage === "qa") {
        await writeVerdict(spec.prompt, { verdict: "pass", testsAdded: "re-verified" });
      }
      return { ok: true, text: "" };
    });
    const result = await integrateTicket(
      integrationContext,
      ticket,
      outcome.worktree,
      outcome.report,
    );
    expect(result.status).toBe("merged");
    expect(stages).toEqual(["integration", "qa"]);
    expect(await fs.readFile(path.join(fixture.repo, "feat2.txt"), "utf8")).toBe("reconciled\n");
  });

  it("complicated resolution with failing re-QA blocks", async () => {
    const context = fixture.context(passingHandler("feat3.txt"));
    const ticket = await resolveTicket("Bad landing", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");
    await commitFile(fixture.repo, "feat3.txt", "collision\n", "collide");

    const integrationContext = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "integration") {
        await fs.writeFile(path.join(options.cwd, "feat3.txt"), "broken reconcile\n");
        await git(options.cwd, "add", "-A");
        await git(options.cwd, "-c", "core.editor=true", "rebase", "--continue");
        await writeVerdict(spec.prompt, { resolution: "complicated" });
      } else if (stage === "qa") {
        await writeVerdict(spec.prompt, { verdict: "fail", feedback: "behavior regressed" });
      }
      return { ok: true, text: "" };
    });
    const result = await integrateTicket(
      integrationContext,
      ticket,
      outcome.worktree,
      outcome.report,
    );
    expect(result.status).toBe("blocked");
    expect(await isAncestor(fixture.repo, outcome.worktree.branch, "main")).toBe(false);
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("behavior regressed");
  });

  it("aborts a rebase a previous integration left unfinished and re-integrates", async () => {
    const context = fixture.context(passingHandler("feat5.txt"));
    const ticket = await resolveTicket("Stale rebase", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");
    await commitFile(fixture.repo, "feat5.txt", "main version\n", "collide");

    // First attempt: the agent walks away from the conflict, leaving the rebase open.
    const abandoningContext = fixture.context(async (spec) => {
      await writeVerdict(spec.prompt, { resolution: "clean", notes: "gave up" });
      return { ok: true, text: "" };
    });
    const first = await integrateTicket(
      abandoningContext,
      ticket,
      outcome.worktree,
      outcome.report,
    );
    expect(first.status).toBe("blocked");
    expect(await isRebaseInProgress(outcome.worktree.path)).toBe(true);

    // Re-dispatch: the stale rebase is aborted, so this is a normal conflicted
    // integration rather than "rebase already in progress".
    const resolvingContext = fixture.context(async (spec, options) => {
      expect(stageOf(spec.prompt)).toBe("integration");
      await fs.writeFile(path.join(options.cwd, "feat5.txt"), "reconciled\n");
      await git(options.cwd, "add", "-A");
      await git(options.cwd, "-c", "core.editor=true", "rebase", "--continue");
      await writeVerdict(spec.prompt, { resolution: "clean", notes: "kept both" });
      return { ok: true, text: "" };
    });
    const second = await integrateTicket(
      resolvingContext,
      ticket,
      outcome.worktree,
      outcome.report,
    );
    expect(second).toEqual({ status: "merged" });
    expect(await fs.readFile(path.join(fixture.repo, "feat5.txt"), "utf8")).toBe("reconciled\n");
  });

  it("detects a branch the human already merged and closes without double-merging", async () => {
    const context = fixture.context(passingHandler("feat4.txt"));
    const ticket = await resolveTicket("Hand merged", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    // Human merges by hand.
    await git(fixture.repo, "merge", "--ff-only", outcome.worktree.branch);
    const headBefore = await git(fixture.repo, "rev-parse", "HEAD");

    const result = await integrateTicket(context, ticket, outcome.worktree, outcome.report);
    expect(result.status).toBe("already-merged");
    expect(await git(fixture.repo, "rev-parse", "HEAD")).toBe(headBefore);
  });
});

describe("IntegrationQueue", () => {
  it("serializes jobs strictly in order", async () => {
    const queue = new IntegrationQueue();
    const order: number[] = [];
    const jobs = [1, 2, 3].map((n) =>
      queue.enqueue(async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 3 * (4 - n)));
        order.push(n * 10);
        return n;
      }),
    );
    const results = await Promise.all(jobs);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("keeps running after a job rejects", async () => {
    const queue = new IntegrationQueue();
    await expect(queue.enqueue(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await queue.enqueue(async () => "still alive")).toBe("still alive");
  });
});
