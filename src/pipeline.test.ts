import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JfdiConfig } from "./config.js";
import type { JfdiEvent, StageName } from "./events.js";
import { createWorktree, git, isMergeInProgress, mergeTargetIntoBranch } from "./git.js";
import type { SessionKind } from "./harness/index.js";
import { type PipelineContext, runHeldSession, runPipeline } from "./pipeline.js";
import {
  commitFile,
  DEFAULT_SCRIBE_HANDLER,
  type FakeHandler,
  FakeHarness,
  type Fixture,
  makeFixture,
  sessionKindOf,
  steppingClock,
  TEST_PAUSE_DELAYS,
  usageFor,
  verdictPathOf,
  writeVerdict,
} from "./test-helpers.js";
import { parseTicketNote } from "./ticket-note.js";
import { resolveTicket } from "./tickets.js";

let fixture: Fixture;

function scriptedReviewVerdict(verdict: string, feedback: string): Record<string, string> {
  return verdict === "fail" ? { verdict, feedback } : { verdict: "pass" };
}

beforeEach(async () => {
  fixture = await makeFixture({
    gate: [{ name: "check", command: "test -f impl.txt" }],
  });
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("runHeldSession", () => {
  it("returns and tallies synthesized usage when the provider omits it", async () => {
    const context = fixture.context(() => Promise.resolve({ ok: true, text: "done" }));
    context.now = steppingClock(37);

    const result = await runHeldSession(
      context,
      "usage-required",
      "implementation",
      "prompt",
      { cwd: fixture.projectRoot },
      () => undefined,
    );

    expect(result.usage).toEqual({
      durationMs: 37,
      costUsd: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(context.usage.of("usage-required").totals()).toEqual({
      sessions: 1,
      durationMs: 37,
      costUsd: null,
      totalTokens: 0,
    });
  });
});

describe("runPipeline", () => {
  it("locks a stage agent at first fire while later stages adopt saved settings", async () => {
    let context: PipelineContext;
    let implementationCalls = 0;
    let reviewCalls = 0;
    const replacementImplementation = new FakeHarness(() => {
      throw new Error("replacement implementation must not take over an active run");
    });
    const replacementReview = new FakeHarness(async (prompt) => {
      reviewCalls += 1;
      await writeVerdict(
        prompt,
        reviewCalls === 1
          ? { verdict: "fail", feedback: "adjust the implementation" }
          : { verdict: "pass" },
      );
      return { ok: true, text: "", sessionId: "replacement-review" };
    });
    const originalImplementation = new FakeHarness(async (prompt, options) => {
      implementationCalls += 1;
      await fs.writeFile(
        path.join(options.cwd, "impl.txt"),
        `implementation ${implementationCalls}\n`,
      );
      await writeVerdict(prompt, { status: "done", summary: "implemented" });
      if (implementationCalls === 1) {
        context.config = {
          ...context.config,
          stages: {
            ...context.config.stages,
            implementation: { harness: "codex", model: "replacement-implementation" },
            "code-review": { harness: "claude", model: "replacement-review" },
          },
        };
        context.harnesses = {
          ...context.harnesses,
          implementation: replacementImplementation,
          "code-review": replacementReview,
        };
      }
      return { ok: true, text: "", sessionId: "original-implementation" };
    });
    const originalReview = new FakeHarness(() => {
      throw new Error("the not-yet-fired review should adopt replacement settings");
    });
    const qa = new FakeHarness(async (prompt) => {
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    context = fixture.context(() => Promise.resolve({ ok: true, text: "" }));
    context.config = {
      ...context.config,
      pipeline: { maxRejections: { "code-review": 1, qa: 0 } },
      stages: {
        ...context.config.stages,
        implementation: { harness: "claude", model: "original-implementation" },
        "code-review": { harness: "codex", model: "original-review" },
      },
    };
    context.harnesses = {
      ...context.harnesses,
      implementation: originalImplementation,
      "code-review": originalReview,
      qa,
    };
    const starts: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "stage_start") starts.push(event);
    });

    const ticket = await resolveTicket("Lock stage settings", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");

    expect(originalImplementation.calls).toHaveLength(2);
    expect(replacementImplementation.calls).toHaveLength(0);
    expect(originalReview.calls).toHaveLength(0);
    expect(replacementReview.calls).toHaveLength(2);
    expect(
      starts
        .filter((event) => event.data?.stage === "implementation")
        .map((event) => event.data?.model),
    ).toEqual(["original-implementation", "original-implementation"]);
    expect(
      starts
        .filter((event) => event.data?.stage === "code-review")
        .map((event) => event.data?.model),
    ).toEqual(["replacement-review", "replacement-review"]);
  });

  it("keeps a stage's first-fire settings for its later rounds when the config changes after it fires", async () => {
    // The other half of the lock: a stage that has ALREADY fired must not adopt
    // a settings change made mid-run — its round 2 continues with the harness
    // and selection round 1 started with, because a continuation id is only
    // meaningful to the harness that minted it.
    let context: PipelineContext;
    let reviewCalls = 0;
    const replacementReview = new FakeHarness(() => {
      throw new Error("an already-fired review must not adopt a later settings change");
    });
    const originalReview = new FakeHarness(async (prompt) => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        // The save lands after code review has fired once this run.
        context.config = {
          ...context.config,
          stages: {
            ...context.config.stages,
            "code-review": { harness: "claude", model: "replacement-review" },
          },
        };
        context.harnesses = { ...context.harnesses, "code-review": replacementReview };
        await writeVerdict(prompt, { verdict: "fail", feedback: "adjust the implementation" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "", sessionId: "original-review" };
    });
    let implementationCalls = 0;
    const implementation = new FakeHarness(async (prompt, options) => {
      implementationCalls += 1;
      await fs.writeFile(
        path.join(options.cwd, "impl.txt"),
        `implementation ${implementationCalls}\n`,
      );
      await writeVerdict(prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "", sessionId: "original-implementation" };
    });
    const qa = new FakeHarness(async (prompt) => {
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    context = fixture.context(() => Promise.resolve({ ok: true, text: "" }));
    context.config = {
      ...context.config,
      pipeline: { maxRejections: { "code-review": 1, qa: 0 } },
      stages: {
        ...context.config.stages,
        "code-review": { harness: "codex", model: "original-review" },
      },
    };
    context.harnesses = { ...context.harnesses, implementation, "code-review": originalReview, qa };
    const starts: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "stage_start") starts.push(event);
    });

    const ticket = await resolveTicket("Keep first-fire review settings", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");

    // Round 2's review continued with the round-1 harness; the replacement the
    // mid-run save installed was never consulted, and both stage_start events
    // still name the original selection.
    expect(originalReview.calls).toHaveLength(2);
    expect(replacementReview.calls).toHaveLength(0);
    expect(
      starts
        .filter((event) => event.data?.stage === "code-review")
        .map((event) => event.data?.model),
    ).toEqual(["original-review", "original-review"]);
  });

  it("happy path: implementation → gate → code review → QA → passed", async () => {
    const stages: string[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      stages.push(stage);
      switch (stage) {
        case "implementation":
          await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
          await writeVerdict(prompt, {
            status: "done",
            summary: "implemented the feature",
            decisions: ["used a flat file instead of a db"],
          });
          break;
        case "code-review":
          await writeVerdict(prompt, { verdict: "pass" });
          break;
        case "qa":
          await commitFile(options.cwd, "e2e.test.txt", "regression\n", "qa tests");
          await writeVerdict(prompt, {
            verdict: "pass",
            testsAdded: "one regression test",
          });
          break;
        default:
          throw new Error(`unexpected stage ${stage}`);
      }
      return { ok: true, text: `${stage} done` };
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(stages).toEqual(["implementation", "code-review", "qa"]);
    expect(outcome.report.rounds).toBe(1);
    expect(outcome.report.summary).toBe("implemented the feature");
    expect(outcome.report.testsAdded).toBe("one regression test");

    // Decisions are folded into the stage's single comment.
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Comments");
    expect(note).toContain("### ");
    expect(note).toContain("— Implementation round 1 complete");
    expect(note).toContain("Decisions:\n> - used a flat file instead of a db");
    expect(note).toContain("flat file instead of a db");

    // Both commits are on the branch.
    expect(await fs.readFile(path.join(outcome.worktree.path, "e2e.test.txt"), "utf8")).toBe(
      "regression\n",
    );
  });

  it("records exactly one complete comment for each stage in a clean round", async () => {
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
        await writeVerdict(prompt, {
          status: "done",
          summary: "implemented the feature",
          decisions: ["kept the implementation deliberately small"],
        });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, {
          verdict: "pass",
          decisions: ["confirmed the implementation covers the ticket"],
        });
      } else {
        await commitFile(options.cwd, "e2e.test.txt", "regression\n", "qa tests");
        await writeVerdict(prompt, {
          verdict: "pass",
          testsAdded: "one regression test",
          decisions: ["covered the user-visible path end to end"],
        });
      }
      return { ok: true, text: `${stage} done` };
    });

    const ticket = await resolveTicket("Keep one comment per stage", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");

    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8"),
    );
    expect(note.comments.map((comment) => comment.label)).toEqual([
      "JFDI started",
      "Implementation round 1 complete",
      "Code Review round 1 complete",
      "QA round 1 complete",
    ]);
    expect(note.comments).toHaveLength(4);
    for (const comment of note.comments.slice(1)) {
      expect(comment.body).toContain("Decisions:");
      expect(comment.body).toContain("JFDI-Round: 1/4");
      expect(comment.body).toContain("JFDI-Duration:");
      expect(comment.body).toContain("JFDI-Cost:");
    }
  });

  it("states the automatic merge target in the started comment", async () => {
    fixture.config.integration.mode = "auto";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Describe automatic integration", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8"),
    );
    expect(note.comments[0]?.body).toBe(
      `Run started — 4 rounds max. Code Review may reject 2×, QA 1×. Working branch \`jfdi/${ticket.id}\`, will merge to \`main\`.`,
    );
  });

  it("preserves the full first line of narrated session activity", async () => {
    const activity = `checking ${"activity-detail".repeat(20)}`;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
        await writeVerdict(prompt, { status: "done", summary: "done" });
        return {
          ok: true,
          text: "",
          events: [{ type: "text" as const, text: `${activity}\nsecondary line` }],
        };
      }
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    const activities: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "session_activity") activities.push(event);
    });

    const ticket = await resolveTicket("Narrate long activity", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(
      activities.find((event) => event.data?.text === `implementation: ${activity}`),
    ).toBeDefined();
  });

  it("writes run artifacts to the state directory and worktrees to .jfdi/", async () => {
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
        await writeVerdict(prompt, { status: "done", summary: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    // Round artifacts (verdicts, logs) live outside the project checkout…
    const roundDirectory = path.join(fixture.stateDirectory, "runs", ticket.id, "run-1", "round-1");
    expect(await fs.readdir(roundDirectory)).toContain("implementation.verdict.json");
    // …and nothing put a runs/ directory back inside .jfdi/.
    await expect(fs.readdir(path.join(fixture.jfdiDirectory, "runs"))).rejects.toThrow();
    // Worktrees are unchanged: still in-project, still gitignored.
    expect(outcome.worktree.path).toBe(path.join(fixture.jfdiDirectory, "worktrees", ticket.id));
  });

  it("uses max run index plus one and carries history across a deleted run directory", async () => {
    const carriedFeedback = "feedback from the latest existing run";
    const ticket = await resolveTicket("Build after a run directory gap", fixture.ticketsDirectory);
    const runBase = path.join(fixture.stateDirectory, "runs", ticket.id);
    await fs.mkdir(path.join(runBase, "run-1"), { recursive: true });
    await fs.mkdir(path.join(runBase, "run-3"), { recursive: true });
    await fs.writeFile(
      path.join(runBase, "run-3", "history.json"),
      JSON.stringify([
        {
          run: 3,
          round: 1,
          source: "code-review",
          feedback: carriedFeedback,
        },
      ]),
    );

    const implementationPrompts: string[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationPrompts.push(prompt);
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
        await writeVerdict(prompt, { status: "done", summary: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(implementationPrompts).toHaveLength(1);
    expect(implementationPrompts[0]).toContain(carriedFeedback);
    expect((await fs.readdir(runBase)).sort()).toEqual(["run-1", "run-3", "run-4"]);
    expect(await fs.readdir(path.join(runBase, "run-4", "round-1"))).toContain(
      "implementation.verdict.json",
    );
  });

  it("numbers by the max index even when a gap keeps count+1 from colliding", async () => {
    // Adversarial gap the collision case misses: run-1, run-2, run-4 present,
    // run-3 deleted. The old count-based code (count=3) would name the next run
    // run-3 — below the max, so NO collision — yet still regress the numbering
    // and point `previous` at the never-existing run-3, reading history empty.
    // max+1 must land run-5 and resolve `previous` to run-4.
    const carriedFeedback = "feedback from the highest surviving run";
    const ticket = await resolveTicket("Build after a non-colliding gap", fixture.ticketsDirectory);
    const runBase = path.join(fixture.stateDirectory, "runs", ticket.id);
    for (const existing of ["run-1", "run-2", "run-4"]) {
      await fs.mkdir(path.join(runBase, existing), { recursive: true });
    }
    await fs.writeFile(
      path.join(runBase, "run-4", "history.json"),
      JSON.stringify([{ run: 4, round: 1, source: "code-review", feedback: carriedFeedback }]),
    );

    const implementationPrompts: string[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationPrompts.push(prompt);
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
        await writeVerdict(prompt, { status: "done", summary: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(implementationPrompts).toHaveLength(1);
    expect(implementationPrompts[0]).toContain(carriedFeedback);
    expect((await fs.readdir(runBase)).sort()).toEqual(["run-1", "run-2", "run-4", "run-5"]);
    expect(await fs.readdir(runBase)).not.toContain("run-3");
    expect(await fs.readdir(path.join(runBase, "run-5", "round-1"))).toContain(
      "implementation.verdict.json",
    );
  });

  it("code review failure skips QA and feeds back into round 2", async () => {
    const stages: string[] = [];
    let implementationRounds = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      stages.push(stage);
      switch (stage) {
        case "implementation":
          implementationRounds++;
          if (implementationRounds === 2) {
            // The fix round must see the reviewer's feedback.
            expect(prompt).toContain("Feedback on earlier attempts");
            expect(prompt).toContain("rename the helper");
          }
          await commitFile(
            options.cwd,
            "impl.txt",
            `v${implementationRounds}\n`,
            `implement v${implementationRounds}`,
          );
          await writeVerdict(prompt, {
            status: "done",
            summary: `round ${implementationRounds}`,
          });
          break;
        case "code-review":
          await writeVerdict(
            prompt,
            implementationRounds === 1
              ? { verdict: "fail", feedback: "rename the helper; split the god function" }
              : { verdict: "pass" },
          );
          break;
        case "qa":
          await writeVerdict(prompt, { verdict: "pass" });
          break;
        default:
          throw new Error("unexpected");
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Iterate on review", fixture.ticketsDirectory);
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

  it("keeps an implementation observation when that verdict escalates", async () => {
    const context = fixture.context(async (prompt) => {
      await writeVerdict(prompt, {
        status: "escalate",
        question: "Which parser should own this format?",
        recommendation: "Use the new parser",
        observations: ["The legacy parser accepts unbounded input"],
      });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Escalate with context", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.observations).toEqual(["The legacy parser accepts unbounded input"]);
    }
  });

  it("keeps a failing QA observation and deduplicates observations within the run", async () => {
    let implementationAttempts = 0;
    let qaAttempts = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationAttempts += 1;
        await commitFile(
          options.cwd,
          "impl.txt",
          `attempt ${implementationAttempts}\n`,
          "implement",
        );
        await writeVerdict(prompt, {
          status: "done",
          observations: ["The adjacent command has no timeout"],
        });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "pass" });
      } else {
        qaAttempts += 1;
        await writeVerdict(
          prompt,
          qaAttempts === 1
            ? {
                verdict: "fail",
                feedback: "the acceptance behavior is wrong",
                observations: ["The old fixture contains a plaintext token placeholder"],
              }
            : { verdict: "pass" },
        );
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Retry QA observations", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") {
      expect(outcome.report.observations).toEqual([
        "The adjacent command has no timeout",
        "The old fixture contains a plaintext token placeholder",
      ]);
    }
  });

  // The failure tail sits past 4_100 chars, beyond every removed cap
  // (2_000/1_000/500). Asserting the tail survives into the retry prompt is
  // what the removal buys — and it must be checked *after* the run, on
  // harness.calls: an expect() thrown inside the handler is swallowed by the
  // FakeHarness catch, turned into a crashed session, and quietly recovered by
  // a later round, so an in-handler assertion passes with the caps still in.
  const retryImplementationPrompt = (harness: FakeHarness): string => {
    const implementationPrompts = harness.calls
      .map((call) => call.prompt)
      .filter((prompt) => sessionKindOf(prompt) === "implementation");
    const retry = implementationPrompts[1];
    if (!retry) throw new Error("expected a second implementation session (the retry)");
    return retry;
  };

  it("feeds a failed implementation session's full result text into the retry", async () => {
    const failureTail = "implementation failure tail";
    const failureText = `implementation failed\n${"x".repeat(4_100)}\n${failureTail}`;
    let implementationSessions = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationSessions += 1;
        if (implementationSessions === 1) return { ok: false, text: failureText };
        await commitFile(options.cwd, "impl.txt", "fixed\n", "fix implementation");
        await writeVerdict(prompt, { status: "done", summary: "fixed the failure" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Retry failed implementation", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(retryImplementationPrompt(context.harness)).toContain(failureTail);
  });

  it("feeds a failed code review session's full result text into the retry", async () => {
    const failureTail = "code review failure tail";
    const failureText = `code review failed\n${"x".repeat(4_100)}\n${failureTail}`;
    let implementationSessions = 0;
    let codeReviewSessions = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationSessions += 1;
        await commitFile(
          options.cwd,
          "impl.txt",
          `version ${implementationSessions}\n`,
          `implementation ${implementationSessions}`,
        );
        await writeVerdict(prompt, {
          status: "done",
          summary: `implementation ${implementationSessions}`,
        });
      } else if (stage === "code-review") {
        codeReviewSessions += 1;
        if (codeReviewSessions === 1) return { ok: false, text: failureText };
        await writeVerdict(prompt, { verdict: "pass" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Retry failed code review", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(retryImplementationPrompt(context.harness)).toContain(failureTail);
  });

  it("feeds a failed QA session's full result text into the retry", async () => {
    const failureTail = "QA failure tail";
    const failureText = `QA failed\n${"x".repeat(4_100)}\n${failureTail}`;
    let implementationSessions = 0;
    let qaSessions = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationSessions += 1;
        await commitFile(
          options.cwd,
          "impl.txt",
          `version ${implementationSessions}\n`,
          `implementation ${implementationSessions}`,
        );
        await writeVerdict(prompt, {
          status: "done",
          summary: `implementation ${implementationSessions}`,
        });
      } else if (stage === "qa") {
        qaSessions += 1;
        if (qaSessions === 1) return { ok: false, text: failureText };
        await writeVerdict(prompt, { verdict: "pass" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Retry failed QA", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(retryImplementationPrompt(context.harness)).toContain(failureTail);
  });

  it("gate failure feeds back into a fix session without consuming the round", async () => {
    let implementationSessions = 0;
    const stages: string[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      stages.push(stage);
      if (stage === "implementation") {
        implementationSessions++;
        if (implementationSessions === 2) {
          // The fix session continues the same conversation, carrying the
          // gate's own output — not a fresh session in a fresh round.
          expect(prompt).toContain("Your implementation session is being continued");
          expect(prompt).toContain("Mechanical gate failed");
          expect(prompt).toContain("gate-implementation-1.log");
        }
        // The first session forgets impl.txt → gate fails; the fix session
        // inside the same round writes it.
        await commitFile(
          options.cwd,
          implementationSessions === 1 ? "wrong.txt" : "impl.txt",
          "x\n",
          `attempt ${implementationSessions}`,
        );
        await writeVerdict(prompt, { status: "done" });
        return { ok: true, text: "", sessionId: "impl-session" };
      }
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    context.config.gate = [
      {
        name: "check",
        command:
          "if test -f impl.txt; then echo GREEN_TRANSCRIPT; else echo RED_TRANSCRIPT >&2; exit 1; fi",
      },
    ];

    const ticket = await resolveTicket("Gate learner", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(stages).toEqual(["implementation", "implementation", "code-review", "qa"]);
    // The gate cycle stayed inside round 1: rounds mean moving on to other
    // agents, not iterating with the machine.
    expect(outcome.report.rounds).toBe(1);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain(
      "JFDI Implementation complete — gate failed at `check`, continuing with gate fix 1 of 3",
    );
    expect(
      parseTicketNote(note).comments.filter((comment) => comment.stage === "implementation"),
    ).toHaveLength(1);
    expect(note).toContain("--- Gate-fix session 1 ---");
    const implementationComment = parseTicketNote(note).comments.find(
      (comment) => comment.stage === "implementation",
    );
    const implementationCommits = (
      await git(outcome.worktree.path, "rev-list", "--reverse", "main..HEAD")
    ).split("\n");
    expect(implementationCommits).toHaveLength(2);
    for (const commit of implementationCommits) {
      const message = await git(outcome.worktree.path, "show", "-s", "--format=%B", commit);
      expect(implementationComment?.body).toContain(message.trimEnd());
    }
    const roundDirectory = path.join(fixture.stateDirectory, "runs", ticket.id, "run-1", "round-1");
    expect(await fs.readFile(path.join(roundDirectory, "gate-implementation-1.log"), "utf8")).toBe(
      "RED_TRANSCRIPT\n",
    );
    expect(await fs.readFile(path.join(roundDirectory, "gate-implementation-2.log"), "utf8")).toBe(
      "GREEN_TRANSCRIPT\n",
    );
  });

  it("a fourth red gate attempt blocks directly without consuming a round", {
    timeout: 30_000,
  }, async () => {
    const capped = await makeFixture({
      gate: [{ name: "check", command: "test -f impl.txt" }],
    });
    try {
      let implementationSessions = 0;
      const roundsSeen: number[] = [];
      const context = capped.context(async (prompt, options) => {
        const stage = sessionKindOf(prompt);
        if (stage !== "implementation") {
          await writeVerdict(prompt, { verdict: "pass" });
          return { ok: true, text: "" };
        }
        implementationSessions++;
        // Never write impl.txt: every session leaves the gate red.
        await commitFile(options.cwd, "wrong.txt", `${implementationSessions}\n`, "still wrong");
        await writeVerdict(prompt, { status: "done" });
        return { ok: true, text: "" };
      });
      context.log.on((event) => {
        if (event.type === "round_start") roundsSeen.push(Number(event.data?.round));
      });

      const ticket = await resolveTicket("Never green", capped.ticketsDirectory);
      const outcome = await runPipeline(context, ticket);
      expect(outcome.status).toBe("blocked");
      expect(roundsSeen).toEqual([1]);
      expect(implementationSessions).toBe(4);
      if (outcome.status === "blocked")
        expect(outcome.reason).toBe("Mechanical gate failed at `check` after 4 attempts");
      expect(context.log.snapshot().tickets[ticket.id]?.lastActivity).toBe(
        "Mechanical gate failed at `check` after 4 attempts",
      );
    } finally {
      await capped.cleanup();
    }
  });

  it("continues the same round when the fourth gate attempt turns green", async () => {
    let implementationSessions = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationSessions += 1;
        if (implementationSessions === 4)
          await commitFile(options.cwd, "impl.txt", "green\n", "clear the gate");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "", sessionId: `${stage}-session` };
    });

    const ticket = await resolveTicket("Green on the fourth swing", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    expect(implementationSessions).toBe(4);
  });

  it("escalation blocks the ticket and writes Questions with a recommendation", async () => {
    const question = `Should auth use OAuth or magic links? ${"decision-context".repeat(12)}`;
    const context = fixture.context(async (prompt) => {
      await writeVerdict(prompt, {
        status: "escalate",
        question,
        recommendation: "Magic links — no third-party dependency.",
      });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Ambiguous auth ticket", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("blocked");
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Questions");
    expect(note).toContain("OAuth or magic links");
    expect(note).toContain("Magic links — no third-party dependency.");
    const blockedEvents = context.log.snapshot().tickets[ticket.id];
    expect(blockedEvents?.status).toBe("blocked");
    expect(blockedEvents?.lastActivity).toBe(`escalated: ${question}`);
  });

  it("a third Code Review rejection blocks with reviewer counts in the note and event", async () => {
    let implementationAttempt = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationAttempt += 1;
        await commitFile(options.cwd, "impl.txt", `attempt ${implementationAttempt}\n`, "try");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "fail", feedback: "still not good enough" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Never good enough", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked")
      expect(outcome.reason).toBe("Code Review rejected 3 times (budget 2)");
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("Code Review rejected 3 times (budget 2)");
    expect(note).toContain("still not good enough");
    const finalReviewComment = parseTicketNote(note)
      .comments.filter((comment) => comment.stage === "code-review")
      .at(-1);
    expect(finalReviewComment?.body).toContain("Code Review rejected 3 times (budget 2)");
    expect(finalReviewComment?.body).toContain("JFDI-Round: 3/4");
    expect(context.log.snapshot().tickets[ticket.id]?.lastActivity).toBe(
      "Code Review rejected 3 times (budget 2)",
    );
  });

  it.each([
    {
      name: "two Code Review rejections followed by one QA rejection",
      codeReviewVerdicts: ["fail", "fail", "pass", "pass"],
      qaVerdicts: ["fail", "pass"],
    },
    {
      name: "a Code Review rejection on both sides of one QA rejection",
      codeReviewVerdicts: ["fail", "pass", "fail", "pass"],
      qaVerdicts: ["fail", "pass"],
    },
  ])("passes four rounds after $name", async ({ codeReviewVerdicts, qaVerdicts }) => {
    let implementationCalls = 0;
    let codeReviewCalls = 0;
    let qaCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationCalls += 1;
        await commitFile(
          options.cwd,
          "impl.txt",
          `attempt ${implementationCalls}\n`,
          "address feedback",
        );
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        const verdict = codeReviewVerdicts[codeReviewCalls++];
        await writeVerdict(
          prompt,
          scriptedReviewVerdict(verdict ?? "pass", "Code Review feedback"),
        );
      } else if (stage === "qa") {
        const verdict = qaVerdicts[qaCalls++];
        await writeVerdict(prompt, scriptedReviewVerdict(verdict ?? "pass", "QA feedback"));
      }
      return { ok: true, text: "", sessionId: `${stage}-session` };
    });

    const ticket = await resolveTicket("Independent rejection budgets", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(outcome.report.rounds).toBe(4);
    expect(codeReviewCalls).toBe(4);
    expect(qaCalls).toBe(2);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("Run started — 4 rounds max. Code Review may reject 2×, QA 1×.");
    expect(note).toContain("JFDI-Round: 4/4");
  });

  it("a second QA rejection blocks with reviewer counts in the note and event", async () => {
    let implementationCalls = 0;
    let qaCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationCalls += 1;
        await commitFile(options.cwd, "impl.txt", `${implementationCalls}\n`, "address QA");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "pass" });
      } else if (stage === "qa") {
        qaCalls += 1;
        await writeVerdict(prompt, { verdict: "fail", feedback: `QA rejection ${qaCalls}` });
      }
      return { ok: true, text: "", sessionId: `${stage}-session` };
    });

    const ticket = await resolveTicket("QA rejects twice", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "QA rejected 2 times (budget 1)",
    });
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("QA rejected 2 times (budget 1)");
    const finalQaComment = parseTicketNote(note)
      .comments.filter((comment) => comment.stage === "qa")
      .at(-1);
    expect(finalQaComment?.body).toContain("QA rejected 2 times (budget 1)");
    expect(finalQaComment?.body).toContain("JFDI-Round: 2/4");
    expect(context.log.snapshot().tickets[ticket.id]?.lastActivity).toBe(
      "QA rejected 2 times (budget 1)",
    );
  });

  it("mode: ask lowers the escalation bar in the implementation prompt", async () => {
    await fs.writeFile(
      path.join(fixture.ticketsDirectory, "careful.md"),
      "---\nmode: ask\n---\n\nDo the careful thing.\n",
    );
    let sawOverride = false;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        sawOverride = prompt.includes("Escalation override");
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("[[careful]]", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    expect(sawOverride).toBe(true);
  });

  it("a fresh ticket's implementation prompt says nothing about resuming", async () => {
    let implementationPrompt = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationPrompt = prompt;
        await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Brand new work", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(implementationPrompt).not.toContain("Resuming an interrupted attempt");
    expect(implementationPrompt).not.toContain("Feedback on earlier attempts");
  });

  it("re-dispatch resumes: prior commits summarized, prior feedback carried over", async () => {
    // Run 1: every round commits until Code Review exceeds its rejection budget.
    // Distinct content per round, so each round has something to actually commit.
    let attempt = 0;
    const failing = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        attempt += 1;
        await fs.writeFile(path.join(options.cwd, "impl.txt"), `attempt ${attempt}\n`);
        await writeVerdict(prompt, { status: "done", summary: "partial attempt" });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "fail", feedback: "the parser is wrong" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Long haul", fixture.ticketsDirectory);
    expect((await runPipeline(failing, ticket)).status).toBe("blocked");

    // Run 2: the same card dispatched again.
    let resumedPrompt = "";
    const resumed = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        resumedPrompt = resumedPrompt || prompt;
        await commitFile(options.cwd, "impl.txt", "final\n", "finish it");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(resumed, ticket)).status).toBe("passed");

    expect(resumedPrompt).toContain("Resuming an interrupted attempt");
    expect(resumedPrompt).toContain("3 commits of partial work");
    expect(resumedPrompt).toContain("partial attempt");
    // …and why the interrupted run failed, attributed to its run.
    expect(resumedPrompt).toContain("the parser is wrong");
    expect(resumedPrompt).toContain("Run 1, round 3 — code review");
  });

  it("blocks malformed prior feedback history with an actionable warning and error event", async () => {
    const ticket = await resolveTicket("Malformed history", fixture.ticketsDirectory);
    const priorRunDirectory = path.join(fixture.stateDirectory, "runs", ticket.id, "run-1");
    const historyFile = path.join(priorRunDirectory, "history.json");
    const malformedItem = { run: 1, round: 1, source: "qa", feedback: 17 };
    await fs.mkdir(priorRunDirectory, { recursive: true });
    await fs.writeFile(historyFile, JSON.stringify([malformedItem]));

    const context = fixture.context(() => {
      throw new Error("no agent session should be dispatched");
    });
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));

    const outcome = await runPipeline(context, ticket);

    expect(outcome).toMatchObject({ status: "blocked" });
    expect(context.harness.calls).toHaveLength(0);
    expect(events.map((event) => event.type)).not.toContain("dispatch");
    expect(events.map((event) => event.type)).toContain("error");
    expect(events.map((event) => event.type)).toContain("blocked");
    expect(events.find((event) => event.type === "error")?.data?.message).toContain(historyFile);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain(`Malformed feedback history at ${historyFile}`);
    expect(note).toContain('"feedback": 17');
    expect(note).toContain("Fix the file to resume with its feedback intact");
    expect(note).toContain("delete it to deliberately resume without history");
    await expect(
      fs.access(path.join(fixture.stateDirectory, "runs", ticket.id, "run-2")),
    ).rejects.toThrow();
  });

  it("resumes with the full feedback history after the operator fixes the malformed file", async () => {
    const ticket = await resolveTicket("Repair history", fixture.ticketsDirectory);
    const priorRunDirectory = path.join(fixture.stateDirectory, "runs", ticket.id, "run-1");
    const historyFile = path.join(priorRunDirectory, "history.json");
    await fs.mkdir(priorRunDirectory, { recursive: true });
    await fs.writeFile(historyFile, '[{"feedback":17}]');

    const blocked = fixture.context(() => {
      throw new Error("no agent session should be dispatched");
    });
    expect((await runPipeline(blocked, ticket)).status).toBe("blocked");

    const repairedHistory = [
      { run: 1, round: 1, source: "code-review", feedback: "keep the public API" },
      { run: 1, round: 2, source: "qa", feedback: "cover the interrupted path" },
    ];
    await fs.writeFile(historyFile, JSON.stringify(repairedHistory));
    let implementationPrompt = "";
    const resumed = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationPrompt = prompt;
        await commitFile(options.cwd, "impl.txt", "repaired\n", "implement after repair");
        await writeVerdict(prompt, { status: "done", summary: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    expect((await runPipeline(resumed, ticket)).status).toBe("passed");
    expect(implementationPrompt).toContain("keep the public API");
    expect(implementationPrompt).toContain("cover the interrupted path");
  });

  it("carries unanswered feedback across a run that ends in an escalation", async () => {
    // Run 1: Code Review exceeds its rejection budget, leaving feedback on disk.
    let attempt = 0;
    const failing = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        attempt += 1;
        await commitFile(options.cwd, "impl.txt", `attempt ${attempt}\n`, "partial attempt");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "fail", feedback: "the parser is wrong" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Escalating haul", fixture.ticketsDirectory);
    expect((await runPipeline(failing, ticket)).status).toBe("blocked");

    // Run 2: escalates in its first round, so it answers nothing it inherited.
    const escalating = fixture.context(async (prompt) => {
      await writeVerdict(prompt, {
        status: "escalate",
        question: "Which parser is meant?",
        recommendation: "the new one",
      });
      return { ok: true, text: "" };
    });
    expect((await runPipeline(escalating, ticket)).status).toBe("blocked");

    // Run 3: run 1's code-review feedback is still unanswered, so it must survive
    // run 2 — otherwise the escalation silently erases why run 1 failed.
    let answeringPrompt = "";
    const answering = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        answeringPrompt = answeringPrompt || prompt;
        await commitFile(options.cwd, "impl.txt", "final\n", "finish it");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(answering, ticket)).status).toBe("passed");
    expect(answeringPrompt).toContain("the parser is wrong");
  });

  it("carries inherited feedback across a retry interrupted before the next round", async () => {
    let attempt = 0;
    const firstRun = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        attempt += 1;
        await commitFile(options.cwd, "impl.txt", `first run ${attempt}\n`, "partial attempt");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, {
          verdict: "fail",
          feedback: "preserve this original review feedback",
        });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Crash during inherited retry", fixture.ticketsDirectory);
    expect((await runPipeline(firstRun, ticket)).status).toBe("blocked");

    const interruptedRetry = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "second run retry\n", "retry inherited feedback");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "fail", feedback: "new retry feedback" });
      }
      return { ok: true, text: "" };
    });
    const emit = interruptedRetry.log.emit.bind(interruptedRetry.log);
    vi.spyOn(interruptedRetry.log, "emit").mockImplementation((type, ticketId, data) => {
      if (type === "round_start" && data?.round === 2)
        throw new Error("simulated coordinator interruption");
      return emit(type, ticketId, data);
    });
    await expect(runPipeline(interruptedRetry, ticket)).rejects.toThrow(
      "simulated coordinator interruption",
    );

    let resumedPrompt = "";
    const resumed = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        resumedPrompt = prompt;
        await commitFile(options.cwd, "impl.txt", "finished\n", "finish after interruption");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(resumed, ticket)).status).toBe("passed");
    expect(resumedPrompt).toContain("preserve this original review feedback");
    expect(resumedPrompt).toContain("new retry feedback");
  });

  it("sanitizes a worktree a killed session left dirty and mid-merge", async () => {
    const ticket = await resolveTicket("Interrupted mid-flight", fixture.ticketsDirectory);
    const worktree = await createWorktree(
      fixture.projectRoot,
      path.join(fixture.jfdiDirectory, "worktrees"),
      ticket.id,
      "main",
    );
    // A killed run's leavings: a conflicted merge and uncommitted edits.
    await commitFile(worktree.path, "shared.txt", "branch\n", "branch edit");
    await commitFile(fixture.projectRoot, "shared.txt", "main\n", "main edit");
    await mergeTargetIntoBranch(worktree.path, "main");
    await fs.writeFile(path.join(worktree.path, "impl.txt"), "salvaged\n");

    let statusAtStart = "unknown";
    let resumedPrompt = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        statusAtStart = await git(options.cwd, "status", "--porcelain");
        resumedPrompt = prompt;
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));

    expect((await runPipeline(context, ticket)).status).toBe("passed");
    // The agent started from a clean, committed tree with the merge undone.
    expect(statusAtStart).toBe("");
    expect(await isMergeInProgress(worktree.path)).toBe(false);
    expect(await git(worktree.path, "log", "-1", "--format=%s")).toBe(
      `jfdi(${ticket.id}): recovered from interrupted run`,
    );
    expect(resumedPrompt).toContain("recovered from interrupted run");
    expect(resumedPrompt).toContain("merge of `main` into this branch was aborted");
    const resumedEvent = events.find((event) => event.type === "resumed");
    expect(resumedEvent?.data).toMatchObject({
      hasCheckpointedChanges: true,
      hasAbortedMerge: true,
    });
  });

  it("fresh reviewer and QA prompts carry the injected change context", async () => {
    let reviewPrompt = "";
    let qaPrompt = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "the feature\n");
        await writeVerdict(prompt, { status: "done", summary: "implement the feature" });
      } else {
        if (stage === "code-review") reviewPrompt = prompt;
        if (stage === "qa") qaPrompt = prompt;
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Injected context", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");

    // The reviewer starts holding the facts it used to burn turns fetching:
    // gate outcome, commit log, diffstat, inline diff, and the ticket note.
    expect(reviewPrompt).toContain("gate has already passed");
    expect(reviewPrompt).toContain("check ✓");
    expect(reviewPrompt).toContain("implement the feature");
    expect(reviewPrompt).toContain("impl.txt");
    expect(reviewPrompt).toContain("```diff");
    expect(reviewPrompt).toContain(`${ticket.id}.md`);
    // QA gets the same gate trust plus the change summary (no inline diff —
    // its checks derive from the ticket).
    expect(qaPrompt).toContain("gate has already passed");
    expect(qaPrompt).toContain("implement the feature");
    expect(qaPrompt).not.toContain("```diff");
  });

  it("hands stages the note's slice, and reports a link naming no ticket", async () => {
    await fs.writeFile(
      path.join(fixture.ticketsDirectory, "sliced.md"),
      [
        "---",
        "blocked-by:",
        "  - [[never-written]]",
        "---",
        "",
        "# Slice the note",
        "",
        "Only part of this note belongs in a prompt.",
        "",
        "## Comments",
        "",
        "### 2026-08-03T09:00:00.000Z — implementation round 1",
        "",
        "Pipeline narration for humans.",
        "",
        "### 2026-08-03T09:30:00.000Z — Decision (implementation, round 1)",
        "",
        "Assumed UTC timestamps.",
        "",
        "## Report",
        "",
        "An earlier run's report.",
        "",
      ].join("\n"),
    );
    let implementationPrompt = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationPrompt = prompt;
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));

    const ticket = await resolveTicket("[[sliced]]", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");

    expect(implementationPrompt).toContain("Only part of this note belongs in a prompt.");
    expect(implementationPrompt).toContain("Assumed UTC timestamps.");
    expect(implementationPrompt).not.toContain("Pipeline narration for humans.");
    expect(implementationPrompt).not.toContain("An earlier run's report.");

    const unresolved = events.find((event) => event.type === "unresolved_link");
    expect(unresolved?.data).toEqual({ kind: "blocked-by", target: "never-written" });
  });

  it("carries a decision that quotes the comment format itself into the next run's prompt", async () => {
    // The shape that used to forge a second entry: a decision whose own text
    // contains an entry heading. It reaches the note straight from verdict
    // JSON, so nothing but the write path can neutralize it.
    const decision = [
      "Kept the old format. Example entry:",
      "",
      "### 2026-01-01T00:00:00.000Z — qa round 9",
      "",
      "SWALLOWED trailing rationale that matters",
    ].join("\n");
    await fs.writeFile(
      path.join(fixture.ticketsDirectory, "quoter.md"),
      "# Quoter\n\nDo the thing.\n",
    );
    let round = 0;
    let secondRunPrompt = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        round++;
        if (round === 2) secondRunPrompt = prompt;
        await commitFile(options.cwd, "impl.txt", `done ${round}\n`, `implement ${round}`);
        await writeVerdict(prompt, {
          status: "done",
          decisions: round === 1 ? [decision] : [],
        });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    expect(
      (await runPipeline(context, await resolveTicket("[[quoter]]", fixture.ticketsDirectory)))
        .status,
    ).toBe("passed");
    // Re-resolve: the second dispatch reads the note the first one wrote.
    expect(
      (await runPipeline(context, await resolveTicket("[[quoter]]", fixture.ticketsDirectory)))
        .status,
    ).toBe("passed");

    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDirectory, "quoter.md"), "utf8"),
    );
    const implementation = note.comments.find(
      (comment) => comment.label === "Implementation round 1 complete",
    );
    expect(implementation?.body).toContain("Decisions:\n- Kept the old format. Example entry:");
    expect(implementation?.body).toContain("### 2026-01-01T00:00:00.000Z — qa round 9");
    expect(implementation?.body).toContain("SWALLOWED trailing rationale that matters");
    // The whole decision reaches the next session — not just the half above
    // the quoted heading.
    expect(secondRunPrompt).toContain("## Decisions logged so far");
    expect(secondRunPrompt).toContain("Kept the old format. Example entry:");
    expect(secondRunPrompt).toContain("SWALLOWED trailing rationale that matters");
  });

  it("later rounds continue the stage sessions instead of restarting them", async () => {
    const spawns: Array<{ stage: string; continueSessionId: string | undefined }> = [];
    let implementationCalls = 0;
    let reviewCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      spawns.push({ stage, continueSessionId: options.continueSessionId });
      switch (stage) {
        case "implementation":
          implementationCalls++;
          if (implementationCalls === 2) {
            // The continued author gets the reviewer's feedback, not the ticket again.
            expect(prompt).toContain("Your implementation session is being continued");
            expect(prompt).toContain("rename the helper");
            expect(prompt).not.toContain("Implement the ticket below completely");
          }
          await commitFile(options.cwd, "impl.txt", `v${implementationCalls}\n`, "fix helper");
          await writeVerdict(prompt, { status: "done" });
          return { ok: true, text: "", sessionId: `impl-session-${implementationCalls}` };
        case "code-review":
          reviewCalls++;
          if (reviewCalls === 2) {
            // The continued reviewer is briefed on the delta, not re-deriving it.
            expect(prompt).toContain("Your code-review session is being continued");
            expect(prompt).toContain("feedback YOU gave");
            expect(prompt).toContain("impl.txt");
          }
          await writeVerdict(
            prompt,
            reviewCalls === 1
              ? { verdict: "fail", feedback: "rename the helper" }
              : { verdict: "pass" },
          );
          return { ok: true, text: "", sessionId: `review-session-${reviewCalls}` };
        case "qa":
          await writeVerdict(prompt, { verdict: "pass" });
          return { ok: true, text: "", sessionId: "qa-session-1" };
        default:
          throw new Error("unexpected");
      }
    });

    const ticket = await resolveTicket("Continue me", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(spawns).toEqual([
      { stage: "implementation", continueSessionId: undefined },
      { stage: "code-review", continueSessionId: undefined },
      { stage: "implementation", continueSessionId: "impl-session-1" },
      { stage: "code-review", continueSessionId: "review-session-1" },
      { stage: "qa", continueSessionId: undefined },
    ]);
  });

  it("returns a wrong-enum verdict to the same reviewer without consuming a round", async () => {
    const reviewSpawns: Array<{ prompt: string; continueSessionId: string | undefined }> = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(prompt, { status: "done" });
        return { ok: true, text: "", sessionId: "implementation-session" };
      }
      if (stage === "code-review") {
        reviewSpawns.push({ prompt, continueSessionId: options.continueSessionId });
        if (reviewSpawns.length === 1) {
          await writeVerdict(prompt, { verdict: "approve", feedback: "looks good" });
        } else {
          expect(options.continueSessionId).toBe("review-session");
          expect(prompt).toContain('field "verdict" has value "approve"');
          expect(prompt).toContain('allowed values: "pass", "fail"');
          expect(prompt).toContain("code-review.verdict.json");
          expect(prompt).not.toContain("did not produce a valid verdict");
          await writeVerdict(prompt, { verdict: "pass" });
        }
        return { ok: true, text: "", sessionId: "review-session" };
      }
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "", sessionId: "qa-session" };
    });

    const ticket = await resolveTicket("Correct review verdict", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    expect(reviewSpawns.map(({ continueSessionId }) => continueSessionId)).toEqual([
      undefined,
      "review-session",
    ]);
  });

  it("falls back fresh with the same correction when the verdict session was forgotten", async () => {
    const implementationSpawns: Array<{
      prompt: string;
      continueSessionId: string | undefined;
    }> = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationSpawns.push({
        prompt: prompt,
        continueSessionId: options.continueSessionId,
      });
      if (implementationSpawns.length === 1) {
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(prompt, { summary: "forgot the required status" });
        return { ok: true, text: "", sessionId: "implementation-session" };
      }
      if (options.continueSessionId) {
        expect(prompt).toContain('required field "status" is missing');
        expect(prompt).toContain('allowed values: "done", "escalate"');
        return { ok: false, text: "no conversation found with session id" };
      }
      expect(prompt).toBe(implementationSpawns[1]?.prompt);
      await writeVerdict(prompt, { status: "done" });
      return { ok: true, text: "", sessionId: "replacement-session" };
    });

    const ticket = await resolveTicket("Forgot verdict session", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    expect(implementationSpawns.map(({ continueSessionId }) => continueSessionId)).toEqual([
      undefined,
      "implementation-session",
      undefined,
    ]);
  });

  it("blocks after two corrections still contain unparseable verdict JSON", async () => {
    const implementationSpawns: Array<{
      prompt: string;
      continueSessionId: string | undefined;
    }> = [];
    const context = fixture.context(async (prompt, options) => {
      implementationSpawns.push({
        prompt: prompt,
        continueSessionId: options.continueSessionId,
      });
      if (implementationSpawns.length === 1)
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
      await fs.writeFile(verdictPathOf(prompt), "{still garbage");
      return { ok: true, text: "", sessionId: "implementation-session" };
    });

    const ticket = await resolveTicket("Persistent invalid verdict", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("blocked");
    expect(implementationSpawns).toHaveLength(3);
    expect(implementationSpawns.map(({ continueSessionId }) => continueSessionId)).toEqual([
      undefined,
      "implementation-session",
      "implementation-session",
    ]);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("implementation agent failed to function properly");
    expect(note).toContain("after 2 verdict correction attempts");
    expect(note).toContain("JSON parse failed");
    expect(note).toContain("implementation.verdict.json");
    expect(note).not.toContain("run exhausted");
  });

  it("returns unparseable JSON to QA with the parse error and verdict path", async () => {
    let qaCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(prompt, { status: "done" });
        return { ok: true, text: "" };
      }
      if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      qaCalls++;
      if (qaCalls === 1) {
        await fs.writeFile(verdictPathOf(prompt), "not json");
      } else {
        expect(options.continueSessionId).toBe("qa-session");
        expect(prompt).toContain("Output does not meet spec: JSON parse failed:");
        expect(prompt).toContain("qa.verdict.json");
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "", sessionId: "qa-session" };
    });

    const ticket = await resolveTicket("Correct QA JSON", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    expect(qaCalls).toBe(2);
  });

  it("a continued reviewer that passed last round is told the change was QA-driven", async () => {
    let implementationAttempt = 0;
    let reviewCalls = 0;
    let qaCalls = 0;
    let secondReviewPrompt = "";
    let secondQaPrompt = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      switch (stage) {
        case "implementation":
          implementationAttempt += 1;
          await commitFile(
            options.cwd,
            "impl.txt",
            `attempt ${implementationAttempt}\n`,
            "implement",
          );
          await writeVerdict(prompt, { status: "done" });
          return { ok: true, text: "", sessionId: "impl-1" };
        case "code-review":
          reviewCalls++;
          if (reviewCalls === 2) secondReviewPrompt = prompt;
          await writeVerdict(prompt, { verdict: "pass" });
          return { ok: true, text: "", sessionId: `review-${reviewCalls}` };
        case "qa":
          qaCalls++;
          if (qaCalls === 2) {
            secondQaPrompt = prompt;
            expect(options.continueSessionId).toBe("qa-1");
          }
          await writeVerdict(
            prompt,
            qaCalls === 1
              ? { verdict: "fail", feedback: "the flag is ignored on empty input" }
              : { verdict: "pass" },
          );
          return { ok: true, text: "", sessionId: `qa-${qaCalls}` };
        default:
          throw new Error("unexpected");
      }
    });

    const ticket = await resolveTicket("QA driven fix", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(secondReviewPrompt).toContain("you PASSED your previous review");
    expect(secondReviewPrompt).toContain("the flag is ignored on empty input");
    expect(secondQaPrompt).toContain("failures YOU reported");
  });

  it("a continuation the provider forgot falls back to one fresh session", async () => {
    const implementationSpawns: Array<string | undefined> = [];
    let reviewCalls = 0;
    const implementationTurn: FakeHandler = async (prompt, options) => {
      implementationSpawns.push(options.continueSessionId);
      if (options.continueSessionId) {
        // The provider forgot the session: die without writing a verdict.
        return { ok: false, text: "no conversation found with session id" };
      }
      if (implementationSpawns.length > 1) {
        // The fallback is the full fresh prompt, feedback included.
        expect(prompt).toContain("Implement the ticket below completely");
        expect(prompt).toContain("rename the helper");
      }
      await commitFile(options.cwd, "impl.txt", `${implementationSpawns.length}\n`, "attempt");
      await writeVerdict(prompt, { status: "done" });
      return { ok: true, text: "", sessionId: "impl-1" };
    };
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") return implementationTurn(prompt, options);
      if (stage === "code-review") {
        reviewCalls++;
        await writeVerdict(
          prompt,
          reviewCalls === 1
            ? { verdict: "fail", feedback: "rename the helper" }
            : { verdict: "pass" },
        );
        return { ok: true, text: "" };
      }
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Forgetful provider", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    // Round 1 fresh, round 2 continuation (fails), round 2 fresh fallback.
    expect(implementationSpawns).toEqual([undefined, "impl-1", undefined]);
  });

  it("continues QA to fix its gate-breaking tests without consuming the round", async () => {
    await fixture.cleanup();
    fixture = await makeFixture({
      gate: [{ name: "check", command: "test -f impl.txt && ! grep -q BROKEN qa-test.txt" }],
    });
    let qaCalls = 0;
    let implementationCalls = 0;
    let reviewCalls = 0;
    const roundsSeen: number[] = [];
    const handleQa = async (prompt: string, worktreePath: string) => {
      qaCalls++;
      if (qaCalls === 1) {
        await commitFile(worktreePath, "qa-test.txt", "BROKEN\n", "qa tests");
      } else {
        expect(prompt).toContain('Mechanical gate failed at step "check"');
        expect(prompt).toContain("qa-test.txt");
        await commitFile(worktreePath, "qa-test.txt", "fixed\n", "fix qa tests");
      }
      await writeVerdict(prompt, {
        verdict: "pass",
        testsAdded: qaCalls === 1 ? "one" : "fixed one",
      });
    };
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationCalls++;
        await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "qa") {
        if (qaCalls > 0) expect(options.continueSessionId).toBe("qa-session");
        await handleQa(prompt, options.cwd);
      } else {
        reviewCalls++;
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return stage === "qa"
        ? { ok: true, text: "", sessionId: "qa-session" }
        : { ok: true, text: "" };
    });
    context.log.on((event) => {
      if (event.type === "round_start") roundsSeen.push(Number(event.data?.round));
    });

    const ticket = await resolveTicket("QA broke the gate", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(outcome.report.rounds).toBe(1);
    expect(roundsSeen).toEqual([1]);
    expect(implementationCalls).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(qaCalls).toBe(2);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    const qaComments = parseTicketNote(note).comments.filter((comment) => comment.stage === "qa");
    expect(qaComments).toHaveLength(1);
    expect(qaComments[0]?.body).toContain("--- Gate-fix session 1 ---");
    expect(qaComments[0]?.body).toContain("gate failed at `check` over QA's tests");
    expect(qaComments[0]?.body).toContain("green after 1 gate fix");
    const qaCommits = (
      await git(outcome.worktree.path, "log", "--format=%H", "main..HEAD", "--", "qa-test.txt")
    ).split("\n");
    expect(qaCommits).toHaveLength(2);
    for (const commit of qaCommits) {
      const message = await git(outcome.worktree.path, "show", "-s", "--format=%B", commit);
      expect(qaComments[0]?.body).toContain(message.trimEnd());
    }
  });

  it("rejects a QA gate fix that touches a path outside QA's initial handoff", async () => {
    await fixture.cleanup();
    fixture = await makeFixture({
      gate: [{ name: "check", command: "test -f impl.txt && ! grep -q BROKEN qa-test.txt" }],
    });
    let implementationCalls = 0;
    let reviewCalls = 0;
    let qaCalls = 0;
    const handleQa = async (prompt: string, worktreePath: string) => {
      qaCalls++;
      if (qaCalls === 1) {
        await commitFile(worktreePath, "qa-test.txt", "BROKEN\n", "qa tests");
      } else if (qaCalls === 2) {
        await fs.writeFile(path.join(worktreePath, "qa-test.txt"), "fixed\n");
        await commitFile(worktreePath, "product-change.txt", "unreviewed\n", "unsafe qa fix");
      }
      await writeVerdict(prompt, { verdict: "pass", testsAdded: "one" });
    };
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationCalls++;
        if (implementationCalls === 1)
          await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        else expect(prompt).toContain("outside QA's initial handoff: product-change.txt");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "code-review") {
        reviewCalls++;
        await writeVerdict(prompt, { verdict: "pass" });
      } else {
        await handleQa(prompt, options.cwd);
      }
      return stage === "qa"
        ? { ok: true, text: "", sessionId: "qa-session" }
        : { ok: true, text: "" };
    });

    const ticket = await resolveTicket("QA widened its fix", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    expect(outcome.report.rounds).toBe(2);
    expect(implementationCalls).toBe(2);
    expect(reviewCalls).toBe(2);
    expect(qaCalls).toBe(3);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    const firstQaComment = parseTicketNote(note).comments.find(
      (comment) => comment.stage === "qa" && comment.round === 1,
    );
    expect(firstQaComment?.body).toContain("outside QA's initial handoff: product-change.txt");
  });

  it("falls back fresh with the same QA gate-fix brief when the session was forgotten", async () => {
    await fixture.cleanup();
    fixture = await makeFixture({
      gate: [{ name: "check", command: "test -f impl.txt && ! grep -q BROKEN qa-test.txt" }],
    });
    let qaCalls = 0;
    const gateFixPrompts: string[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "qa") {
        qaCalls++;
        if (qaCalls === 1) {
          await commitFile(options.cwd, "qa-test.txt", "BROKEN\n", "qa tests");
          await writeVerdict(prompt, { verdict: "pass" });
          return { ok: true, text: "", sessionId: "forgotten-qa" };
        }
        gateFixPrompts.push(prompt);
        if (qaCalls === 2) {
          expect(options.continueSessionId).toBe("forgotten-qa");
          return { ok: false, text: "session not found" };
        }
        expect(options.continueSessionId).toBeUndefined();
        await commitFile(options.cwd, "qa-test.txt", "fixed\n", "fix qa tests");
        await writeVerdict(prompt, { verdict: "pass" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("QA forgot its session", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    expect(qaCalls).toBe(3);
    expect(gateFixPrompts).toHaveLength(2);
    expect(gateFixPrompts[1]).toBe(gateFixPrompts[0]);
  });

  it("blocks directly when QA exhausts the shared gate-fix cap", { timeout: 30_000 }, async () => {
    await fixture.cleanup();
    fixture = await makeFixture({
      gate: [{ name: "check", command: "test -f impl.txt && ! grep -q BROKEN qa-test.txt" }],
    });
    let qaCalls = 0;
    const roundsSeen: number[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "qa") {
        qaCalls++;
        await commitFile(options.cwd, "qa-test.txt", `BROKEN ${qaCalls}\n`, "qa tests still red");
        await writeVerdict(prompt, { verdict: "pass" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return stage === "qa"
        ? { ok: true, text: "", sessionId: "qa-session" }
        : { ok: true, text: "" };
    });
    context.log.on((event) => {
      if (event.type === "round_start") roundsSeen.push(Number(event.data?.round));
    });

    const ticket = await resolveTicket("QA never clears the gate", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("blocked");
    expect(roundsSeen).toEqual([1]);
    expect(qaCalls).toBe(4);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8");
    expect(note).toContain("gate failed at `check` after 4 attempts");
  });

  it("a session that never writes a verdict burns a round with feedback", async () => {
    let implementationCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        implementationCalls++;
        if (implementationCalls === 1) return { ok: false, text: "crashed mid-flight" };
        expect(prompt).toContain("crashed mid-flight");
        await commitFile(options.cwd, "impl.txt", "ok\n", "implement");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Flaky session", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    expect(implementationCalls).toBe(2);
  });
});

/** Short enough that the fixture's pause schedule lifts it within the test. */
const RESET_SOON_MS = 5;

/**
 * The difference the pipeline has to keep straight: a session that ended
 * because the work was wrong earns a feedback round, and a session that ended
 * because the provider was down earns nothing but another try.
 */
describe("runPipeline under a broken provider", () => {
  it("re-runs a stage the provider killed, at no cost in rounds or feedback", async () => {
    const prompts: string[] = [];
    let implementationCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationCalls++;
      prompts.push(prompt);
      if (implementationCalls === 1)
        return {
          ok: false,
          text: "",
          failure: {
            kind: "usage-limit" as const,
            resetsAtMs: Date.now() + RESET_SOON_MS,
            detail: "You've hit your session limit",
          },
        };
      await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
      await writeVerdict(prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "" };
    });
    const pauses: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "harness_paused" || event.type === "harness_resumed") pauses.push(event);
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    expect(implementationCalls).toBe(2);
    // The retry is the same stage over again, not a fix round: no invented
    // feedback, and the prompt it gets is the one the dead session got.
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).not.toContain("Feedback on earlier attempts");
    expect(pauses.map((event) => event.type)).toEqual(["harness_paused", "harness_resumed"]);
    // Nothing to inherit: the run answered everything it was asked.
    const historyPath = path.join(
      fixture.stateDirectory,
      "runs",
      ticket.id,
      "run-1",
      "history.json",
    );
    expect(JSON.parse(await fs.readFile(historyPath, "utf8"))).toEqual([]);
  });

  it("continues the dead session when the provider named one", async () => {
    let implementationCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationCalls++;
      // The session got far enough to be named before the provider cut it off.
      if (implementationCalls === 1)
        return {
          ok: false,
          text: "",
          sessionId: "session-1",
          failure: { kind: "outage" as const, detail: "Overloaded" },
        };
      expect(options.continueSessionId).toBe("session-1");
      await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
      await writeVerdict(prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(implementationCalls).toBe(2);
  });

  it("retries an outage in place before it stops the whole tool", async () => {
    const stageRetryCount = TEST_PAUSE_DELAYS.outageStageRetryMs.length;
    let implementationCalls = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationCalls++;
      // Down for every stage-local retry and the first attempt after the pause.
      if (implementationCalls <= stageRetryCount + 1)
        return {
          ok: false,
          text: "",
          failure: { kind: "outage" as const, detail: "Overloaded" },
        };
      await commitFile(options.cwd, "impl.txt", "the feature\n", "implement");
      await writeVerdict(prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "" };
    });
    /** Sessions already spawned when the tool first paused. */
    let callsAtFirstPause = 0;
    context.log.on((event) => {
      if (event.type === "harness_paused" && callsAtFirstPause === 0)
        callsAtFirstPause = implementationCalls;
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);

    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    // Three retries in place, then the escalation; the fifth session succeeds.
    expect(callsAtFirstPause).toBe(stageRetryCount + 1);
    expect(implementationCalls).toBe(stageRetryCount + 2);
  });
});

/**
 * A mix in which no two stages share a selection, so a session reaching the
 * wrong harness — or borrowing a neighbour's model — shows up as a failure
 * rather than as an equally-plausible pass. QA names only a harness: its
 * sessions must carry no model or effort at all.
 */
const MIXED_STAGES: JfdiConfig["stages"] = {
  implementation: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
  "code-review": { harness: "codex", model: "gpt-5.6-sol", effort: "low" },
  qa: { harness: "claude" },
  integration: { harness: "codex", effort: "medium" },
  "commit-message": { harness: "codex", model: "gpt-5.6-mini" },
};

/** One fake per `stages` entry, so which harness a session reached is observable. */
function perSessionHarnesses(handler: FakeHandler): Record<SessionKind, FakeHarness> {
  return {
    implementation: new FakeHarness(handler),
    "code-review": new FakeHarness(handler),
    qa: new FakeHarness(handler),
    integration: new FakeHarness(handler),
    "commit-message": new FakeHarness(DEFAULT_SCRIBE_HANDLER),
  };
}

describe("runPipeline with per-stage harness selection", () => {
  it("sends every stage — and its continuation — to that stage's own harness", async () => {
    const mixed = await makeFixture({
      gate: [{ name: "check", command: "test -f impl.txt" }],
      stages: MIXED_STAGES,
    });
    try {
      let implementationCalls = 0;
      let reviewCalls = 0;
      const handler: FakeHandler = async (prompt, options) => {
        const stage = sessionKindOf(prompt);
        switch (stage) {
          case "implementation":
            implementationCalls += 1;
            await commitFile(
              options.cwd,
              "impl.txt",
              `attempt ${implementationCalls}\n`,
              "implement",
            );
            await writeVerdict(prompt, { status: "done", summary: "built it" });
            break;
          case "code-review":
            reviewCalls += 1;
            await writeVerdict(
              prompt,
              // Fail once, so round 2 exercises the continuation path.
              reviewCalls === 1
                ? { verdict: "fail", feedback: "name it better" }
                : { verdict: "pass" },
            );
            break;
          case "qa":
            await writeVerdict(prompt, { verdict: "pass", testsAdded: "one" });
            break;
          default:
            throw new Error(`unexpected stage ${stage}`);
        }
        return { ok: true, text: "", sessionId: `${stage}-session` };
      };

      const harnesses = perSessionHarnesses(handler);
      const context: PipelineContext = { ...mixed.context(handler), harnesses };
      const starts: JfdiEvent[] = [];
      context.log.on((event) => {
        if (event.type === "stage_start") starts.push(event);
      });

      const ticket = await resolveTicket("Build the feature", mixed.ticketsDirectory);
      const outcome = await runPipeline(context, ticket);
      expect(outcome.status).toBe("passed");

      // No harness ever saw a session that was not its own.
      for (const [sessionKind, harness] of Object.entries(harnesses)) {
        for (const call of harness.calls) expect(sessionKindOf(call.prompt)).toBe(sessionKind);
      }
      expect(harnesses.implementation.calls).toHaveLength(2);
      expect(harnesses["code-review"].calls).toHaveLength(2);
      expect(harnesses.qa.calls).toHaveLength(1);
      // Integration does not run in a pipeline; its harness stays untouched.
      expect(harnesses.integration.calls).toHaveLength(0);
      // The scribe reaches its own entry's harness, once per committing session:
      // the two implementation rounds. QA committed nothing, so it has no message.
      expect(harnesses["commit-message"].calls).toHaveLength(2);

      // Round 2 re-enters each stage's own session — which is only meaningful
      // because the harness that minted the id is the one being asked.
      expect(harnesses.implementation.calls[1]?.options.continueSessionId).toBe(
        "implementation-session",
      );
      expect(harnesses["code-review"].calls[1]?.options.continueSessionId).toBe(
        "code-review-session",
      );

      // The record answers which model was configured per stage.
      const selectionOf = (stage: StageName) =>
        starts
          .filter((event) => event.data?.stage === stage)
          .map((event) => ({
            harness: event.data?.harness,
            model: event.data?.model,
            effort: event.data?.effort,
          }));
      expect(selectionOf("implementation")).toEqual([
        { harness: "claude", model: "claude-opus-4-8", effort: "high" },
        { harness: "claude", model: "claude-opus-4-8", effort: "high" },
      ]);
      expect(selectionOf("code-review")[0]).toEqual({
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
      });
      // A harness-only stage stays that way: no model, no effort, nothing
      // borrowed from the stages either side of it.
      const qaStart = starts.find((event) => event.data?.stage === "qa");
      expect(qaStart?.data?.harness).toBe("claude");
      expect(Object.hasOwn(qaStart?.data ?? {}, "model")).toBe(false);
      expect(Object.hasOwn(qaStart?.data ?? {}, "effort")).toBe(false);
    } finally {
      await mixed.cleanup();
    }
  });
});

/**
 * "Agents never commit; the pipeline commits once per session." The rule is
 * only worth as much as its enforcement, so these pin the mechanism — the
 * pre-session HEAD as the reset target — rather than the prompt that asks.
 */
describe("pipeline-owned commits", () => {
  it("folds a session's own commits back into the pipeline's one, from the pre-session HEAD", async () => {
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        // An agent that commits anyway — twice — and leaves work uncommitted.
        await commitFile(options.cwd, "impl.txt", "first\n", "agent commit one");
        await commitFile(options.cwd, "helper.txt", "second\n", "agent commit two");
        await fs.writeFile(path.join(options.cwd, "notes.txt"), "uncommitted\n");
        await writeVerdict(prompt, { status: "done", summary: "built the feature" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Committing agent", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;
    const worktree = outcome.worktree.path;

    // One commit on the branch, standing on the commit the session started from.
    expect(await git(worktree, "rev-list", "--count", "main..HEAD")).toBe("1");
    expect(await git(worktree, "rev-parse", "HEAD^")).toBe(
      await git(worktree, "rev-parse", "main"),
    );
    const subjects = await git(worktree, "log", "--format=%s", "main..HEAD");
    expect(subjects).not.toContain("agent commit");
    expect(subjects).toBe(`${ticket.id}: built the feature`);
    // Nothing was lost in the fold: both committed files and the uncommitted one.
    expect(await git(worktree, "show", "--name-only", "--format=", "HEAD")).toBe(
      ["helper.txt", "impl.txt", "notes.txt"].join("\n"),
    );
    expect(await git(worktree, "status", "--porcelain")).toBe("");
  });

  it("commits a dead session's partial work under a WIP marker, and a re-dispatch continues it", async () => {
    let implementationCalls = 0;
    const failureFirstLine = `the session was killed mid-edit: ${"cleanup-context".repeat(12)}`;
    const dying = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationCalls += 1;
      // Work on disk, then death: no verdict, no commit of its own.
      await fs.writeFile(path.join(options.cwd, "impl.txt"), `attempt ${implementationCalls}\n`);
      return {
        ok: false,
        text: `${failureFirstLine}\r\nsubprocess cleanup also failed`,
      };
    });
    const ticket = await resolveTicket("Killed mid-edit", fixture.ticketsDirectory);
    expect((await runPipeline(dying, ticket)).status).toBe("blocked");

    const worktree = path.join(fixture.jfdiDirectory, "worktrees", ticket.id);
    const subjects = (await git(worktree, "log", "--format=%s", "main..HEAD")).split("\n");
    expect(subjects).toHaveLength(4);
    for (const subject of subjects) expect(subject).toContain(`${ticket.id}: WIP — `);
    const message = await git(worktree, "log", "-1", "--format=%B");
    expect(message).toContain(
      `JFDI Implementation interrupted: The previous implementation session failed: ${failureFirstLine}`,
    );
    expect(message).not.toContain("subprocess cleanup also failed");
    expect(message).toContain("JFDI-Round: 4/4");
    const interruptedNote = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8"),
    );
    expect(interruptedNote.comments[1]?.label).toBe("Implementation round 1 interrupted");

    // The next dispatch finds that work on the branch, not thrown away.
    let resumedPrompt = "";
    const resuming = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        resumedPrompt = prompt;
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "finished\n");
        await writeVerdict(prompt, { status: "done", summary: "finished it" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(resuming, ticket)).status).toBe("passed");
    expect(resumedPrompt).toContain("Resuming an interrupted attempt");
    expect(resumedPrompt).toContain("4 commits of partial work");
    expect(resumedPrompt).toContain("WIP");
  });

  it("hands the scribe the staged diff, the ticket and the stage's own summary", async () => {
    await fs.writeFile(
      path.join(fixture.ticketsDirectory, "scribed.md"),
      "# Scribed ticket\n\nTEACH_THE_PARSER about sha256.\n",
    );
    const scribePrompts: string[] = [];
    const context = fixture.context(
      async (prompt, options) => {
        const stage = sessionKindOf(prompt);
        if (stage === "implementation") {
          await fs.writeFile(path.join(options.cwd, "impl.txt"), "OBJECT_NAME_RE widened\n");
          await writeVerdict(prompt, {
            status: "done",
            summary: "WIDENED_THE_PATTERN to 64 hex digits",
          });
        } else {
          await writeVerdict(prompt, { verdict: "pass" });
        }
        return { ok: true, text: "" };
      },
      {
        scribeHandler: (prompt) => {
          scribePrompts.push(prompt);
          return Promise.resolve({ ok: true, text: "Widen the object-name pattern" });
        },
      },
    );

    const ticket = await resolveTicket("[[scribed]]", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(scribePrompts).toHaveLength(1);
    const prompt = scribePrompts[0] ?? "";
    // The diff it is describing…
    expect(prompt).toContain("OBJECT_NAME_RE widened");
    expect(prompt).toContain("+++ b/impl.txt");
    // …the ticket it serves…
    expect(prompt).toContain("TEACH_THE_PARSER about sha256.");
    // …the session's own account, which the diff cannot carry…
    expect(prompt).toContain("WIDENED_THE_PATTERN to 64 hex digits");
    // …and the metadata the pipeline computed, which it must not write itself.
    expect(prompt).toContain(
      "JFDI Implementation complete — gate green (check ✓), moving to Code Review",
    );
    expect(prompt).toContain("JFDI-Round: 1/4");
  });

  it("writes the identical text to the commit and to the note, and binds the sign-offs to it", async () => {
    let reviewedCommit = "";
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "the feature\n");
        await writeVerdict(prompt, {
          status: "done",
          summary: "built the feature",
          decisions: ["kept the existing storage boundary"],
        });
        return { ok: true, text: "", usage: usageFor(2.0) };
      }
      if (stage === "code-review") reviewedCommit = await git(options.cwd, "rev-parse", "HEAD");
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    // A stepping clock so every session's measured duration is exactly one minute.
    context.now = steppingClock(60 * 1_000);

    const ticket = await resolveTicket("One rendering", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    const message = await git(outcome.worktree.path, "log", "-1", "--format=%B");
    expect(message.trimEnd().split("\n")).toEqual([
      `${ticket.id}: built the feature`,
      "",
      "Written by the scribe.",
      "",
      "Decisions:",
      "- kept the existing storage boundary",
      "",
      "JFDI Implementation complete — gate green (check ✓), moving to Code Review",
      "",
      "JFDI-Round: 1/4",
      "JFDI-Duration: 1m",
      "JFDI-Cost: $2.00",
    ]);

    // The note's entry is that message, byte for byte, under its own heading.
    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8"),
    );
    const entry = note.comments.find((comment) => comment.stage === "implementation");
    expect(entry?.kind).toBe("transition");
    expect(entry?.body).toBe(message.trimEnd());
    const reviewEntry = note.comments.find((comment) => comment.stage === "code-review");
    const qaEntry = note.comments.find((comment) => comment.stage === "qa");
    expect(reviewEntry?.body).toContain(`sign-off on commit \`${reviewedCommit.slice(0, 7)}\``);
    expect(qaEntry?.body).toContain(`sign-off on commit \`${reviewedCommit.slice(0, 7)}\``);

    // Both reviews judged that commit, and it is the one the run reports.
    expect(reviewedCommit).toBe(await git(outcome.worktree.path, "rev-parse", "HEAD"));
    expect(outcome.report.commit).toBe(reviewedCommit);
  });

  it("reports the completed session's confirmed model and configured fallback", async () => {
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "the feature\n");
        await writeVerdict(prompt, { status: "done", summary: "built the feature" });
        return {
          ok: true,
          text: "",
          usage: { ...usageFor(2.0), model: "provider-confirmed-model" },
        };
      }
      await writeVerdict(prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    const stageEnds: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "stage_end") stageEnds.push(event);
    });

    const ticket = await resolveTicket("Model accounting", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    const implementationEnd = stageEnds.find((event) => event.data?.stage === "implementation");
    expect(implementationEnd?.data).toMatchObject({
      model: "provider-confirmed-model",
      modelSource: "provider",
    });
    const reviewEnd = stageEnds.find((event) => event.data?.stage === "code-review");
    expect(reviewEnd?.data).toMatchObject({
      model: context.config.stages["code-review"].model,
      modelSource: "configured",
    });
    expect(outcome.report.usageRows.find((row) => row.label === "Implementation")?.models).toEqual([
      { name: "provider-confirmed-model", source: "provider" },
    ]);
  });

  it("narrates every transition into the note, failed round and exhaustion included", async () => {
    // The provider hits a usage limit inside round 1, so the "no comment for a
    // pause" claim below is about a pause that actually happened: the exact
    // transition list further down is what would have caught an extra entry.
    let implementationAttempts = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, {
          verdict: "fail",
          feedback: "RENAME_THE_HELPER; it shadows the module",
        });
        return { ok: true, text: "" };
      }
      implementationAttempts += 1;
      if (implementationAttempts === 1)
        return {
          ok: false,
          text: "",
          failure: {
            kind: "usage-limit" as const,
            resetsAtMs: Date.now() + RESET_SOON_MS,
            detail: "You've hit your session limit",
          },
        };
      // Distinct content per attempt, so every round has something to commit.
      await fs.writeFile(path.join(options.cwd, "impl.txt"), `attempt ${implementationAttempts}\n`);
      await writeVerdict(prompt, { status: "done", summary: "tried again" });
      return { ok: true, text: "" };
    });
    const pauses: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "harness_paused" || event.type === "harness_resumed") pauses.push(event);
    });

    const ticket = await resolveTicket("Never good enough", fixture.ticketsDirectory);
    expect((await runPipeline(context, ticket)).status).toBe("blocked");
    // The pause is real: without it the assertion at the end proves nothing.
    expect(pauses.map((event) => event.type)).toEqual(["harness_paused", "harness_resumed"]);

    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDirectory, `${ticket.id}.md`), "utf8"),
    );
    const transitions = note.comments.filter((comment) => comment.kind === "transition");
    expect(transitions.map((comment) => `${comment.stage} ${comment.round}`)).toEqual([
      "dispatch 0",
      "implementation 1",
      "code-review 1",
      "implementation 2",
      "code-review 2",
      "implementation 3",
      "code-review 3",
    ]);
    expect(transitions[0]?.body).toBe(
      `Run started — 4 rounds max. Code Review may reject 2×, QA 1×. Working branch \`jfdi/${ticket.id}\`, will queue for approval before merging to \`main\`.`,
    );
    // A failed review's comment IS the handback: the exact feedback, and where
    // the run actually went with it.
    expect(transitions[2]?.body).toContain("RENAME_THE_HELPER; it shadows the module");
    expect(transitions[2]?.body).toContain(
      "JFDI Code Review FAILED — returning to Implementation for round 2",
    );
    expect(transitions[6]?.body).toContain(
      "JFDI Code Review FAILED — moving to Blocked for human review",
    );
    expect(note.questions).toContain("Code Review rejected 3 times (budget 2)");
    // The pause left no mark on the trail — neither an entry of its own (the
    // list above is exact) nor a mention inside one: infrastructure is not
    // ticket history, and the held round is narrated as the one round it was.
    expect(
      note.comments.some((comment) => /pause|usage limit|session limit/i.test(comment.body)),
    ).toBe(false);
  });
});
