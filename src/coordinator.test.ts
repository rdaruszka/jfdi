import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findColumn, moveCard, parseBoard } from "./board.js";
import { Coordinator } from "./coordinator.js";
import { EventLog, integrationRecords, type JfdiEvent, loadState } from "./events.js";
import {
  branchExists,
  createWorktree,
  deleteBranch,
  git,
  isAncestor,
  parseRevision,
} from "./git.js";
import { integrateTicket } from "./integrate.js";
import { worktreesDirectory } from "./pipeline.js";
import { isCorruptReport, loadReport, saveReport } from "./report.js";
import {
  commitFile,
  type Fixture,
  makeFixture,
  sessionKindOf,
  writeVerdict,
} from "./test-helpers.js";
import { parseTicketNote } from "./ticket-note.js";
import { resolveTicket } from "./tickets.js";
import { ticketIdFromCard } from "./util/ids.js";

let fixture: Fixture;
let coordinators: Coordinator[];

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

/** Three cards waiting for approval: enough for one sweep to close more than one. */
const STRANDED_TRIO_BOARD = `---

kanban-plugin: board

---

## Ready

## In Progress

## Done

## Ready to Merge

- [ ] Add feature alpha
- [ ] Add feature beta
- [ ] Add feature gamma

`;

async function readBoard(): Promise<ReturnType<typeof parseBoard>> {
  return parseBoard(await fs.readFile(path.join(fixture.jfdiDirectory, "board.md"), "utf8"));
}

beforeEach(async () => {
  coordinators = [];
  fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.jfdiDirectory, "board.md"), BOARD);
});

afterEach(async () => {
  for (const coordinator of coordinators) coordinator.stop();
  await fixture.cleanup();
});

/** Attempts and spacing for the poll-until helpers below. */
const WAIT_ATTEMPTS = 100;
const WAIT_STEP_MS = 20;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Start a coordinator and register its resources for unconditional teardown. */
async function startCoordinator(coordinator: Coordinator): Promise<void> {
  coordinators.push(coordinator);
  await coordinator.start();
}

/** Trigger a scan and settle both its dispatched work and completion rescan. */
async function rescan(coordinator: Coordinator): Promise<void> {
  await coordinator.settleScan();
  await coordinator.drain();
  await coordinator.settleScan();
}

/** A promise a test resolves by hand, to sequence two concurrent runs against each other. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

/**
 * A real EventLog whose disk writes happen only when the caller flushes. This
 * makes the cross-process ordering deterministic: its in-memory state advances
 * normally, while another EventLog sees only the events made durable so far.
 */
class FlushControlledEventLog extends EventLog {
  private readonly diskLog: EventLog;
  private pendingEvents: JfdiEvent[] = [];

  constructor(stateDirectory: string) {
    super(stateDirectory, false);
    this.diskLog = new EventLog(stateDirectory);
  }

  override emit(...args: Parameters<EventLog["emit"]>): JfdiEvent {
    const event = super.emit(...args);
    this.pendingEvents.push(event);
    return event;
  }

  override async flush(): Promise<void> {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of events) this.diskLog.emit(event.type, event.ticketId, event.data);
    await this.diskLog.flush();
  }

  pendingTypes(): JfdiEvent["type"][] {
    return this.pendingEvents.map((event) => event.type);
  }
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
  await fs.writeFile(path.join(fixture.jfdiDirectory, "board.md"), STRANDED_BOARD);
  return ticketIdFromCard("Add feature alpha");
}

/**
 * Merge a ticket branch into the target and delete it — how both approval
 * paths end. Returns the tip that was merged, the sha a run signs off on.
 * The commit touches a file named for the ticket so several tickets can be
 * landed in one test without the second finding nothing to commit.
 */
async function landAndDeleteBranch(ticketId: string): Promise<string> {
  const branch = `jfdi/${ticketId}`;
  await git(fixture.projectRoot, "checkout", "-b", branch);
  await commitFile(fixture.projectRoot, `${ticketId}.txt`, "work\n", `implement ${ticketId}`);
  const tip = await parseRevision(fixture.projectRoot, "HEAD");
  await git(fixture.projectRoot, "checkout", "main");
  await git(fixture.projectRoot, "merge", "--no-ff", "-m", `merge ${branch}`, branch);
  await deleteBranch(fixture.projectRoot, branch);
  expect(await branchExists(fixture.projectRoot, branch)).toBe(false);
  return tip;
}

/** Every `merged` line the shared stream carries for one ticket. */
async function recordedMergedEvents(ticketId: string): Promise<JfdiEvent[]> {
  const content = await fs.readFile(path.join(fixture.stateDirectory, "events.jsonl"), "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JfdiEvent)
    .filter((event) => event.type === "merged" && event.ticketId === ticketId);
}

/** A report.json for a ticket, naming the commit its reviews signed off on. */
async function recordSignOff(ticketId: string, commit: string): Promise<void> {
  await saveReport(fixture.stateDirectory, ticketId, {
    summary: "built alpha",
    decisions: [],
    observations: [],
    testsAdded: "",
    rounds: 1,
    commit,
    usageRows: [],
    elapsedMs: 0,
  });
}

/** Handler that implements each ticket by writing a file named for its card. */
function autoHandler() {
  return async (prompt: string, options: { cwd: string }) => {
    const stage = sessionKindOf(prompt);
    if (stage === "implementation") {
      const match = /feature (\w+)/.exec(prompt);
      const name = match?.[1] ?? "unknown";
      await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
      await writeVerdict(prompt, { status: "done", summary: `built ${name}` });
    } else if (stage === "integration") {
      await writeVerdict(prompt, { resolution: "clean" });
    } else {
      await writeVerdict(prompt, { verdict: "pass" });
    }
    return { ok: true, text: "" };
  };
}

/** The feature suffix carried in the fixture ticket's prompt. */
function featureName(prompt: string): string {
  return /feature (\w+)/.exec(prompt)?.[1] ?? "unknown";
}

/** Fail the first review with an observation, then approve the fix round. */
function observedReviewVerdict(implementationAttempt: number | undefined): Record<string, unknown> {
  if (implementationAttempt !== 1) return { verdict: "pass" };
  return {
    verdict: "fail",
    feedback: "fix the ticket code",
    observations: ["Security headers are missing from the legacy server"],
  };
}

/** One card left mid-flight by a coordinator that died, and nothing else. */
const ORPHANED_BOARD = `---

kanban-plugin: board

---

## Ready

## In Progress

- [ ] Add feature gamma

## Done

`;

/** One card left mid-flight and one waiting behind it — two claims on one slot. */
const STRANDED_AND_WAITING_BOARD = `---

kanban-plugin: board

---

## Ready

- [ ] Add feature alpha

## In Progress

- [ ] Add feature gamma

## Done

`;

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
  return path.join(fixture.jfdiDirectory, "board.md");
}

/** Handler whose implementation stage makes a distinct commit on every run. */
function countingHandler(stages: string[]) {
  let implementations = 0;
  return async (prompt: string, options: { cwd: string }) => {
    const stage = sessionKindOf(prompt);
    stages.push(stage);
    if (stage === "implementation") {
      implementations++;
      const file = `impl-${implementations}.txt`;
      await commitFile(options.cwd, file, `${implementations}\n`, `implement ${file}`);
      await writeVerdict(prompt, { status: "done", summary: `built ${file}` });
    } else if (stage === "integration") {
      await writeVerdict(prompt, { resolution: "clean" });
    } else {
      await writeVerdict(prompt, { verdict: "pass" });
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
  await startCoordinator(coordinator);
  await coordinator.drain();
  return coordinator;
}

describe("Coordinator", () => {
  it("blocks a corrupt report with an unblock recipe and never dispatches", async () => {
    await fs.writeFile(boardPath(), SINGLE_CARD_BOARD);
    const ticketId = ticketIdFromCard(ALPHA_TEXT);
    const reportPath = path.join(fixture.stateDirectory, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const corruptContent = '{"summary":';
    await fs.writeFile(reportPath, corruptContent);
    const stages: string[] = [];
    const context = fixture.context(countingHandler(stages));
    const coordinator = new Coordinator(context, { pollMs: 60_000 });

    await startCoordinator(coordinator);
    await coordinator.drain();

    expect(stages).toEqual([]);
    expect(findColumn(await readBoard(), "Blocked")?.cards.map((card) => card.text)).toContain(
      ALPHA_TEXT,
    );
    expect(await fs.readFile(reportPath, "utf8")).toBe(corruptContent);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticketId}.md`), "utf8");
    expect(note).toContain(reportPath);
    expect(note).toContain("JSON");
    expect(note).toContain("fix or restore");
    expect(note).toContain("delete the file");
  });

  it("proceeds normally on the next scan after the corrupt report is restored", async () => {
    await fs.writeFile(boardPath(), SINGLE_CARD_BOARD);
    const ticketId = ticketIdFromCard(ALPHA_TEXT);
    const worktree = await createWorktree(
      fixture.projectRoot,
      worktreesDirectory(fixture.jfdiDirectory),
      ticketId,
      "main",
    );
    await commitFile(worktree.path, "restored.txt", "restored\n", "restore signed-off work");
    const signedOffCommit = await parseRevision(worktree.path, "HEAD");
    const reportPath = path.join(fixture.stateDirectory, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, '{"summary":');
    const stages: string[] = [];
    const coordinator = new Coordinator(fixture.context(countingHandler(stages)), {
      pollMs: 60_000,
    });
    await startCoordinator(coordinator);
    await coordinator.drain();

    await fs.writeFile(
      reportPath,
      JSON.stringify({
        summary: "restored pass",
        decisions: [],
        observations: [],
        testsAdded: "",
        rounds: 1,
        commit: signedOffCommit,
        usageRows: [],
        elapsedMs: 0,
      }),
    );
    await moveCard(boardPath(), ALPHA_CARD, "Blocked", "Ready");
    await rescan(coordinator);

    expect(stages).toEqual([]);
    expect(await fs.readFile(path.join(fixture.projectRoot, "restored.txt"), "utf8")).toBe(
      "restored\n",
    );
    expect(findColumn(await readBoard(), "Done")?.cards.map((card) => card.text)).toEqual([
      ALPHA_TEXT,
    ]);
  });

  it("moves a Ready-to-Merge card to Blocked when its sign-off report is corrupt", async () => {
    const ticketId = await strandCard();
    const reportPath = path.join(fixture.stateDirectory, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ summary: "missing core fields" }));
    const coordinator = new Coordinator(fixture.context(autoHandler()), { pollMs: 60_000 });

    await startCoordinator(coordinator);

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(0);
    expect(findColumn(board, "Blocked")?.cards.map((card) => card.text)).toEqual([ALPHA_TEXT]);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticketId}.md`), "utf8");
    expect(note).toContain(reportPath);
    expect(note).toContain("decisions");
    expect(note).toContain("fix or restore");
    expect(note).toContain("delete the file");
  });

  it("auto mode: dispatches board cards, runs pipelines, merges, moves cards to Done", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();
    coordinator.stop();

    // Both features merged to main.
    expect(await fs.readFile(path.join(fixture.projectRoot, "alpha.txt"), "utf8")).toBe("alpha\n");
    expect(await fs.readFile(path.join(fixture.projectRoot, "beta.txt"), "utf8")).toBe("beta\n");

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
    await startCoordinator(coordinator);
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(2);
    // Nothing merged yet.
    await expect(fs.access(path.join(fixture.projectRoot, "alpha.txt"))).rejects.toThrow();

    // QA's phase record names the approval queue; the report stays on disk.
    const alphaId = ticketIdFromCard("Add feature alpha");
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${alphaId}.md`), "utf8");
    expect(note).toContain("queued for approval before integration");
    expect(note).toContain("built alpha");
  });

  it("blocked tickets move to the Blocked column", async () => {
    const context = fixture.context(async (prompt) => {
      await writeVerdict(prompt, {
        status: "escalate",
        question: "which db?",
        recommendation: "sqlite",
      });
      return { ok: true, text: "" };
    });
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
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
    await startCoordinator(coordinator);
    await coordinator.drain();

    // Human merges alpha by hand.
    const alphaId = ticketIdFromCard("Add feature alpha");
    await git(fixture.projectRoot, "merge", "--ff-only", `jfdi/${alphaId}`);
    const headBefore = await git(fixture.projectRoot, "rev-parse", "HEAD");

    await rescan(coordinator);
    coordinator.stop();

    expect(await git(fixture.projectRoot, "rev-parse", "HEAD")).toBe(headBefore);
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
    const merger = new EventLog(fixture.stateDirectory);
    merger.emit("merge_start", alphaId);
    merger.emit("merged", alphaId);
    await merger.flush();

    const context = fixture.context(autoHandler(), { shouldPersistEvents: true });
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    coordinator.stop();
    await context.log.flush();

    const board = await readBoard();
    expect(findColumn(board, "Done")?.cards.map((c) => [c.text, c.checked])).toEqual([
      ["Add feature alpha", true],
    ]);
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(0);
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
    // The merger already narrated this merge; the sweep folds the recorded
    // event into its own state instead of telling the story twice.
    expect(await recordedMergedEvents(alphaId)).toHaveLength(1);
  });

  it("waits out another process's in-flight merge instead of narrating it twice", async () => {
    // The window `jfdi merge` occupies between landing its merge commit and
    // moving the card itself: git already answers "merged" while the stream
    // still says the story is mid-telling. The sweep must hold back — closing
    // here is what doubled the `merged` line under merge-detection's
    // convergence test.
    const alphaId = await strandCard();
    const branch = `jfdi/${alphaId}`;
    await git(fixture.projectRoot, "checkout", "-b", branch);
    await commitFile(fixture.projectRoot, `${alphaId}.txt`, "work\n", `implement ${alphaId}`);
    await git(fixture.projectRoot, "checkout", "main");
    await git(fixture.projectRoot, "merge", "--no-ff", "-m", `merge ${branch}`, branch);
    // The branch stays: the merging process has not reached its cleanup yet.

    const merger = new EventLog(fixture.stateDirectory);
    merger.emit("merge_start", alphaId);
    await merger.flush();

    const context = fixture.context(autoHandler(), { shouldPersistEvents: true });
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);

    expect(findColumn(await readBoard(), "Ready to Merge")?.cards).toHaveLength(1);
    expect(await recordedMergedEvents(alphaId)).toHaveLength(0);

    // The merger finishes its story on the stream but dies before its own
    // card move; the next sweep folds the recorded merge and closes the card
    // without adding a second line.
    merger.emit("merged", alphaId);
    await merger.flush();
    await coordinator.settleScan();
    coordinator.stop();
    await context.log.flush();

    const board = await readBoard();
    expect(findColumn(board, "Done")?.cards.map((c) => [c.text, c.checked])).toEqual([
      ["Add feature alpha", true],
    ]);
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(0);
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
    expect(await recordedMergedEvents(alphaId)).toHaveLength(1);
  });

  it("flushes merge_start before git can expose a merge to another process", async () => {
    const stages: string[] = [];
    const pipelineCoordinator = await runToMergeReady(stages);
    pipelineCoordinator.stop();

    const alphaId = ticketIdFromCard(ALPHA_TEXT);
    const ticket = await resolveTicket(ALPHA_TEXT, fixture.ticketsDirectory);
    const report = await loadReport(fixture.stateDirectory, alphaId);
    if (!report || isCorruptReport(report))
      throw new Error("pipeline should save a valid report before integration");

    const integrationContext = fixture.context(autoHandler());
    const integrationLog = new FlushControlledEventLog(fixture.stateDirectory);
    integrationContext.log = integrationLog;
    const outcome = await integrateTicket(integrationContext, ticket, {
      path: path.join(worktreesDirectory(fixture.jfdiDirectory), alphaId),
      branch: `jfdi/${alphaId}`,
    });
    expect(outcome.status).toBe("merged");
    expect(await isAncestor(fixture.projectRoot, report.commit, "main")).toBe(true);
    expect(integrationLog.pendingTypes()).toContain("merged");

    // The merge command has landed and deleted the branch. A coordinator scan
    // must still see the flushed in-flight record and leave narration to it.
    const sweepContext = fixture.context(autoHandler(), { shouldPersistEvents: true });
    const coordinator = new Coordinator(sweepContext, { pollMs: 60_000 });
    await coordinator.start();
    await sweepContext.log.flush();

    await integrationLog.flush();
    await coordinator.settleScan();
    coordinator.stop();
    await sweepContext.log.flush();

    expect(findColumn(await readBoard(), "Ready to Merge")?.cards).toHaveLength(0);
    expect(await recordedMergedEvents(alphaId)).toHaveLength(1);
  });

  it("makes the in-flight record durable on disk before git exposes the landed merge", async () => {
    // QA angle on the same guarantee, independent of the sweep helper above: a
    // REAL persistent EventLog (not a buffering double), instrumented to
    // snapshot at every durability barrier what a foreign process reading disk
    // would see — the on-disk integration record (via the same
    // `integrationRecords` the coordinator uses) and whether git has yet carried
    // the signed-off commit into the target. The fix's promise, and what
    // overview.md now documents, is that no barrier lets git expose the merge
    // before the in-flight record is durable. Against pre-fix code integrate
    // never flushes, so no barrier is observed and the first assertion fails.
    const stages: string[] = [];
    const pipelineCoordinator = await runToMergeReady(stages);
    pipelineCoordinator.stop();

    const alphaId = ticketIdFromCard(ALPHA_TEXT);
    const ticket = await resolveTicket(ALPHA_TEXT, fixture.ticketsDirectory);
    const report = await loadReport(fixture.stateDirectory, alphaId);
    if (!report || isCorruptReport(report))
      throw new Error("pipeline should save a valid report before integration");
    // Narrowing does not flow into class method bodies; capture the commit.
    const signedOffCommit = report.commit;

    const barriers: { recordedPhase: string | undefined; mergeVisibleInTarget: boolean }[] = [];
    class BarrierObservingEventLog extends EventLog {
      override async flush(): Promise<void> {
        await super.flush();
        const records = await integrationRecords(fixture.stateDirectory);
        barriers.push({
          recordedPhase: records.get(alphaId)?.phase,
          mergeVisibleInTarget: await isAncestor(fixture.projectRoot, signedOffCommit, "main"),
        });
      }
    }

    const context = fixture.context(autoHandler());
    context.log = new BarrierObservingEventLog(fixture.stateDirectory);
    const outcome = await integrateTicket(context, ticket, {
      path: path.join(worktreesDirectory(fixture.jfdiDirectory), alphaId),
      branch: `jfdi/${alphaId}`,
    });

    expect(outcome.status).toBe("merged");
    expect(await isAncestor(fixture.projectRoot, report.commit, "main")).toBe(true);
    // A durability barrier ran, and the first one made the in-flight record
    // durable while git still hid the merge — the exact ordering the fix adds.
    expect(barriers[0]?.recordedPhase).toBe("in-flight");
    expect(barriers[0]?.mergeVisibleInTarget).toBe(false);
    // No barrier ever exposed the merge in git without a durable record already
    // present, so a sweep that can see the landed state can always see the record.
    for (const barrier of barriers) {
      if (barrier.mergeVisibleInTarget) expect(barrier.recordedPhase).toBeDefined();
    }
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
    await startCoordinator(coordinator);
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
    await startCoordinator(coordinator);
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
    await git(fixture.projectRoot, "checkout", "-b", "sidetrack");
    await commitFile(fixture.projectRoot, "alpha.txt", "alpha\n", "implement alpha");
    const tip = await parseRevision(fixture.projectRoot, "HEAD");
    await git(fixture.projectRoot, "checkout", "main");
    const alphaId = await strandCard();
    await recordSignOff(alphaId, tip);

    const context = fixture.context(autoHandler());
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(1);
    expect(findColumn(board, "Done")?.cards).toHaveLength(0);
  });

  it("acknowledges a card a human drags from Ready to Merge to Done", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();

    const alphaId = ticketIdFromCard("Add feature alpha");
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("merge-ready");

    const card = findColumn(await readBoard(), "Ready to Merge")?.cards.find((c) =>
      c.text.includes("alpha"),
    );
    if (!card) throw new Error("alpha card is not in Ready to Merge");
    await moveCard(
      path.join(fixture.jfdiDirectory, "board.md"),
      card.raw,
      "Ready to Merge",
      "Done",
    );

    await rescan(coordinator);
    coordinator.stop();

    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
    // Only the dragged card was acknowledged; the other still awaits approval.
    const betaId = ticketIdFromCard("Add feature beta");
    expect(context.log.snapshot().tickets[betaId]?.status).toBe("merge-ready");
  });

  it("closes every hand-merged card in one sweep and leaves the rest of the board alone", async () => {
    // A human who merges a batch and tidies up leaves several cards stranded
    // at once. Each close rewrites board.md, so the sweep is editing the file
    // underneath the card list it is iterating — the cards it has not reached
    // yet must survive that, and the one with no evidence must stay put.
    await fs.writeFile(boardPath(), STRANDED_TRIO_BOARD);
    const alphaId = ticketIdFromCard("Add feature alpha");
    const betaId = ticketIdFromCard("Add feature beta");
    const gammaId = ticketIdFromCard("Add feature gamma");
    await recordSignOff(alphaId, await landAndDeleteBranch(alphaId));
    await recordSignOff(betaId, await landAndDeleteBranch(betaId));

    const context = fixture.context(autoHandler());
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Done")?.cards.map((c) => [c.text, c.checked])).toEqual([
      ["Add feature alpha", true],
      ["Add feature beta", true],
    ]);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([
      "Add feature gamma",
    ]);
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("done");
    expect(context.log.snapshot().tickets[betaId]?.status).toBe("done");
    expect(context.log.snapshot().tickets[gammaId]).toBeUndefined();
  });

  it("acknowledges a Ready-to-Merge card the human deletes from the board", async () => {
    // "Done or elsewhere" includes nowhere: deleting the card answers the
    // approval question too. Asserted against state.json rather than the live
    // snapshot, because that file is what `jfdi status` and a later renderer
    // read — an in-memory-only acknowledgment would not converge them.
    const context = fixture.context(autoHandler(), { shouldPersistEvents: true });
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();

    const alphaId = ticketIdFromCard("Add feature alpha");
    const betaId = ticketIdFromCard("Add feature beta");
    expect((await loadState(fixture.stateDirectory)).tickets[alphaId]?.status).toBe("merge-ready");

    const before = await fs.readFile(boardPath(), "utf8");
    const after = before.replace("- [ ] Add feature alpha\n", "");
    expect(after).not.toBe(before);
    await fs.writeFile(boardPath(), after);

    await rescan(coordinator);
    coordinator.stop();
    await context.log.flush();

    const persisted = await loadState(fixture.stateDirectory);
    expect(persisted.tickets[alphaId]?.status).toBe("done");
    expect(persisted.tickets[alphaId]?.lastActivity).toBe("done");
    // Only the deleted card was acknowledged; the other still awaits approval.
    expect(persisted.tickets[betaId]?.status).toBe("merge-ready");
  });

  it("acknowledges a card the human drags from Ready to Merge to Blocked as blocked", async () => {
    // Blocked is the one destination where "done" would be a lie, but the
    // ticket must still stop advertising an approval question either way.
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();

    const alphaId = ticketIdFromCard("Add feature alpha");
    const card = findColumn(await readBoard(), "Ready to Merge")?.cards.find((c) =>
      c.text.includes("alpha"),
    );
    if (!card) throw new Error("alpha card is not in Ready to Merge");
    await moveCard(boardPath(), card.raw, "Ready to Merge", "Blocked");

    await rescan(coordinator);
    coordinator.stop();

    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("blocked");
  });

  it("reflects a merge another process performed while it is running", async () => {
    const context = fixture.context(autoHandler(), { shouldPersistEvents: true });
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 20 });
    await startCoordinator(coordinator);
    await coordinator.drain();

    const alphaId = ticketIdFromCard("Add feature alpha");
    expect(context.log.snapshot().tickets[alphaId]?.status).toBe("merge-ready");

    // A `jfdi merge` in another terminal: its own EventLog, the same stream.
    const merger = new EventLog(fixture.stateDirectory);
    merger.emit("merge_start", alphaId);
    merger.emit("merged", alphaId);
    await merger.flush();

    // No restart and no board edit — the running coordinator picks it up on poll.
    await waitUntil(() => context.log.snapshot().tickets[alphaId]?.status === "done");
    coordinator.stop();
  });

  it("materializes stage observations as inbox cards and never dispatches them", async () => {
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        const match = /feature (\w+)/.exec(prompt);
        await commitFile(options.cwd, `${match?.[1]}.txt`, "x\n", "impl");
        await writeVerdict(prompt, {
          status: "done",
          observations: ["Dead code in legacy module"],
        });
      } else if (stage === "integration") {
        await writeVerdict(prompt, { resolution: "clean" });
      } else {
        // QA repeats the same observation — must not produce a duplicate card.
        await writeVerdict(prompt, {
          verdict: "pass",
          observations: ["Dead code in legacy module"],
        });
      }
      return { ok: true, text: "" };
    });
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
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

  it("materializes an observation from a failing code review verdict", async () => {
    const implementationAttempts = new Map<string, number>();
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      const name = featureName(prompt);
      if (stage === "implementation") {
        const attempt = (implementationAttempts.get(name) ?? 0) + 1;
        implementationAttempts.set(name, attempt);
        await commitFile(options.cwd, `${name}.txt`, `${attempt}\n`, `implement ${name}`);
        await writeVerdict(prompt, { status: "done", summary: `built ${name}` });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, observedReviewVerdict(implementationAttempts.get(name)));
      } else if (stage === "integration") {
        await writeVerdict(prompt, { resolution: "clean" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();
    coordinator.stop();

    const inbox = findColumn(await readBoard(), "Inbox")?.cards ?? [];
    expect(inbox).toHaveLength(2);
    expect(inbox.every((card) => card.text.includes("Security headers are missing"))).toBe(true);
  });

  it("materializes earlier-round observations when the run blocks", async () => {
    fixture.config.pipeline.maxRounds = 1;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        const name = featureName(prompt);
        await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
        await writeVerdict(prompt, {
          status: "done",
          observations: ["The legacy command still uses an obsolete flag"],
        });
      } else if (stage === "code-review") {
        await writeVerdict(prompt, { verdict: "fail", feedback: "ticket work is incomplete" });
      }
      return { ok: true, text: "" };
    });
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    const inbox = findColumn(board, "Inbox")?.cards ?? [];
    expect(inbox).toHaveLength(2);
    expect(inbox.every((card) => card.text.includes("legacy command"))).toBe(true);
    expect(findColumn(board, "Blocked")?.cards).toHaveLength(2);
  });

  it("re-dispatch skips to integration when the branch still matches the report", async () => {
    const stages: string[] = [];
    const coordinator = await runToMergeReady(stages);
    await moveCard(boardPath(), ALPHA_CARD, "Ready to Merge", "Ready");

    await rescan(coordinator);
    coordinator.stop();

    // No second pipeline: the saved sign-off still describes the branch tip.
    expect(stages.filter((s) => s === "implementation")).toHaveLength(1);
    expect(await fs.readFile(path.join(fixture.projectRoot, "impl-1.txt"), "utf8")).toBe("1\n");
    const done = findColumn(await readBoard(), "Done")?.cards ?? [];
    expect(done.some((c) => c.text.includes("alpha"))).toBe(true);
  });

  it("re-dispatch runs the pipeline when the branch has moved past the report", async () => {
    const stages: string[] = [];
    const coordinator = await runToMergeReady(stages);
    // A human commits on the branch after the sign-off — the report no longer
    // describes what a merge would land.
    const worktree = path.join(
      worktreesDirectory(fixture.jfdiDirectory),
      ticketIdFromCard(ALPHA_TEXT),
    );
    await commitFile(worktree, "by-hand.txt", "hand\n", "human edit");
    await moveCard(boardPath(), ALPHA_CARD, "Ready to Merge", "Ready");

    await rescan(coordinator);
    coordinator.stop();

    // Pipeline re-ran instead of merging the stale branch.
    expect(stages.filter((s) => s === "implementation")).toHaveLength(2);
    await expect(fs.access(path.join(fixture.projectRoot, "impl-1.txt"))).rejects.toThrow();
    expect(findColumn(await readBoard(), "Ready to Merge")?.cards).toHaveLength(1);
  });

  it("continues an In Progress card nothing is driving, instead of blocking it", async () => {
    // The board a dead coordinator leaves: a card in flight with no run behind
    // it. Its branch holds partial work, so the treatment is to pick it back
    // up — the human should not have to drag it anywhere.
    await fs.writeFile(path.join(fixture.jfdiDirectory, "board.md"), ORPHANED_BOARD);
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards).toHaveLength(0);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([
      "Add feature gamma",
    ]);
  });

  it("takes the stranded in-progress card before a waiting one, and counts it against maxConcurrent", async () => {
    // Both columns want the single slot. The in-progress card holds partial
    // work already paid for, so it goes first; the waiting card gets the slot
    // it frees, not a second one alongside it.
    await fs.writeFile(path.join(fixture.jfdiDirectory, "board.md"), STRANDED_AND_WAITING_BOARD);
    const context = fixture.context(autoHandler());
    fixture.config.maxConcurrent = 1;
    fixture.config.integration.mode = "on-approval";
    const dispatched: string[] = [];
    context.log.on((event) => {
      if (event.type === "dispatch" && event.ticketId) dispatched.push(event.ticketId);
    });

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();
    expect(dispatched).toEqual([ticketIdFromCard("Add feature gamma")]);
    expect(coordinator.activeCount()).toBe(0);

    await coordinator.settleScan();
    await coordinator.drain();
    coordinator.stop();

    expect(dispatched).toEqual([
      ticketIdFromCard("Add feature gamma"),
      ticketIdFromCard("Add feature alpha"),
    ]);
    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards).toHaveLength(0);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([
      "Add feature gamma",
      "Add feature alpha",
    ]);
  });

  it("respects maxConcurrent", async () => {
    let peak = 0;
    let current = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        current++;
        peak = Math.max(peak, current);
        await new Promise((resolve) => setImmediate(resolve));
        current--;
        const match = /feature (\w+)/.exec(prompt);
        await commitFile(options.cwd, `${match?.[1]}.txt`, "x\n", "impl");
        await writeVerdict(prompt, { status: "done" });
      } else if (stage === "integration") {
        await writeVerdict(prompt, { resolution: "clean" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    fixture.config.maxConcurrent = 1;
    fixture.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.drain();
    await rescan(coordinator);
    coordinator.stop();
    expect(peak).toBe(1);
  });
});

/**
 * Far enough out that only a human ends this pause within the test, and inside
 * the fixture's cap so the recorded instant is the one we passed in.
 */
const FAR_RESET_MS = 50_000;

/**
 * A usage limit is not the agent being wrong: nothing about the ticket has
 * been learned, so nothing may be spent on it. These pin the two halves of
 * that — a run in flight holds where it stands, and no new run starts.
 */
describe("Coordinator under a broken provider", () => {
  it("holds a run whose provider hit a usage limit, and never blocks its card", async () => {
    await fs.writeFile(boardPath(), SINGLE_CARD_BOARD);
    fixture.config.integration.mode = "on-approval";
    const resetsAtMs = Date.now() + FAR_RESET_MS;
    let implementationAttempts = 0;
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage !== "implementation") {
        await writeVerdict(prompt, { verdict: "pass" });
        return { ok: true, text: "" };
      }
      implementationAttempts++;
      if (implementationAttempts === 1)
        return {
          ok: false,
          text: "",
          failure: {
            kind: "usage-limit" as const,
            resetsAtMs,
            detail: "You've hit your session limit",
          },
        };
      await commitFile(options.cwd, "impl.txt", "work\n", "implement");
      await writeVerdict(prompt, { status: "done", summary: "built alpha" });
      return { ok: true, text: "" };
    });
    const pauses: JfdiEvent[] = [];
    context.log.on((event) => {
      if (event.type === "harness_paused") pauses.push(event);
    });

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await waitUntil(() => pauses.length === 1);

    // Held mid-run: the card is still in flight, and the pause says why and
    // until when, so a renderer can show both.
    const held = await readBoard();
    expect(findColumn(held, "In Progress")?.cards.map((c) => c.text)).toEqual([ALPHA_TEXT]);
    expect(findColumn(held, "Blocked")?.cards).toHaveLength(0);
    expect(pauses[0]?.data).toEqual({
      kind: "usage-limit",
      detail: "You've hit your session limit",
      resumesAt: new Date(resetsAtMs).toISOString(),
    });

    context.pause.retryNow();
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards).toHaveLength(0);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([ALPHA_TEXT]);
    // The dead session cost a respawn, not a round.
    expect(implementationAttempts).toBe(2);
    const report = await loadReport(fixture.stateDirectory, ticketIdFromCard(ALPHA_TEXT));
    expect(report && !isCorruptReport(report) ? report.rounds : null).toBe(1);
  });

  /**
   * "Pause is global" is a claim about the runs already in flight, not only
   * about dispatch: one card's provider failure has to stop the other card's
   * next stage too, and one resume has to release both.
   */
  it("holds every run in flight on one failure, and releases them all on one resume", async () => {
    const pauseSeen = deferred();
    const betaStarted = deferred();
    const sessions: string[] = [];
    let alphaImplementations = 0;
    let hasBetaImplementationFinished = false;
    const healthy = autoHandler();
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      const name = /feature (\w+)/.exec(prompt)?.[1] ?? "unknown";
      sessions.push(`${name}:${stage}`);
      // Beta's session is live when the tool pauses and survives it, so the
      // boundary it holds at is its next stage — the thing under test.
      if (stage === "implementation" && name === "beta") {
        betaStarted.resolve();
        await pauseSeen.promise;
        const result = await healthy(prompt, options);
        hasBetaImplementationFinished = true;
        return result;
      }
      const isFirstAlpha =
        stage === "implementation" && name === "alpha" && ++alphaImplementations === 1;
      if (!isFirstAlpha) return healthy(prompt, options);
      // Only a human ends this one, so nothing resumes behind the test's back.
      await betaStarted.promise;
      return { ok: false, text: "", failure: { kind: "needs-human" as const, detail: "/login" } };
    });
    const pauseEvents: string[] = [];
    context.log.on((event) => {
      if (event.type === "harness_paused") {
        pauseEvents.push(event.type);
        pauseSeen.resolve();
      }
      if (event.type === "harness_resumed") pauseEvents.push(event.type);
    });
    fixture.config.integration.mode = "on-approval";
    fixture.config.maxConcurrent = 2;

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await pauseSeen.promise;
    await waitUntil(() => hasBetaImplementationFinished);

    // Beta finished a stage into a paused tool: it holds rather than starting
    // its review, and alpha holds rather than retrying. The two runs are
    // concurrent, so what matters is the set, not which spawned first.
    expect([...sessions].sort()).toEqual(["alpha:implementation", "beta:implementation"]);
    expect(findColumn(await readBoard(), "Blocked")?.cards).toHaveLength(0);

    context.pause.retryNow();
    await rescan(coordinator);
    coordinator.stop();

    // One pause, one resume, and both runs finished on the far side of it.
    expect(pauseEvents).toEqual(["harness_paused", "harness_resumed"]);
    expect(sessions).toContain("beta:code-review");
    expect(sessions).toContain("alpha:code-review");
    expect(findColumn(await readBoard(), "Ready to Merge")?.cards).toHaveLength(2);
    expect(findColumn(await readBoard(), "Blocked")?.cards).toHaveLength(0);
  });

  it("dispatches nothing while paused, and picks the board up again on resume", async () => {
    const context = fixture.context(autoHandler());
    fixture.config.integration.mode = "on-approval";
    // A needs-human pause carries no timer: only R ends this one.
    const held = context.pause.holdAfterFailure({ kind: "needs-human", detail: "run /login" }, 1);

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    // Complete a scan while paused before asserting the non-event: no dispatch.
    await coordinator.settleScan();
    expect(context.harness.calls).toHaveLength(0);
    expect(findColumn(await readBoard(), "In Progress")?.cards).toHaveLength(0);
    expect(findColumn(await readBoard(), "Ready")?.cards).toHaveLength(2);

    context.pause.retryNow();
    expect(await held).toBe(true);
    await rescan(coordinator);
    coordinator.stop();

    expect(findColumn(await readBoard(), "Ready to Merge")?.cards).toHaveLength(2);
  });
});

/** A minimal board with the given columns, each holding the listed card lines. */
function boardWithColumns(columns: Array<[string, string[]]>): string {
  const body = columns
    .map(([name, cards]) => `## ${name}\n\n${cards.map((card) => `- [ ] ${card}\n`).join("")}`)
    .join("\n");
  return `---\n\nkanban-plugin: board\n\n---\n\n${body}`;
}

async function writeNote(id: string, frontmatter: string): Promise<void> {
  await fs.writeFile(
    path.join(fixture.ticketsDirectory, `${id}.md`),
    `---\n${frontmatter}\n---\n\n# ${id}\n\nSome work to do.\n`,
  );
}

function countTypes(events: JfdiEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

/** Collect the whole event stream a coordinator emits, for per-episode counts. */
function recordEvents(context: ReturnType<Fixture["context"]>): JfdiEvent[] {
  const events: JfdiEvent[] = [];
  context.log.on((event) => events.push(event));
  return events;
}

async function noteComments(id: string): Promise<string[]> {
  const content = await fs.readFile(path.join(fixture.ticketsDirectory, `${id}.md`), "utf8");
  return parseTicketNote(content).comments.map((comment) => comment.body);
}

describe("Coordinator — blocked-by gating", () => {
  it("holds a begin-column card until its blocker reaches Done, then dispatches it", async () => {
    await writeNote("alpha", 'blocked-by:\n  - "[[blocker]]"');
    // The blocker's card is parked off the dispatch path; only reaching Done frees alpha.
    await fs.writeFile(
      boardPath(),
      boardWithColumns([
        ["Ready", ["work on alpha [[alpha]]"]],
        ["In Progress", []],
        ["Done", []],
        ["Backlog", ["the blocker [[blocker]]"]],
      ]),
    );
    const context = fixture.context(countingHandler([]));
    fixture.config.integration.mode = "auto";
    const events = recordEvents(context);

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    // Held across several scans: never dispatched, and announced exactly once.
    await coordinator.settleScan();
    await coordinator.settleScan();
    expect(context.harness.calls).toHaveLength(0);
    expect(findColumn(await readBoard(), "Ready")?.cards.map((c) => c.text)).toEqual([
      "work on alpha [[alpha]]",
    ]);
    expect(countTypes(events, "blocked_by")).toBe(1);
    expect(countTypes(events, "unblocked")).toBe(0);

    // The blocker lands in Done — the next scan frees alpha, which runs and merges.
    await moveCard(boardPath(), "- [ ] the blocker [[blocker]]", "Backlog", "Done");
    await coordinator.settleScan();
    await coordinator.drain();
    await coordinator.settleScan();
    coordinator.stop();

    expect(findColumn(await readBoard(), "Done")?.cards.some((c) => c.text.includes("alpha"))).toBe(
      true,
    );
    expect(countTypes(events, "blocked_by")).toBe(1);
    expect(countTypes(events, "unblocked")).toBe(1);
  });

  it("holds a card with a dangling blocker and names the missing ticket by id", async () => {
    await writeNote("alpha", 'blocked-by:\n  - "[[ghost]]"');
    await fs.writeFile(
      boardPath(),
      boardWithColumns([
        ["Ready", ["work on alpha [[alpha]]"]],
        ["In Progress", []],
        ["Done", []],
      ]),
    );
    const context = fixture.context(countingHandler([]));
    const events = recordEvents(context);

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    await coordinator.settleScan();
    coordinator.stop();

    expect(context.harness.calls).toHaveLength(0);
    expect(findColumn(await readBoard(), "Ready")?.cards).toHaveLength(1);
    const skips = events.filter((event) => event.type === "blocked_by");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.data?.missing).toEqual(["ghost"]);
  });

  it("deduplicates a blocker listed twice into one skip-event entry", async () => {
    // The shared unresolvedBlockers policy must dedupe on the coordinator path too.
    await writeNote("alpha", 'blocked-by:\n  - "[[ghost]]"\n  - "[[ghost]]"');
    await fs.writeFile(
      boardPath(),
      boardWithColumns([
        ["Ready", ["work on alpha [[alpha]]"]],
        ["In Progress", []],
        ["Done", []],
      ]),
    );
    const context = fixture.context(countingHandler([]));
    const events = recordEvents(context);

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    coordinator.stop();

    const skips = events.filter((event) => event.type === "blocked_by");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.data?.blockers).toEqual(["ghost"]);
    expect(skips[0]?.data?.missing).toEqual(["ghost"]);
  });

  it("moves every member of a two-ticket blocked-by cycle to Blocked with one comment", async () => {
    await writeNote("a", 'blocked-by:\n  - "[[b]]"');
    await writeNote("b", 'blocked-by:\n  - "[[a]]"');
    await fs.writeFile(
      boardPath(),
      boardWithColumns([
        ["Ready", ["a [[a]]", "b [[b]]"]],
        ["In Progress", []],
        ["Done", []],
      ]),
    );
    const context = fixture.context(countingHandler([]));
    const events = recordEvents(context);

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await startCoordinator(coordinator);
    // A second scan must not re-report the same deadlock.
    await coordinator.settleScan();
    coordinator.stop();

    const cycleErrors = events.filter(
      (event) => event.type === "error" && Array.isArray(event.data?.cycle),
    );
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0]?.data?.cycle).toEqual(["a", "b"]);
    expect(context.harness.calls).toHaveLength(0);
    const board = await readBoard();
    expect(findColumn(board, "Ready")?.cards).toHaveLength(0);
    expect(findColumn(board, "Blocked")?.cards.map((card) => ticketIdFromCard(card.text))).toEqual([
      "a",
      "b",
    ]);
    const message =
      "Blocked-by loop: a → b → a. A human must break the loop by removing one blocked-by link.";
    expect(await noteComments("a")).toEqual([message]);
    expect(await noteComments("b")).toEqual([message]);
  });

  it("moves every member of a three-ticket blocked-by cycle to Blocked with one comment", async () => {
    await writeNote("a", 'blocked-by:\n  - "[[c]]"');
    await writeNote("b", 'blocked-by:\n  - "[[a]]"');
    await writeNote("c", 'blocked-by:\n  - "[[b]]"');
    await fs.writeFile(
      boardPath(),
      boardWithColumns([
        ["Ready", ["a [[a]]", "b [[b]]", "c [[c]]"]],
        ["In Progress", []],
        ["Done", []],
      ]),
    );
    const context = fixture.context(countingHandler([]));
    const coordinator = new Coordinator(context, { pollMs: 60_000 });

    await startCoordinator(coordinator);
    await coordinator.settleScan();
    coordinator.stop();

    expect(context.harness.calls).toHaveLength(0);
    const board = await readBoard();
    expect(findColumn(board, "Ready")?.cards).toHaveLength(0);
    expect(findColumn(board, "Blocked")?.cards.map((card) => ticketIdFromCard(card.text))).toEqual([
      "a",
      "b",
      "c",
    ]);
    const message =
      "Blocked-by loop: a → c → b → a. A human must break the loop by removing one blocked-by link.";
    for (const id of ["a", "b", "c"]) expect(await noteComments(id)).toEqual([message]);
  });

  it("re-blocks a returned loop member until a human removes one link", async () => {
    await writeNote("a", 'blocked-by:\n  - "[[b]]"');
    await writeNote("b", 'blocked-by:\n  - "[[a]]"');
    await fs.writeFile(
      boardPath(),
      boardWithColumns([
        ["Ready", ["a [[a]]", "b [[b]]"]],
        ["In Progress", []],
        ["Done", []],
      ]),
    );
    const context = fixture.context(countingHandler([]));
    const coordinator = new Coordinator(context, { pollMs: 60_000 });

    await startCoordinator(coordinator);
    await moveCard(boardPath(), "- [ ] a [[a]]", "Blocked", "Ready");
    await coordinator.settleScan();
    expect(findColumn(await readBoard(), "Blocked")?.cards).toHaveLength(2);
    expect(await noteComments("a")).toHaveLength(2);
    expect(await noteComments("b")).toHaveLength(1);
    expect(context.harness.calls).toHaveLength(0);

    const aNotePath = path.join(fixture.ticketsDirectory, "a.md");
    const aNote = await fs.readFile(aNotePath, "utf8");
    await fs.writeFile(aNotePath, aNote.replace('blocked-by:\n  - "[[b]]"\n', ""));
    await moveCard(boardPath(), "- [ ] a [[a]]", "Blocked", "Ready");
    await rescan(coordinator);
    coordinator.stop();

    expect(context.harness.calls.length).toBeGreaterThan(0);
    expect(findColumn(await readBoard(), "Blocked")?.cards.map((card) => card.text)).toEqual([
      "b [[b]]",
    ]);
  });
});
