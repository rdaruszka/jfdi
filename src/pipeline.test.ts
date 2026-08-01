import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPipeline } from "./pipeline.js";
import { commitFile, type Fixture, makeFixture, stageOf, writeVerdict } from "./test-helpers.js";
import { resolveTicket } from "./tickets.js";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture({
    gate: [{ name: "check", cmd: "test -f impl.txt" }],
  });
});

afterEach(async () => {
  await fx.cleanup();
});

describe("runPipeline", () => {
  it("happy path: implementation → gate → code review → QA → passed", async () => {
    const stages: string[] = [];
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      switch (stage) {
        case "implementation":
          await commitFile(opts.cwd, "impl.txt", "the feature\n", "implement");
          await writeVerdict(spec.prompt, {
            status: "done",
            summary: "implemented the feature",
            decisions: ["used a flat file instead of a db"],
          });
          break;
        case "code-review":
          await writeVerdict(spec.prompt, { verdict: "pass" });
          break;
        case "qa":
          await commitFile(opts.cwd, "e2e.test.txt", "regression\n", "qa tests");
          await writeVerdict(spec.prompt, {
            verdict: "pass",
            testsAdded: "one regression test",
          });
          break;
        default:
          throw new Error(`unexpected stage ${stage}`);
      }
      return { ok: true, text: `${stage} done` };
    });

    const ticket = await resolveTicket("Build the feature", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(stages).toEqual(["implementation", "code-review", "qa"]);
    expect(outcome.report.rounds).toBe(1);
    expect(outcome.report.summary).toBe("implemented the feature");
    expect(outcome.report.testsAdded).toBe("one regression test");

    // Decisions recorded in the ticket note.
    const note = await fs.readFile(path.join(fx.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Decisions");
    expect(note).toContain("flat file instead of a db");

    // Both commits are on the branch.
    expect(await fs.readFile(path.join(outcome.worktree.path, "e2e.test.txt"), "utf8")).toBe(
      "regression\n",
    );
  });

  it("code review failure skips QA and feeds back into round 2", async () => {
    const stages: string[] = [];
    let implRounds = 0;
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      switch (stage) {
        case "implementation":
          implRounds++;
          if (implRounds === 2) {
            // The fix round must see the reviewer's feedback.
            expect(spec.prompt).toContain("Feedback on earlier attempts");
            expect(spec.prompt).toContain("rename the helper");
          }
          await commitFile(opts.cwd, "impl.txt", `v${implRounds}\n`, `implement v${implRounds}`);
          await writeVerdict(spec.prompt, { status: "done", summary: `round ${implRounds}` });
          break;
        case "code-review":
          await writeVerdict(
            spec.prompt,
            implRounds === 1
              ? { verdict: "fail", feedback: "rename the helper; split the god function" }
              : { verdict: "pass" },
          );
          break;
        case "qa":
          await writeVerdict(spec.prompt, { verdict: "pass" });
          break;
        default:
          throw new Error("unexpected");
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Iterate on review", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    // Round 1: CR fail → QA never ran. Round 2: full pass.
    expect(stages).toEqual([
      "implementation",
      "code-review",
      "implementation",
      "code-review",
      "qa",
    ]);
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(2);
  });

  it("gate failure short-circuits reviews and feeds output back", async () => {
    let implRounds = 0;
    const stages: string[] = [];
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      if (stage === "implementation") {
        implRounds++;
        if (implRounds === 2) expect(spec.prompt).toContain("Mechanical gate failed");
        // Round 1 forgets impl.txt → gate fails; round 2 fixes it.
        await commitFile(
          opts.cwd,
          implRounds === 1 ? "wrong.txt" : "impl.txt",
          "x\n",
          `attempt ${implRounds}`,
        );
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Gate learner", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    expect(stages).toEqual(["implementation", "implementation", "code-review", "qa"]);
  });

  it("escalation blocks the ticket and writes Questions with a recommendation", async () => {
    const ctx = fx.ctx(async (spec) => {
      await writeVerdict(spec.prompt, {
        status: "escalate",
        question: "Should auth use OAuth or magic links?",
        recommendation: "Magic links — no third-party dependency.",
      });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Ambiguous auth ticket", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("blocked");
    const note = await fs.readFile(path.join(fx.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Questions");
    expect(note).toContain("OAuth or magic links");
    expect(note).toContain("Magic links — no third-party dependency.");
    const blockedEvents = ctx.log.snapshot().tickets[ticket.id];
    expect(blockedEvents?.status).toBe("blocked");
  });

  it("exhausted rounds block with accumulated history in the note", async () => {
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        await commitFile(opts.cwd, "impl.txt", `${Math.random()}\n`, "try");
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(spec.prompt, { verdict: "fail", feedback: "still not good enough" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Never good enough", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toContain("retries exhausted");
    const note = await fs.readFile(path.join(fx.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("retries exhausted");
    expect(note).toContain("still not good enough");
  });

  it("mode: ask lowers the escalation bar in the implementation prompt", async () => {
    await fs.writeFile(
      path.join(fx.ticketsDir, "careful.md"),
      "---\nmode: ask\n---\n\nDo the careful thing.\n",
    );
    let sawOverride = false;
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        sawOverride = spec.prompt.includes("Escalation override");
        await commitFile(opts.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("[[careful]]", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    expect(sawOverride).toBe(true);
  });

  it("a session that never writes a verdict burns a round with feedback", async () => {
    let implCalls = 0;
    const ctx = fx.ctx(async (spec, opts) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        implCalls++;
        if (implCalls === 1) return { ok: false, text: "crashed mid-flight" };
        expect(spec.prompt).toContain("crashed mid-flight");
        await commitFile(opts.cwd, "impl.txt", "ok\n", "implement");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Flaky session", fx.ticketsDir);
    const outcome = await runPipeline(ctx, ticket);
    expect(outcome.status).toBe("passed");
    expect(implCalls).toBe(2);
  });
});
