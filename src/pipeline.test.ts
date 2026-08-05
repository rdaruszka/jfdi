import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JfdiConfig } from "./config.js";
import type { JfdiEvent, StageName } from "./events.js";
import { createWorktree, git, isMergeInProgress, mergeTargetIntoBranch } from "./git.js";
import { type FakeHandler, FakeHarness } from "./harness/fake.js";
import type { SessionKind } from "./harness/index.js";
import { type PipelineContext, runPipeline } from "./pipeline.js";
import {
  commitFile,
  DEFAULT_SCRIBE_HANDLER,
  type Fixture,
  makeFixture,
  sessionKindOf,
  steppingClock,
  TEST_PAUSE_DELAYS,
  usageFor,
  writeVerdict,
} from "./test-helpers.js";
import { parseTicketNote } from "./ticket-note.js";
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
      const stage = sessionKindOf(spec.prompt);
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

    // Decisions recorded as comment entries in the ticket note.
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain("## Comments");
    expect(note).toMatch(/### \S+ — Decision \(implementation, round 1\)/);
    expect(note).toContain("flat file instead of a db");

    // Both commits are on the branch.
    expect(await fs.readFile(path.join(outcome.worktree.path, "e2e.test.txt"), "utf8")).toBe(
      "regression\n",
    );
  });

  it("writes run artifacts to the state directory and worktrees to .jfdi/", async () => {
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
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
      const stage = sessionKindOf(spec.prompt);
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

  it("gate failure feeds back into a fix session without consuming the round", async () => {
    let implementationSessions = 0;
    const stages: string[] = [];
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      stages.push(stage);
      if (stage === "implementation") {
        implementationSessions++;
        if (implementationSessions === 2) {
          // The fix session continues the same conversation, carrying the
          // gate's own output — not a fresh session in a fresh round.
          expect(spec.prompt).toContain("Your implementation session is being continued");
          expect(spec.prompt).toContain("Mechanical gate failed");
        }
        // The first session forgets impl.txt → gate fails; the fix session
        // inside the same round writes it.
        await commitFile(
          options.cwd,
          implementationSessions === 1 ? "wrong.txt" : "impl.txt",
          "x\n",
          `attempt ${implementationSessions}`,
        );
        await writeVerdict(spec.prompt, { status: "done" });
        return { ok: true, text: "", sessionId: "impl-session" };
      }
      await writeVerdict(spec.prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Gate learner", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    expect(stages).toEqual(["implementation", "implementation", "code-review", "qa"]);
    // The gate cycle stayed inside round 1: rounds mean moving on to other
    // agents, not iterating with the machine.
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(1);
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8");
    expect(note).toContain(
      "JFDI gate FAILED at `check` — returning to Implementation for gate fix 1 of 10",
    );
  });

  // Two rounds of eleven sessions each: real git traffic, so a real budget.
  it("gate fixes exhaust their in-round cap before the failure consumes the round", {
    timeout: 30_000,
  }, async () => {
    const capped = await makeFixture({
      gate: [{ name: "check", cmd: "test -f impl.txt" }],
      pipeline: { max_rounds: 2 },
    });
    try {
      let implementationSessions = 0;
      const roundsSeen: number[] = [];
      const context = capped.context(async (spec, options) => {
        const stage = sessionKindOf(spec.prompt);
        if (stage !== "implementation") {
          await writeVerdict(spec.prompt, { verdict: "pass" });
          return { ok: true, text: "" };
        }
        implementationSessions++;
        // Never write impl.txt: every session leaves the gate red.
        await commitFile(options.cwd, "wrong.txt", `${implementationSessions}\n`, "still wrong");
        await writeVerdict(spec.prompt, { status: "done" });
        return { ok: true, text: "" };
      });
      context.log.on((event) => {
        if (event.type === "round_start") roundsSeen.push(Number(event.data?.round));
      });

      const ticket = await resolveTicket("Never green", capped.ticketsDir);
      const outcome = await runPipeline(context, ticket);
      expect(outcome.status).toBe("blocked");
      // Each round pays for one implementation session plus ten gate fixes,
      // and only then lets the gate failure consume the round.
      expect(roundsSeen).toEqual([1, 2]);
      expect(implementationSessions).toBe(2 * 11);
    } finally {
      await capped.cleanup();
    }
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
    let implementationAttempt = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        implementationAttempt += 1;
        await commitFile(options.cwd, "impl.txt", `attempt ${implementationAttempt}\n`, "try");
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
      const stage = sessionKindOf(spec.prompt);
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

  it("a fresh ticket's implementation prompt says nothing about resuming", async () => {
    let prompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        prompt = spec.prompt;
        await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Brand new work", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(prompt).not.toContain("Resuming an interrupted attempt");
    expect(prompt).not.toContain("Feedback on earlier attempts");
  });

  it("re-dispatch resumes: prior commits summarized, prior feedback carried over", async () => {
    // Run 1: every round commits, code review never approves → retries exhausted.
    // Distinct content per round, so each round has something to actually commit.
    let attempt = 0;
    const failing = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        attempt += 1;
        await fs.writeFile(path.join(options.cwd, "impl.txt"), `attempt ${attempt}\n`);
        await writeVerdict(spec.prompt, { status: "done", summary: "partial attempt" });
      } else if (stage === "code-review") {
        await writeVerdict(spec.prompt, { verdict: "fail", feedback: "the parser is wrong" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Long haul", fixture.ticketsDir);
    expect((await runPipeline(failing, ticket)).status).toBe("blocked");

    // Run 2: the same card dispatched again.
    let prompt = "";
    const resumed = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        prompt = prompt || spec.prompt;
        await commitFile(options.cwd, "impl.txt", "final\n", "finish it");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(resumed, ticket)).status).toBe("passed");

    expect(prompt).toContain("Resuming an interrupted attempt");
    expect(prompt).toContain("3 commits of partial work");
    expect(prompt).toContain("partial attempt");
    // …and why the interrupted run failed, attributed to its run.
    expect(prompt).toContain("the parser is wrong");
    expect(prompt).toContain("Run 1, round 3 — code review");
  });

  it("carries unanswered feedback across a run that ends in an escalation", async () => {
    // Run 1: code review never approves → retries exhausted, its feedback on disk.
    let attempt = 0;
    const failing = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        attempt += 1;
        await commitFile(options.cwd, "impl.txt", `attempt ${attempt}\n`, "partial attempt");
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "code-review") {
        await writeVerdict(spec.prompt, { verdict: "fail", feedback: "the parser is wrong" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Escalating haul", fixture.ticketsDir);
    expect((await runPipeline(failing, ticket)).status).toBe("blocked");

    // Run 2: escalates in its first round, so it answers nothing it inherited.
    const escalating = fixture.context(async (spec) => {
      await writeVerdict(spec.prompt, {
        status: "escalate",
        question: "Which parser is meant?",
        recommendation: "the new one",
      });
      return { ok: true, text: "" };
    });
    expect((await runPipeline(escalating, ticket)).status).toBe("blocked");

    // Run 3: run 1's code-review feedback is still unanswered, so it must survive
    // run 2 — otherwise the escalation silently erases why run 1 failed.
    let prompt = "";
    const answering = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        prompt = prompt || spec.prompt;
        await commitFile(options.cwd, "impl.txt", "final\n", "finish it");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(answering, ticket)).status).toBe("passed");
    expect(prompt).toContain("the parser is wrong");
  });

  it("sanitizes a worktree a killed session left dirty and mid-merge", async () => {
    const ticket = await resolveTicket("Interrupted mid-flight", fixture.ticketsDir);
    const worktree = await createWorktree(
      fixture.repo,
      path.join(fixture.jfdiDir, "worktrees"),
      ticket.id,
      "main",
    );
    // A killed run's leavings: a conflicted merge and uncommitted edits.
    await commitFile(worktree.path, "shared.txt", "branch\n", "branch edit");
    await commitFile(fixture.repo, "shared.txt", "main\n", "main edit");
    await mergeTargetIntoBranch(worktree.path, "main");
    await fs.writeFile(path.join(worktree.path, "impl.txt"), "salvaged\n");

    let statusAtStart = "unknown";
    let prompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        statusAtStart = await git(options.cwd, "status", "--porcelain");
        prompt = spec.prompt;
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
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
    expect(prompt).toContain("recovered from interrupted run");
    expect(prompt).toContain("merge of `main` into this branch was aborted");
    const resumedEvent = events.find((event) => event.type === "resumed");
    expect(resumedEvent?.data).toMatchObject({
      hasCheckpointedChanges: true,
      hasAbortedMerge: true,
    });
  });

  it("fresh reviewer and QA prompts carry the injected change context", async () => {
    let reviewPrompt = "";
    let qaPrompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "the feature\n");
        await writeVerdict(spec.prompt, { status: "done", summary: "implement the feature" });
      } else {
        if (stage === "code-review") reviewPrompt = spec.prompt;
        if (stage === "qa") qaPrompt = spec.prompt;
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const ticket = await resolveTicket("Injected context", fixture.ticketsDir);
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
      path.join(fixture.ticketsDir, "sliced.md"),
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
    let prompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        prompt = spec.prompt;
        await commitFile(options.cwd, "impl.txt", "done\n", "implement");
        await writeVerdict(spec.prompt, { status: "done" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));

    const ticket = await resolveTicket("[[sliced]]", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("passed");

    expect(prompt).toContain("Only part of this note belongs in a prompt.");
    expect(prompt).toContain("Assumed UTC timestamps.");
    expect(prompt).not.toContain("Pipeline narration for humans.");
    expect(prompt).not.toContain("An earlier run's report.");

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
    await fs.writeFile(path.join(fixture.ticketsDir, "quoter.md"), "# Quoter\n\nDo the thing.\n");
    let round = 0;
    let secondRunPrompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        round++;
        if (round === 2) secondRunPrompt = spec.prompt;
        await commitFile(options.cwd, "impl.txt", `done ${round}\n`, `implement ${round}`);
        await writeVerdict(spec.prompt, {
          status: "done",
          decisions: round === 1 ? [decision] : [],
        });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    expect(
      (await runPipeline(context, await resolveTicket("[[quoter]]", fixture.ticketsDir))).status,
    ).toBe("passed");
    // Re-resolve: the second dispatch reads the note the first one wrote.
    expect(
      (await runPipeline(context, await resolveTicket("[[quoter]]", fixture.ticketsDir))).status,
    ).toBe("passed");

    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDir, "quoter.md"), "utf8"),
    );
    const decisions = note.comments.filter((comment) => comment.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.body).toBe(decision);
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
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      spawns.push({ stage, continueSessionId: options.continueSessionId });
      switch (stage) {
        case "implementation":
          implementationCalls++;
          if (implementationCalls === 2) {
            // The continued author gets the reviewer's feedback, not the ticket again.
            expect(spec.prompt).toContain("Your implementation session is being continued");
            expect(spec.prompt).toContain("rename the helper");
            expect(spec.prompt).not.toContain("Implement the ticket below completely");
          }
          await commitFile(options.cwd, "impl.txt", `v${implementationCalls}\n`, "fix helper");
          await writeVerdict(spec.prompt, { status: "done" });
          return { ok: true, text: "", sessionId: `impl-session-${implementationCalls}` };
        case "code-review":
          reviewCalls++;
          if (reviewCalls === 2) {
            // The continued reviewer is briefed on the delta, not re-deriving it.
            expect(spec.prompt).toContain("Your code-review session is being continued");
            expect(spec.prompt).toContain("feedback YOU gave");
            expect(spec.prompt).toContain("impl.txt");
          }
          await writeVerdict(
            spec.prompt,
            reviewCalls === 1
              ? { verdict: "fail", feedback: "rename the helper" }
              : { verdict: "pass" },
          );
          return { ok: true, text: "", sessionId: `review-session-${reviewCalls}` };
        case "qa":
          await writeVerdict(spec.prompt, { verdict: "pass" });
          return { ok: true, text: "", sessionId: "qa-session-1" };
        default:
          throw new Error("unexpected");
      }
    });

    const ticket = await resolveTicket("Continue me", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(spawns).toEqual([
      { stage: "implementation", continueSessionId: undefined },
      { stage: "code-review", continueSessionId: undefined },
      { stage: "implementation", continueSessionId: "impl-session-1" },
      { stage: "code-review", continueSessionId: "review-session-1" },
      { stage: "qa", continueSessionId: undefined },
    ]);
  });

  it("a continued reviewer that passed last round is told the change was QA-driven", async () => {
    let implementationAttempt = 0;
    let reviewCalls = 0;
    let qaCalls = 0;
    let secondReviewPrompt = "";
    let secondQaPrompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      switch (stage) {
        case "implementation":
          implementationAttempt += 1;
          await commitFile(
            options.cwd,
            "impl.txt",
            `attempt ${implementationAttempt}\n`,
            "implement",
          );
          await writeVerdict(spec.prompt, { status: "done" });
          return { ok: true, text: "", sessionId: "impl-1" };
        case "code-review":
          reviewCalls++;
          if (reviewCalls === 2) secondReviewPrompt = spec.prompt;
          await writeVerdict(spec.prompt, { verdict: "pass" });
          return { ok: true, text: "", sessionId: `review-${reviewCalls}` };
        case "qa":
          qaCalls++;
          if (qaCalls === 2) {
            secondQaPrompt = spec.prompt;
            expect(options.continueSessionId).toBe("qa-1");
          }
          await writeVerdict(
            spec.prompt,
            qaCalls === 1
              ? { verdict: "fail", feedback: "the flag is ignored on empty input" }
              : { verdict: "pass" },
          );
          return { ok: true, text: "", sessionId: `qa-${qaCalls}` };
        default:
          throw new Error("unexpected");
      }
    });

    const ticket = await resolveTicket("QA driven fix", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(secondReviewPrompt).toContain("you PASSED your previous review");
    expect(secondReviewPrompt).toContain("the flag is ignored on empty input");
    expect(secondQaPrompt).toContain("failures YOU reported");
  });

  it("a continuation the provider forgot falls back to one fresh session", async () => {
    const implementationSpawns: Array<string | undefined> = [];
    let reviewCalls = 0;
    const implementationTurn: FakeHandler = async (spec, options) => {
      implementationSpawns.push(options.continueSessionId);
      if (options.continueSessionId) {
        // The provider forgot the session: die without writing a verdict.
        return { ok: false, text: "no conversation found with session id" };
      }
      if (implementationSpawns.length > 1) {
        // The fallback is the full fresh prompt, feedback included.
        expect(spec.prompt).toContain("Implement the ticket below completely");
        expect(spec.prompt).toContain("rename the helper");
      }
      await commitFile(options.cwd, "impl.txt", `${implementationSpawns.length}\n`, "attempt");
      await writeVerdict(spec.prompt, { status: "done" });
      return { ok: true, text: "", sessionId: "impl-1" };
    };
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") return implementationTurn(spec, options);
      if (stage === "code-review") {
        reviewCalls++;
        await writeVerdict(
          spec.prompt,
          reviewCalls === 1
            ? { verdict: "fail", feedback: "rename the helper" }
            : { verdict: "pass" },
        );
        return { ok: true, text: "" };
      }
      await writeVerdict(spec.prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Forgetful provider", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    // Round 1 fresh, round 2 continuation (fails), round 2 fresh fallback.
    expect(implementationSpawns).toEqual([undefined, "impl-1", undefined]);
  });

  it("the gate re-runs mechanically after QA commits tests, and a failure costs the round", async () => {
    // The gate rejects any committed qa-broken.txt — QA's test commit breaks it.
    await fixture.cleanup();
    fixture = await makeFixture({
      gate: [{ name: "check", cmd: "test -f impl.txt && test ! -f qa-broken.txt" }],
    });
    let qaCalls = 0;
    let implementationCalls = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        implementationCalls++;
        if (implementationCalls === 1) {
          await commitFile(options.cwd, "impl.txt", "x\n", "implement");
        } else {
          expect(spec.prompt).toContain("gate failed after QA committed its tests");
          await commitFile(options.cwd, "qa-broken.txt.gone", "fixed\n", "remove broken qa file");
          await git(options.cwd, "rm", "-q", "qa-broken.txt");
          await git(options.cwd, "commit", "-qm", "drop broken qa test");
        }
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "qa") {
        qaCalls++;
        if (qaCalls === 1) await commitFile(options.cwd, "qa-broken.txt", "boom\n", "qa tests");
        await writeVerdict(spec.prompt, { verdict: "pass", testsAdded: "one" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("QA broke the gate", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status === "passed") expect(outcome.report.rounds).toBe(2);
    expect(implementationCalls).toBe(2);
    expect(qaCalls).toBe(2);
  });

  it("a session that never writes a verdict burns a round with feedback", async () => {
    let implementationCalls = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
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
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage !== "implementation") {
        await writeVerdict(spec.prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationCalls++;
      prompts.push(spec.prompt);
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
      await writeVerdict(spec.prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "" };
    });
    const pauses: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "harness_paused" || event.type === "harness_resumed") pauses.push(event);
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDir);
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
    const historyPath = path.join(fixture.stateDir, "runs", ticket.id, "run-1", "history.json");
    expect(JSON.parse(await fs.readFile(historyPath, "utf8"))).toEqual([]);
  });

  it("continues the dead session when the provider named one", async () => {
    let implementationCalls = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage !== "implementation") {
        await writeVerdict(spec.prompt, { verdict: "pass" });
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
      await writeVerdict(spec.prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("passed");
    expect(implementationCalls).toBe(2);
  });

  it("retries an outage in place before it stops the whole tool", async () => {
    const stageRetryCount = TEST_PAUSE_DELAYS.outageStageRetryMs.length;
    let implementationCalls = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage !== "implementation") {
        await writeVerdict(spec.prompt, { verdict: "pass" });
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
      await writeVerdict(spec.prompt, { status: "done", summary: "implemented" });
      return { ok: true, text: "" };
    });
    /** Sessions already spawned when the tool first paused. */
    let callsAtFirstPause = 0;
    context.log.on((event) => {
      if (event.type === "harness_paused" && callsAtFirstPause === 0)
        callsAtFirstPause = implementationCalls;
    });

    const ticket = await resolveTicket("Build the feature", fixture.ticketsDir);
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
      gate: [{ name: "check", cmd: "test -f impl.txt" }],
      stages: MIXED_STAGES,
    });
    try {
      let implementationCalls = 0;
      let reviewCalls = 0;
      const handler: FakeHandler = async (spec, options) => {
        const stage = sessionKindOf(spec.prompt);
        switch (stage) {
          case "implementation":
            implementationCalls += 1;
            await commitFile(
              options.cwd,
              "impl.txt",
              `attempt ${implementationCalls}\n`,
              "implement",
            );
            await writeVerdict(spec.prompt, { status: "done", summary: "built it" });
            break;
          case "code-review":
            reviewCalls += 1;
            await writeVerdict(
              spec.prompt,
              // Fail once, so round 2 exercises the continuation path.
              reviewCalls === 1
                ? { verdict: "fail", feedback: "name it better" }
                : { verdict: "pass" },
            );
            break;
          case "qa":
            await writeVerdict(spec.prompt, { verdict: "pass", testsAdded: "one" });
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

      const ticket = await resolveTicket("Build the feature", mixed.ticketsDir);
      const outcome = await runPipeline(context, ticket);
      expect(outcome.status).toBe("passed");

      // No harness ever saw a session that was not its own.
      for (const [sessionKind, harness] of Object.entries(harnesses)) {
        for (const call of harness.calls)
          expect(sessionKindOf(call.promptSpec.prompt)).toBe(sessionKind);
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

      // The record answers "which model produced this" per stage.
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
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        // An agent that commits anyway — twice — and leaves work uncommitted.
        await commitFile(options.cwd, "impl.txt", "first\n", "agent commit one");
        await commitFile(options.cwd, "helper.txt", "second\n", "agent commit two");
        await fs.writeFile(path.join(options.cwd, "notes.txt"), "uncommitted\n");
        await writeVerdict(spec.prompt, { status: "done", summary: "built the feature" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const ticket = await resolveTicket("Committing agent", fixture.ticketsDir);
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
    const dying = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage !== "implementation") {
        await writeVerdict(spec.prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationCalls += 1;
      // Work on disk, then death: no verdict, no commit of its own.
      await fs.writeFile(path.join(options.cwd, "impl.txt"), `attempt ${implementationCalls}\n`);
      return { ok: false, text: "the session was killed mid-edit" };
    });
    const ticket = await resolveTicket("Killed mid-edit", fixture.ticketsDir);
    expect((await runPipeline(dying, ticket)).status).toBe("blocked");

    const worktree = path.join(fixture.jfdiDir, "worktrees", ticket.id);
    const subjects = (await git(worktree, "log", "--format=%s", "main..HEAD")).split("\n");
    expect(subjects).toHaveLength(3);
    for (const subject of subjects) expect(subject).toContain(`${ticket.id}: WIP — `);
    const message = await git(worktree, "log", "-1", "--format=%B");
    expect(message).toContain(
      "JFDI Implementation interrupted: The previous implementation session failed: the session was killed mid-edit",
    );
    expect(message).toContain("JFDI-Round: 3/3");

    // The next dispatch finds that work on the branch, not thrown away.
    let resumedPrompt = "";
    const resuming = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        resumedPrompt = spec.prompt;
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "finished\n");
        await writeVerdict(spec.prompt, { status: "done", summary: "finished it" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    expect((await runPipeline(resuming, ticket)).status).toBe("passed");
    expect(resumedPrompt).toContain("Resuming an interrupted attempt");
    expect(resumedPrompt).toContain("3 commits of partial work");
    expect(resumedPrompt).toContain("WIP");
  });

  it("hands the scribe the staged diff, the ticket and the stage's own summary", async () => {
    await fs.writeFile(
      path.join(fixture.ticketsDir, "scribed.md"),
      "# Scribed ticket\n\nTEACH_THE_PARSER about sha256.\n",
    );
    const scribePrompts: string[] = [];
    const context = fixture.context(
      async (spec, options) => {
        const stage = sessionKindOf(spec.prompt);
        if (stage === "implementation") {
          await fs.writeFile(path.join(options.cwd, "impl.txt"), "OBJECT_NAME_RE widened\n");
          await writeVerdict(spec.prompt, {
            status: "done",
            summary: "WIDENED_THE_PATTERN to 64 hex digits",
          });
        } else {
          await writeVerdict(spec.prompt, { verdict: "pass" });
        }
        return { ok: true, text: "" };
      },
      {
        scribeHandler: (spec) => {
          scribePrompts.push(spec.prompt);
          return Promise.resolve({ ok: true, text: "Widen the object-name pattern" });
        },
      },
    );

    const ticket = await resolveTicket("[[scribed]]", fixture.ticketsDir);
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
    expect(prompt).toContain("JFDI Implementation complete — moving to the mechanical gate");
    expect(prompt).toContain("JFDI-Round: 1/3");
  });

  it("writes the identical text to the commit and to the note, and binds the sign-offs to it", async () => {
    let reviewedCommit = "";
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage === "implementation") {
        await fs.writeFile(path.join(options.cwd, "impl.txt"), "the feature\n");
        await writeVerdict(spec.prompt, { status: "done", summary: "built the feature" });
        return { ok: true, text: "", usage: usageFor(2.0) };
      }
      if (stage === "code-review") reviewedCommit = await git(options.cwd, "rev-parse", "HEAD");
      await writeVerdict(spec.prompt, { verdict: "pass" });
      return { ok: true, text: "" };
    });
    // A stepping clock so every session's measured duration is exactly one minute.
    context.now = steppingClock(60 * 1_000);

    const ticket = await resolveTicket("One rendering", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    expect(outcome.status).toBe("passed");
    if (outcome.status !== "passed") return;

    const message = await git(outcome.worktree.path, "log", "-1", "--format=%B");
    expect(message.trimEnd().split("\n")).toEqual([
      `${ticket.id}: built the feature`,
      "",
      "Written by the scribe.",
      "",
      "JFDI Implementation complete — moving to the mechanical gate",
      "",
      "JFDI-Round: 1/3",
      "JFDI-Duration: 1m",
      "JFDI-Cost: $2.00",
    ]);

    // The note's entry is that message, byte for byte, under its own heading.
    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8"),
    );
    const entry = note.comments.find((comment) => comment.stage === "implementation");
    expect(entry?.kind).toBe("transition");
    expect(entry?.body).toBe(message.trimEnd());

    // Both reviews judged that commit, and it is the one the run reports.
    expect(reviewedCommit).toBe(await git(outcome.worktree.path, "rev-parse", "HEAD"));
    expect(outcome.report.commit).toBe(reviewedCommit);
  });

  it("narrates every transition into the note, failed round and exhaustion included", async () => {
    // The provider hits a usage limit inside round 1, so the "no comment for a
    // pause" claim below is about a pause that actually happened: the exact
    // transition list further down is what would have caught an extra entry.
    let implementationAttempts = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = sessionKindOf(spec.prompt);
      if (stage !== "implementation") {
        await writeVerdict(spec.prompt, {
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
      await writeVerdict(spec.prompt, { status: "done", summary: "tried again" });
      return { ok: true, text: "" };
    });
    const pauses: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "harness_paused" || event.type === "harness_resumed") pauses.push(event);
    });

    const ticket = await resolveTicket("Never good enough", fixture.ticketsDir);
    expect((await runPipeline(context, ticket)).status).toBe("blocked");
    // The pause is real: without it the assertion at the end proves nothing.
    expect(pauses.map((event) => event.type)).toEqual(["harness_paused", "harness_resumed"]);

    const note = parseTicketNote(
      await fs.readFile(path.join(fixture.ticketsDir, `${ticket.id}.md`), "utf8"),
    );
    const transitions = note.comments.filter((comment) => comment.kind === "transition");
    expect(transitions.map((comment) => `${comment.stage} ${comment.round}`)).toEqual([
      "dispatch 1",
      "implementation 1",
      "code-review 1",
      "implementation 2",
      "code-review 2",
      "implementation 3",
      "code-review 3",
      "pipeline 3",
    ]);
    expect(transitions[0]?.body).toBe(`JFDI run started — round 1, branch \`jfdi/${ticket.id}\``);
    // A failed review's comment IS the handback: the exact feedback, and where
    // the run actually went with it.
    expect(transitions[2]?.body).toBe(
      "JFDI Code Review FAILED — returning to Implementation for round 2\n\nRENAME_THE_HELPER; it shadows the module",
    );
    expect(transitions[6]?.body).toContain(
      "JFDI Code Review FAILED — moving to Blocked for human review",
    );
    expect(transitions[7]?.body).toContain(
      "JFDI run exhausted its 3 rounds — moving to Blocked for human review",
    );
    // The pause left no mark on the trail — neither an entry of its own (the
    // list above is exact) nor a mention inside one: infrastructure is not
    // ticket history, and the held round is narrated as the one round it was.
    expect(
      note.comments.some((comment) => /pause|usage limit|session limit/i.test(comment.body)),
    ).toBe(false);
  });
});
