import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findColumn, moveCard, parseBoard } from "../board.js";
import {
  commitFile,
  type Fixture,
  makeFixture,
  sessionKindOf,
  writeVerdict,
} from "../test-helpers.js";
import { runTicketInline } from "./run.js";

let fixture: Fixture;

const BOARD = `---

kanban-plugin: board

---

## Ready

- [ ] Add feature alpha

## In Progress

## Done

## Blocked

## Ready to Merge

`;

const CARD = "Add feature alpha";

function boardPath(): string {
  return path.join(fixture.jfdiDir, "board.md");
}

async function writeBoard(content: string): Promise<void> {
  await fs.writeFile(boardPath(), content);
}

async function readBoard(): Promise<ReturnType<typeof parseBoard>> {
  return parseBoard(await fs.readFile(boardPath(), "utf8"));
}

/** Handler that implements each ticket by writing a file named for its card. */
function passingHandler(onImplementation?: () => Promise<void>) {
  return async (spec: { prompt: string }, options: { cwd: string }) => {
    const stage = sessionKindOf(spec.prompt);
    if (stage === "implementation") {
      const match = /feature (\w+)/.exec(spec.prompt);
      const name = match?.[1] ?? "unknown";
      await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
      await writeVerdict(spec.prompt, { status: "done", summary: `built ${name}` });
      await onImplementation?.();
    } else if (stage === "integration") {
      await writeVerdict(spec.prompt, { resolution: "clean" });
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

describe("jfdi run — board card", () => {
  it("on-approval: moves the matching card from the begin column to Ready to Merge", async () => {
    await writeBoard(BOARD);
    fixture.config.integration.mode = "on-approval";

    expect(await runTicketInline(fixture.context(passingHandler()), CARD)).toBe(0);

    const board = await readBoard();
    expect(findColumn(board, "Ready")?.cards).toHaveLength(0);
    expect(findColumn(board, "In Progress")?.cards).toHaveLength(0);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([CARD]);
  });

  it("auto: moves the card to Done and checks it off once merged", async () => {
    await writeBoard(BOARD);
    fixture.config.integration.mode = "auto";

    expect(await runTicketInline(fixture.context(passingHandler()), CARD)).toBe(0);

    expect(await fs.readFile(path.join(fixture.repo, "alpha.txt"), "utf8")).toBe("alpha\n");
    const done = findColumn(await readBoard(), "Done")?.cards ?? [];
    expect(done.map((c) => c.text)).toEqual([CARD]);
    expect(done.map((c) => c.checked)).toEqual([true]);
  });

  it("moves the card to Blocked when the pipeline blocks", async () => {
    await writeBoard(BOARD);
    const context = fixture.context(async (spec) => {
      await writeVerdict(spec.prompt, {
        status: "escalate",
        question: "which db?",
        recommendation: "sqlite",
      });
      return { ok: true, text: "" };
    });

    expect(await runTicketInline(context, CARD)).toBe(2);

    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards.map((c) => c.text)).toEqual([CARD]);
    expect(findColumn(board, "In Progress")?.cards).toHaveLength(0);
  });

  it("mid-run: still parks the card when a human moved it meanwhile", async () => {
    await writeBoard(BOARD);
    fixture.config.integration.mode = "on-approval";
    // The human drags the card to Blocked while implementation is running.
    const handler = passingHandler(() =>
      moveCard(boardPath(), `- [ ] ${CARD}`, "In Progress", "Blocked"),
    );

    expect(await runTicketInline(fixture.context(handler), CARD)).toBe(0);

    const board = await readBoard();
    expect(findColumn(board, "Blocked")?.cards).toHaveLength(0);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([CARD]);
  });

  it("picks the card up from In Progress without duplicating it", async () => {
    await writeBoard(
      BOARD.replace(`## Ready\n\n- [ ] ${CARD}\n`, "## Ready\n").replace(
        "## In Progress\n",
        `## In Progress\n\n- [ ] ${CARD}\n`,
      ),
    );
    fixture.config.integration.mode = "on-approval";

    expect(await runTicketInline(fixture.context(passingHandler()), CARD)).toBe(0);

    const board = await readBoard();
    expect(findColumn(board, "In Progress")?.cards).toHaveLength(0);
    expect(findColumn(board, "Ready to Merge")?.cards.map((c) => c.text)).toEqual([CARD]);
  });

  it("leaves the board alone when no card matches the ticket", async () => {
    await writeBoard(BOARD);
    fixture.config.integration.mode = "on-approval";

    expect(await runTicketInline(fixture.context(passingHandler()), "Add feature beta")).toBe(0);

    expect(await fs.readFile(boardPath(), "utf8")).toBe(BOARD);
  });

  it("runs boardless when there is no board file", async () => {
    fixture.config.integration.mode = "on-approval";

    expect(await runTicketInline(fixture.context(passingHandler()), CARD)).toBe(0);

    await expect(fs.access(boardPath())).rejects.toThrow();
  });
});
