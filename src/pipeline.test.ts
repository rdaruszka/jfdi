import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JfdiConfig } from "./config.js";
import type { JfdiEvent, StageName } from "./events.js";
import { createWorktree, git, isRebaseInProgress, rebaseOnto } from "./git.js";
import { type FakeHandler, FakeHarness } from "./harness/fake.js";
import { type PipelineContext, runPipeline } from "./pipeline.js";
import {
  commitFile,
  type Fixture,
  makeFixture,
  stageOf,
  TEST_PAUSE_DELAYS,
  writeVerdict,
} from "./test-helpers.js";
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

  it("a fresh ticket's implementation prompt says nothing about resuming", async () => {
    let prompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        attempt += 1;
        await commitFile(options.cwd, "impl.txt", `attempt ${attempt}\n`, "partial attempt");
        await writeVerdict(spec.prompt, { status: "done" });
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
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
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

  it("sanitizes a worktree a killed session left dirty and mid-rebase", async () => {
    const ticket = await resolveTicket("Interrupted mid-flight", fixture.ticketsDir);
    const worktree = await createWorktree(
      fixture.repo,
      path.join(fixture.jfdiDir, "worktrees"),
      ticket.id,
      "main",
    );
    // A killed run's leavings: a conflicted rebase and uncommitted edits.
    await commitFile(worktree.path, "shared.txt", "branch\n", "branch edit");
    await commitFile(fixture.repo, "shared.txt", "main\n", "main edit");
    await rebaseOnto(worktree.path, "main");
    await fs.writeFile(path.join(worktree.path, "impl.txt"), "salvaged\n");

    let statusAtStart = "unknown";
    let prompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
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
    // The agent started from a clean, committed tree with the rebase undone.
    expect(statusAtStart).toBe("");
    expect(await isRebaseInProgress(worktree.path)).toBe(false);
    expect(await git(worktree.path, "log", "-1", "--format=%s")).toBe(
      `jfdi(${ticket.id}): recovered from interrupted run`,
    );
    expect(prompt).toContain("recovered from interrupted run");
    expect(prompt).toContain("rebase onto `main` was aborted");
    const resumedEvent = events.find((event) => event.type === "resumed");
    expect(resumedEvent?.data).toMatchObject({
      hasCheckpointedChanges: true,
      hasAbortedRebase: true,
    });
  });

  it("fresh reviewer and QA prompts carry the injected change context", async () => {
    let reviewPrompt = "";
    let qaPrompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "impl.txt", "the feature\n", "implement the feature");
        await writeVerdict(spec.prompt, { status: "done" });
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
      const stage = stageOf(spec.prompt);
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

  it("later rounds continue the stage sessions instead of restarting them", async () => {
    const spawns: Array<{ stage: string; continueSessionId: string | undefined }> = [];
    let implementationCalls = 0;
    let reviewCalls = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
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
    let reviewCalls = 0;
    let qaCalls = 0;
    let secondReviewPrompt = "";
    let secondQaPrompt = "";
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      switch (stage) {
        case "implementation":
          await commitFile(options.cwd, "impl.txt", `${Math.random()}\n`, "implement");
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
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
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
      const stage = stageOf(spec.prompt);
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
  implementation: { harness: "claude", model: "claude-opus-5", effort: "high" },
  "code-review": { harness: "codex", model: "gpt-5.6-sol", effort: "low" },
  qa: { harness: "claude" },
  integration: { harness: "codex", effort: "medium" },
};

/** One fake per stage, so which harness a session reached is observable. */
function perStageHarnesses(handler: FakeHandler): Record<StageName, FakeHarness> {
  return {
    implementation: new FakeHarness(handler),
    "code-review": new FakeHarness(handler),
    qa: new FakeHarness(handler),
    integration: new FakeHarness(handler),
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
        const stage = stageOf(spec.prompt);
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

      const harnesses = perStageHarnesses(handler);
      const context: PipelineContext = { ...mixed.context(handler), harnesses };
      const starts: JfdiEvent[] = [];
      context.log.on((event) => {
        if (event.type === "stage_start") starts.push(event);
      });

      const ticket = await resolveTicket("Build the feature", mixed.ticketsDir);
      const outcome = await runPipeline(context, ticket);
      expect(outcome.status).toBe("passed");

      // No harness ever saw a stage that was not its own.
      for (const [stage, harness] of Object.entries(harnesses)) {
        for (const call of harness.calls) expect(stageOf(call.promptSpec.prompt)).toBe(stage);
      }
      expect(harnesses.implementation.calls).toHaveLength(2);
      expect(harnesses["code-review"].calls).toHaveLength(2);
      expect(harnesses.qa.calls).toHaveLength(1);
      // Integration does not run in a pipeline; its harness stays untouched.
      expect(harnesses.integration.calls).toHaveLength(0);

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
        { harness: "claude", model: "claude-opus-5", effort: "high" },
        { harness: "claude", model: "claude-opus-5", effort: "high" },
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
