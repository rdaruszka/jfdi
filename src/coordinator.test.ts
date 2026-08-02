import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findColumn, parseBoard } from "./board.js";
import { Coordinator } from "./coordinator.js";
import { git } from "./git.js";
import { commitFile, type Fixture, makeFixture, stageOf, writeVerdict } from "./test-helpers.js";
import { ticketIdFromCard } from "./util/ids.js";

let fx: Fixture;

const BOARD = `---

kanban-plugin: board

---

## Ready

- [ ] Add feature alpha
- [ ] Add feature beta

## In Progress

## Done

`;

async function readBoard(): Promise<ReturnType<typeof parseBoard>> {
  return parseBoard(await fs.readFile(path.join(fx.jfdiDir, "board.md"), "utf8"));
}

beforeEach(async () => {
  fx = await makeFixture();
  await fs.writeFile(path.join(fx.jfdiDir, "board.md"), BOARD);
});

afterEach(async () => {
  await fx.cleanup();
});

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

describe("Coordinator", () => {
  it("auto mode: dispatches board cards, runs pipelines, merges, moves cards to Done", async () => {
    const context = fx.context(autoHandler());
    fx.config.integration.mode = "auto";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    coordinator.stop();

    // Both features merged to main.
    expect(await fs.readFile(path.join(fx.repo, "alpha.txt"), "utf8")).toBe("alpha\n");
    expect(await fs.readFile(path.join(fx.repo, "beta.txt"), "utf8")).toBe("beta\n");

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
    const context = fx.context(autoHandler());
    fx.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();
    coordinator.stop();

    const board = await readBoard();
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(2);
    // Nothing merged yet.
    await expect(fs.access(path.join(fx.repo, "alpha.txt"))).rejects.toThrow();

    // Report appended to each ticket note.
    const alphaId = ticketIdFromCard("Add feature alpha");
    const note = await fs.readFile(path.join(fx.ticketsDir, `${alphaId}.md`), "utf8");
    expect(note).toContain("ready to merge");
    expect(note).toContain("built alpha");
  });

  it("blocked tickets move to the Blocked column", async () => {
    const context = fx.context(async (spec) => {
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
    const context = fx.context(autoHandler());
    fx.config.integration.mode = "on-approval";
    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    await coordinator.start();
    await coordinator.drain();

    // Human merges alpha by hand.
    const alphaId = ticketIdFromCard("Add feature alpha");
    await git(fx.repo, "merge", "--ff-only", `jfdi/${alphaId}`);
    const headBefore = await git(fx.repo, "rev-parse", "HEAD");

    coordinator.requestScan();
    await coordinator.drain();
    // Give the async scan a beat to finish card moves.
    await new Promise((r) => setTimeout(r, 200));
    coordinator.stop();

    expect(await git(fx.repo, "rev-parse", "HEAD")).toBe(headBefore);
    const board = await readBoard();
    const doneCards = findColumn(board, "Done")?.cards ?? [];
    expect(doneCards.some((c) => c.text.includes("alpha"))).toBe(true);
    expect(findColumn(board, "Ready to Merge")?.cards).toHaveLength(1);
  });

  it("materializes stage observations as inbox cards and never dispatches them", async () => {
    const context = fx.context(async (spec, options) => {
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
    fx.config.integration.mode = "auto";
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

  it("respects max_concurrent", async () => {
    let peak = 0;
    let current = 0;
    const context = fx.context(async (spec, options) => {
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
    fx.config.max_concurrent = 1;
    fx.config.integration.mode = "auto";
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
