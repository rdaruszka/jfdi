import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPipeline } from "./pipeline.js";
import { commitFile, type Fixture, makeFixture, stageOf, writeVerdict } from "./test-helpers.js";
import { resolveTicket } from "./tickets.js";

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeFixture({
    gate: [{ name: "check", cmd: "test -f impl.txt" }],
  });
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("runPipeline", () => {
  it("happy path: implementation → gate → code review → QA → passed", async () => {
    const stages: string[] = [];
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      switch (stage) {
        case "implementation":
          await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
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
          await commitFile(options.cwd, "e2e.test.txt", "regression\n", "qa tests");
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

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(stages).toEqual(["implementation", "code-review", "qa"]);
    expect(outcome.report.rounds).toBe(1);
    expect(outcome.report.summary).toBe("implemented the feature");
    expect(outcome.report.testsAdded).toBe("one regression test");

    // Decisions recorded in the ticket note.
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Decisions");
    expect(note).toContain("flat file instead of a db");

    // Both commits are on the branch.
    expect(await fs.readFile(path.join(outcome.worktree.path, "e2e.test.txt"), "utf8")).toBe(
      "regression\n",
    );
  });

  it("writes run artifacts to the state directory and worktrees to .jfdi/", async () => {
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
        await writeVerdict(spec.prompt, { status: "done", summary: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Round artifacts (verdicts, logs) live outside the project checkout…
    const roundDir = path.join(fixture.stateDir, "runs", ticket.id, "run-1", "round-1");
    expect(await fs.readdir(roundDir)).toContain("implementation.verdict.json");
    // …and nothing put a runs/ directory back inside .jfdi/.
    await expect(fs.readdir(path.join(fixture.jfdiDir, "runs"))).rejects.toThrow();
    // Worktrees are unchanged: still in-project, still gitignored.
    expect(outcome.worktree.path).toBe(path.join(fixture.jfdiDir, "worktrees", ticket.id));
  });

  it("code review failure skips QA and feeds back into round 2", async () => {
    const stages: string[] = [];
    let implementationRounds = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      switch (stage) {
        case "implementation":
          implementationRounds++;
          if (implementationRounds === 2) {
            // The fix round must see the reviewer's feedback.
            expect(spec.prompt).toContain("Feedback on earlier attempts");
            expect(spec.prompt).toContain("rename the helper");
          }
          await commitFile(
            options.cwd,
            "impl.txt",
            `v${implementationRounds}\n`,
            `implement v${implementationRounds}`,
          );
          await writeVerdict(spec.prompt, {
            status: "done",
            summary: `round ${implementationRounds}`,
          });
          break;
        case "code-review":
          await writeVerdict(
            spec.prompt,
            implementationRounds === 1
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

    const ticket = await resolveTicket("Iterate on review", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
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
    let implementationRounds = 0;
    const stages: string[] = [];
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      stages.push(stage);
      if (stage === "implementation") {
        implementationRounds++;
        if (implementationRounds === 2) expect(spec.prompt).toContain("Mechanical gate failed");
        // Round 1 forgets impl.txt → gate fails; round 2 fixes it.
        await commitFile(
          options.cwd,
          implementationRounds === 1 ? "wrong.txt" : "impl.txt",
          "x\n",
          `attempt ${implementationRounds}`,
        );
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Gate learner", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    expect(stages).toEqual(["implementation", "implementation", "code-review", "qa"]);
  });

  it("escalation blocks the ticket and writes Questions with a recommendation", async () => {
    const context = fixture.context(async (spec) => {
      await writeVerdict(spec.prompt, {
        status: "escalate",
        question: "Should auth use OAuth or magic links?",
        recommendation: "Magic links — no third-party dependency.",
      });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Ambiguous auth ticket", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("blocked");
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Questions");
    expect(note).toContain("OAuth or magic links");
    expect(note).toContain("Magic links — no third-party dependency.");
    const blockedEvents = context.log.snapshot().tickets[ticket.id];
    expect(blockedEvents?.status).toBe("blocked");
  });

  it("exhausted rounds block with accumulated history in the note", async () => {
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", `${Math.random()}\n`, "try");
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(spec.prompt, { verdict: "fail", feedback: "still not good enough" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Never good enough", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toContain("retries exhausted");
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("retries exhausted");
    expect(note).toContain("still not good enough");
  });

  it("mode: ask lowers the escalation bar in the implementation prompt", async () => {
    await fs.writeFile(
      path.join(fixture.ticketsDir, "careful.md"),
      "---\nmode: ask\n---\n\nDo the careful thing.\n",
    );
    let sawOverride = false;
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        sawOverride = spec.prompt.includes("Escalation override");
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("[[careful]]", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    expect(sawOverride).toBe(true);
  });

  it("a session that never writes a verdict burns a round with feedback", async () => {
    let implementationCalls = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        implementationCalls++;
        if (implementationCalls === 1) return { ok: false, text: "crashed mid-flight" };
        expect(spec.prompt).toContain("crashed mid-flight");
        await commitFile(options.cwd, "impl.txt", "ok\n", "implement");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Flaky session", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    expect(implementationCalls).toBe(2);
  });
});
