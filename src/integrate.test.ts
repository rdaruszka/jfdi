import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, isAncestor } from "./git.js";
import { IntegrationQueue, integrateTicket } from "./integrate.js";
import { runPipeline } from "./pipeline.js";
import { commitFile, type Fixture, makeFixture, stageOf, writeVerdict } from "./test-helpers.js";
import { resolveTicket } from "./tickets.js";

let fx: Fixture;

/** Handler that sails a ticket through the pipeline (no gate configured). */
function passingHandler(file: string) {
  return async (spec: { prompt: string }, opts: { cwd: string }) => {
    const stage = stageOf(spec.prompt);
    if (stage === "implementation") {
      await commitFile(opts.cwd, file, "feature\n", `implement ${file}`);
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
  fx = await makeFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

describe("integrateTicket", () => {
  it("clean rebase → merge, cleanup, report", async () => {
    const ctx = fx.ctx(passingHandler("feat.txt"));
    const ticket = await resolveTicket("Ship feature", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Move main forward (non-conflicting) to force a real rebase.
    await commitFile(fx.repo, "other.txt", "other\n", "unrelated");

    const result = await integrateTicket(ctx, ticket, outcome.worktree, outcome.report);
    expect(result).toEqual({ status: "merged" });
    expect(await fs.readFile(path.join(fx.repo, "feat.txt"), "utf8")).toBe("feature\n");
    // Worktree removed.
    await expect(fs.access(outcome.worktree.path)).rejects.toThrow();
    // Report appended to the note.
    const note = await fs.readFile(path.join(fx.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Report");
    expect(note).toContain("built feat.txt");
    expect(note).toContain("Merged into `main`");
  });

  it("conflicting rebase: agent resolves, clean verdict → merged", async () => {
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        await commitFile(opts.cwd, "README.md", "branch version\n", "edit readme");
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "integration") {
        // Resolve the conflict like the real agent would.
        await commitFile(opts.cwd, "README.md", "merged version\n", "never used");
        // commitFile committed; but a rebase is in progress — emulate properly:
        return { ok: true, text: "" };
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Conflicting edit", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Conflicting change on main.
    await commitFile(fx.repo, "README.md", "main version\n", "main edit");

    // Swap in a proper conflict-resolving integration handler.
    const ctx2 = fx.ctx(async (spec, opts) => {
      expect(stageOf(spec.prompt)).toBe("integration");
      await fs.writeFile(path.join(opts.cwd, "README.md"), "merged version\n");
      await git(opts.cwd, "add", "README.md");
      await git(opts.cwd, "-c", "core.editor=true", "rebase", "--continue");
      await writeVerdict(spec.prompt, { resolution: "clean", notes: "kept both edits" });
      return { ok: true, text: "" };
    });
    const result = await integrateTicket(ctx2, ticket, outcome.worktree, outcome.report);
    expect(result.status).toBe("merged");
    expect(await fs.readFile(path.join(fx.repo, "README.md"), "utf8")).toBe("merged version\n");
  });

  it("complicated resolution goes back through QA before landing", async () => {
    const ctx = fx.ctx(passingHandler("feat2.txt"));
    const ticket = await resolveTicket("Complicated landing", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    await commitFile(fx.repo, "feat2.txt", "main took the name\n", "collide");

    const stages: string[] = [];
    const ctx2 = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      if (stage === "integration") {
        await fs.writeFile(path.join(opts.cwd, "feat2.txt"), "reconciled\n");
        await git(opts.cwd, "add", "-A");
        await git(opts.cwd, "-c", "core.editor=true", "rebase", "--continue");
        await writeVerdict(spec.prompt, {
          resolution: "complicated",
          notes: "had to rework logic",
        });
      } else if (stage === "qa") {
        await writeVerdict(spec.prompt, { verdict: "pass", testsAdded: "re-verified" });
      }
      return { ok: true, text: "" };
    });
    const result = await integrateTicket(ctx2, ticket, outcome.worktree, outcome.report);
    expect(result.status).toBe("merged");
    expect(stages).toEqual(["integration", "qa"]);
    expect(await fs.readFile(path.join(fx.repo, "feat2.txt"), "utf8")).toBe("reconciled\n");
  });

  it("complicated resolution with failing re-QA blocks", async () => {
    const ctx = fx.ctx(passingHandler("feat3.txt"));
    const ticket = await resolveTicket("Bad landing", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");
    await commitFile(fx.repo, "feat3.txt", "collision\n", "collide");

    const ctx2 = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      if (stage === "integration") {
        await fs.writeFile(path.join(opts.cwd, "feat3.txt"), "broken reconcile\n");
        await git(opts.cwd, "add", "-A");
        await git(opts.cwd, "-c", "core.editor=true", "rebase", "--continue");
        await writeVerdict(spec.prompt, { resolution: "complicated" });
      } else if (stage === "qa") {
        await writeVerdict(spec.prompt, { verdict: "fail", feedback: "behavior regressed" });
      }
      return { ok: true, text: "" };
    });
    const result = await integrateTicket(ctx2, ticket, outcome.worktree, outcome.report);
    expect(result.status).toBe("blocked");
    expect(await isAncestor(fx.repo, outcome.worktree.branch, "main")).toBe(false);
    const note = await fs.readFile(path.join(fx.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("behavior regressed");
  });

  it("detects a branch the human already merged and closes without double-merging", async () => {
    const ctx = fx.ctx(passingHandler("feat4.txt"));
    const ticket = await resolveTicket("Hand merged", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    // Human merges by hand.
    await git(fx.repo, "merge", "--ff-only", outcome.worktree.branch);
    const headBefore = await git(fx.repo, "rev-parse", "HEAD");

    const result = await integrateTicket(ctx, ticket, outcome.worktree, outcome.report);
    expect(result.status).toBe("already-merged");
    expect(await git(fx.repo, "rev-parse", "HEAD")).toBe(headBefore);
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
