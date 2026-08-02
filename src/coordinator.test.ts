import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findColumn, moveCard, parseBoard } from "./board.js";
import { Coordinator } from "./coordinator.js";
import { EventLog } from "./events.js";
import { branchExists, deleteBranch, git, revParse } from "./git.js";
import { worktreesDir } from "./pipeline.js";
import { saveReport } from "./report.js";
import { commitFile, type Fixture, makeFixture, stageOf, writeVerdict } from "./test-helpers.js";
import { ticketIdFromCard } from "./util/ids.js";

let fixture: Fixture;

const BOARD = `---

kanban-plugin: board

---

## Ready

- [ ] Add feature alpha
- [ ] Add feature beta

## In Progress

## Done

`;

/** A board an earlier session left behind: one card waiting for approval. */
const STRANDED_BOARD = `---

kanban-plugin: board

---

## Ready

## In Progress

## Done

## Ready to Merge

- [ ] Add feature alpha

`;

async function readBoard(): Promise<ReturnType<typeof parseBoard>> {
  return parseBoard(await fs.readFile(path.join(fixture.jfdiDir, "board.md"), "utf8"));
}

beforeEach(async () => {
  fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.jfdiDir, "board.md"), BOARD);
});

afterEach(async () => {
  await fixture.cleanup();
});

/** Attempts and spacing for the poll-until helpers below. */
const WAIT_ATTEMPTS = 100;
const WAIT_STEP_MS = 20;
/** Slack for the async board edits a scan makes after it is requested. */
const SCAN_SETTLE_MS = 200;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Trigger a scan, let it reach dispatch, then give its board edits time to land. */
async function rescan(coordinator: Coordinator): Promise<void> {
  coordinator.requestScan();
  await sleep(SCAN_SETTLE_MS);
  await coordinator.drain();
  await sleep(SCAN_SETTLE_MS);
}

/** Poll a condition to a fixed attempt cap — never an unbounded wait. */
async function waitUntil(isSatisfied: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
    if (isSatisfied()) return;
    await sleep(WAIT_STEP_MS);
  }
  throw new Error(`condition never held after ${WAIT_ATTEMPTS} attempts`);
}

/**
 * Put a single card in Ready to Merge with no branch behind it and no run
 * history — the board a coordinator inherits from an earlier session.
 * Returns the card's ticket id.
 */
async function strandCard(): Promise<string> {
  await fs.writeFile(path.join(fixture.jfdiDir, "board.md"), STRANDED_BOARD);
  return ticketIdFromCard("Add feature alpha");
}

/**
 * Merge a ticket branch into the target and delete it — how both approval
 * paths end. Returns the tip that was merged, the sha a run signs off on.
 */
async function landAndDeleteBranch(ticketId: string): Promise<string> {
  const branch = `jfdi/${ticketId}`;
  await git(fixture.repo, "checkout", "-b", branch);
  await commitFile(fixture.repo, "alpha.txt", "alpha\n", "implement alpha");
  const tip = await revParse(fixture.repo, "HEAD");
  await git(fixture.repo, "checkout", "main");
  await git(fixture.repo, "merge", "--no-ff", "-m", `merge ${branch}`, branch);
  await deleteBranch(fixture.repo, branch);
  expect(await branchExists(fixture.repo, branch)).toBe(false);
  return tip;
}

/** A report.json for a ticket, naming the commit its reviews signed off on. */
async function recordSignOff(ticketId: string, commit: string): Promise<void> {
  await saveReport(fixture.stateDir, ticketId, {
    summary: "built alpha",
    decisions: [],
    observations: [],
    testsAdded: "",
    rounds: 1,
    commit,
  });
}

/** Handler that implements each ticket by writing a file named for its card. */
function autoHandler() {
  return async (spec: { prompt: string }, options: { cwd: string }) => {
    const stage = stageOf(spec.prompt);
    if (stage === "implementation") {
      const match = /feature (\w+)/.exec(spec.prompt);
      const name = match?.[1] ?? "unknown";
      await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
      await writeVerdict(spec.prompt, { status: "done", summary: `built ${name}` });
    } else if (stage === "integration") {
      await writeVerdict(spec.prompt, { resolution: "clean" });
    } else {
      await writeVerdict(spec.prompt, { verdict: "pass" });
    }
    return { ok: true, text: "" };
  };
}

const ALPHA_TEXT = "Add feature alpha";
const ALPHA_CARD = `- [ ] ${ALPHA_TEXT}`;

const SINGLE_CARD_BOARD = `---

kanban-plugin: board

---

## Ready

- [ ] Add feature alpha

## In Progress

## Done

`;

function boardPath(): string {
  return path.join(fixture.jfdiDir, "board.md");
}

/** Handler whose implementation stage makes a distinct commit on every run. */
function countingHandler(stages: string[]) {
  let implementations = 0;
  return async (spec: { prompt: string }, options: { cwd: string }) => {
    const stage = stageOf(spec.prompt);
    stages.push(stage);
    if (stage === "implementation") {
      implementations++;
      const file = `impl-${implementations}.txt`;
      await commitFile(options.cwd, file, `${implementations}\n`, `implement ${file}`);
      await writeVerdict(spec.prompt, { status: "done", summary: `built ${file}` });
    } else if (stage === "integration") {
      await writeVerdict(spec.prompt, { resolution: "clean" });
    } else {
      await writeVerdict(spec.prompt, { verdict: "pass" });
    }
    return { ok: true, text: "" };
  };
}

/** One card through the pipeline in on-approval mode: branch and saved report, nothing merged. */
async function runToMergeReady(stages: string[]): Promise<Coordinator> {
  await fs.writeFile(boardPath(), SINGLE_CARD_BOARD);
  fixture.config.integration.mode = "on-approval";
  const coordinator = new Coordinator(fixture.context(countingHandler(stages)), {
    pollMs: 60_000,
  });
  await coordinator.start();
  await coordinator.drain();
  return coordinator;
}

describe("Coordinator", () => {
  it("auto mode: dispatches board cards, runs pipelines, merges, moves cards to Done", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    coordinator.stop();

    // Both features merged to main.
    expect(await fs.readFile(path.join(fixture.repo, "alpha.txt"), "utf8")).toBe("alpha\n");
    expect(await fs.readFile(path.join(fixture.repo, "beta.txt"), "utf8")).toBe("beta\n");

    // Cards moved to Done and checked off; well-known columns created.
    const board = await readBoard();
    expect(board.columns.map((c) => c.name)).toEqual([
      "Ready",
      "In Progress",
      "Done",
      "Blocked",
      "Ready to Merge",
      "Inbox",
    ]);
    expect(findColumn(board, "Ready")?.cards).toHaveLength(0);
    const done = findColumn(board, "Done");
    expect(done?.cards.map((c) => c.checked)).toEqual([true, true]);
  });

  it("on-approval mode: cards land in Ready to Merge with a report", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(2);
    // Nothing merged yet.
    await expect(fs.access(path.join(fixture.repo, "alpha.txt"))).rejects.toThrow();

    // Report appended to each ticket note.
    const alphaId = ticketIdFromCard("Add feature alpha");
    const note = await fs.readFile(path.join(fixture.ticketsDir, `${alphaId}.md`), "utf8");
    expect(note).toContain("ready to merge");
    expect(note).toContain("built alpha");
  });

  it("blocked tickets move to the Blocked column", async () => {
    const context = fixture.context(async (spec) => {
      await writeVerdict(spec.prompt, {
        status: "escalate",
        question: "which db?",
        recommendation: "sqlite",
      });
      return { ok: true, text: "" };
    });
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards).toHaveLength(2);
    expect(findColumn(board, "Ready")?.cards).toHaveLength(0);
  });

  it("closes hand-merged Ready-to-Merge cards without double-merging", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();

    // Human merges alpha by hand.
    const alphaId = ticketIdFromCard("Add feature alpha");
    await git(fixture.repo, "merge", "--ff-only", `jfdi/${alphaId}`);
    const headBefore = await git(fixture.repo, "rev-parse", "HEAD");

    coordinator.requestScan();
    await coordinator.drain();
    // Give the async scan a beat to finish card moves.
    await new Promise((r) => setTimeout(r, 200));
    coordinator.stop();

    expect(await git(fixture.repo, "rev-parse", "HEAD")).toBe(headBefore);
    const board = await readBoard();
    const doneCards = findColumn(board, "Done")?.cards ?? [];
    expect(doneCards.some((c) => c.text.includes("alpha"))).toBe(true);
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(1);
  });

  it("closes a Ready-to-Merge card whose merged branch was deleted", async () => {
    // The state `jfdi merge` leaves behind: the work is in the target, the
    // branch that carried it is gone, and the merge is on the event stream.
    const alphaId = await strandCard();
    await landAndDeleteBranch(alphaId);
    const merger = new EventLog(fixture.stateDir);
    merger.emit("merged", alphaId);
    await merger.flush();

    const context = fixture.context(autoHandler());
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Done")?.cards.map((c) => [c.text, c.checked])).toEqual([
      ["Add feature alpha", true],
    ]);
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(0);
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
  });

  it("closes a Ready-to-Merge card the human merged by hand and tidied up", async () => {
    // The other approval path: no `jfdi merge`, so nothing recorded the merge.
    // The evidence left is the sign-off commit named by report.json, which a
    // plain `git merge` keeps and which is now contained in the target.
    const alphaId = await strandCard();
    const tip = await landAndDeleteBranch(alphaId);
    await recordSignOff(alphaId, tip);

    const context = fixture.context(autoHandler());
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Done")?.cards.map((c) => [c.text, c.checked])).toEqual([
      ["Add feature alpha", true],
    ]);
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(0);
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
  });

  it("leaves a Ready-to-Merge card alone when the branch vanished unmerged", async () => {
    // Branch gone with nothing on record: no evidence the work ever landed.
    await strandCard();

    const context = fixture.context(autoHandler());
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(1);
    expect(findColumn(board, "Done")?.cards).toHaveLength(0);
  });

  it("leaves a Ready-to-Merge card alone when its sign-off commit is not in the target", async () => {
    // A run that signed off and whose branch is gone, but whose work never
    // reached the target: a report naming a live commit is not evidence by
    // itself — containment is the question.
    // Parked on a branch of its own so the sha still resolves; unmerged either
    // way. The board is written afterwards so this detour cannot commit it.
    await git(fixture.repo, "checkout", "-b", "sidetrack");
    await commitFile(fixture.repo, "alpha.txt", "alpha\n", "implement alpha");
    const tip = await revParse(fixture.repo, "HEAD");
    await git(fixture.repo, "checkout", "main");
    const alphaId = await strandCard();
    await recordSignOff(alphaId, tip);

    const context = fixture.context(autoHandler());
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(1);
    expect(findColumn(board, "Done")?.cards).toHaveLength(0);
  });

  it("acknowledges a card a human drags from Ready to Merge to Done", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();

    const alphaId = ticketIdFromCard("Add feature alpha");
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("merge-ready");

    const card = findColumn(await readBoard(), "Ready to Merge")?.cards.find((c) =>
      c.text.includes("alpha"),
    );
    if (!card) throw new Error("alpha card is not in Ready to Merge");
    await moveCard(path.join(fixture.jfdiDir, "board.md"), card.raw, "Ready to Merge", "Done");

    await rescan(coordinator);
    coordinator.stop();

    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
    // Only the dragged card was acknowledged; the other still awaits approval.
    const betaId = ticketIdFromCard("Add feature beta");
    expect(context.log.snapshot().tickets[betaId]?.status).toBe("merge-ready");
  });

  it("reflects a merge another process performed while it is running", async () => {
    const context = fixture.context(autoHandler(), { shouldPersistEvents: true });
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 20 });
    await coordinator.start();
    await coordinator.drain();

    const alphaId = ticketIdFromCard("Add feature alpha");
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("merge-ready");

    // A `jfdi merge` in another terminal: its own EventLog, the same stream.
    const merger = new EventLog(fixture.stateDir);
    merger.emit("merge_start", alphaId);
    merger.emit("merged", alphaId);
    await merger.flush();

    // No restart and no board edit — the running coordinator picks it up on poll.
    await waitUntil(() => context.log.snapshot().tickets[alphaId]?.status === "done");
    coordinator.stop();
  });

  it("materializes stage observations as inbox cards and never dispatches them", async () => {
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        const match = /feature (\w+)/.exec(spec.prompt);
        await commitFile(options.cwd, `${match?.[1]}.txt`, "x\n", "impl");
        await writeVerdict(spec.prompt, {
          status: "done",
          observations: ["Dead code in legacy module"],
        });
      } else if (stage === "integration") {
        await writeVerdict(spec.prompt, { resolution: "clean" });
      } else {
        // QA repeats the same observation — must not produce a duplicate card.
        await writeVerdict(spec.prompt, {
          verdict: "pass",
          observations: ["Dead code in legacy module"],
        });
      }
      return { ok: true, text: "" };
    });
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    // Inbox cards trigger a board change; make sure a rescan does not dispatch them.
    coordinator.requestScan();
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    const inbox = findColumn(board, "Inbox")?.cards ?? [];
    // One card per ticket (provenance differs), deduplicated across that ticket's stages.
    expect(inbox).toHaveLength(2);
    for (const card of inbox) {
      expect(card.text).toContain("Dead code in legacy module");
      expect(card.text).toMatch(/\(from \S+\)/);
    }
    // Proposals are inert: nothing ran for them, both real tickets are Done.
    expect(findColumn(board, "Done")?.cards).toHaveLength(2);
    expect(coordinator.activeCount()).toBe(0);
  });

  it("re-dispatch skips to integration when the branch still matches the report", async () => {
    const stages: string[] = [];
    const coordinator = await runToMergeReady(stages);
    await moveCard(boardPath(), ALPHA_CARD, "Ready to Merge", "Ready");

    await rescan(coordinator);
    coordinator.stop();

    // No second pipeline: the saved sign-off still describes the branch tip.
    expect(stages.filter((s) => s === "implementation")).toHaveLength(1);
    expect(await fs.readFile(path.join(fixture.repo, "impl-1.txt"), "utf8")).toBe("1\n");
    const done = findColumn(await readBoard(), "Done")?.cards ?? [];
    expect(done.some((c) => c.text.includes("alpha"))).toBe(true);
  });

  it("re-dispatch runs the pipeline when the branch has moved past the report", async () => {
    const stages: string[] = [];
    const coordinator = await runToMergeReady(stages);
    // A human commits on the branch after the sign-off — the report no longer
    // describes what a merge would land.
    const worktree = path.join(worktreesDir(fixture.jfdiDir), ticketIdFromCard(ALPHA_TEXT));
    await commitFile(worktree, "by-hand.txt", "hand\n", "human edit");
    await moveCard(boardPath(), ALPHA_CARD, "Ready to Merge", "Ready");

    await rescan(coordinator);
    coordinator.stop();

    // Pipeline re-ran instead of merging the stale branch.
    expect(stages.filter((s) => s === "implementation")).toHaveLength(2);
    await expect(fs.access(path.join(fixture.repo, "impl-1.txt"))).rejects.toThrow();
    expect(findColumn(await readBoard(), "Ready to Merge")?.cards).toHaveLength(1);
  });

  it("sweeps crash-orphaned In Progress cards to Blocked at startup", async () => {
    // Only the orphan on the board: a coordinator died with this card in flight.
    await fs.writeFile(
      path.join(fixture.jfdiDir, "board.md"),
      BOARD.replace(/- \[ \] Add feature \w+\n/g, "").replace(
        "## In Progress\n",
        "## In Progress\n\n- [ ] Add feature gamma\n",
      ),
    );
    const context = fixture.context(autoHandler());
    const reasons: string[] = [];
    context.log.on((event) => {
      if (event.type === "blocked") reasons.push(String(event.data?.reason));
    });
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards.map((c) => c.text)).toEqual(["Add feature gamma"]);
    expect(reasons).toEqual(["orphaned by a coordinator restart — no run was active"]);
    // Blocked, not re-run behind the human's back: no session was ever spawned.
    expect(context.harness.calls).toHaveLength(0);
  });

  it("respects max_concurrent", async () => {
    let peak = 0;
    let current = 0;
    const context = fixture.context(async (spec, options) => {
      const stage = stageOf(spec.prompt);
      if (stage === "implementation") {
        current++;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 50));
        current--;
        const match = /feature (\w+)/.exec(spec.prompt);
        await commitFile(options.cwd, `${match?.[1]}.txt`, "x\n", "impl");
        await writeVerdict(spec.prompt, { status: "done" });
      } else if (stage === "integration") {
        await writeVerdict(spec.prompt, { resolution: "clean" });
      } else {
        await writeVerdict(spec.prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    fixture.config.max_concurrent = 1;
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    // Second card dispatches on the completion rescan.
    await new Promise((r) => setTimeout(r, 100));
    await coordinator.drain();
    coordinator.stop();
    expect(peak).toBe(1);
  });
});
