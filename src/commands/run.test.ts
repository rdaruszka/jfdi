import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findColumn, moveCard, parseBoard } from "../board.js";
import {
  commitFile,
  type Fixture,
  makeFixture,
  sessionKindOf,
  writeVerdict,
} from "../test-helpers.js";
import { ticketIdFromCard } from "../util/ids.js";
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
  return async (prompt: string, options: { cwd: string }) => {
    const stage = sessionKindOf(prompt);
    if (stage === "implementation") {
      const match = /feature (\w+)/.exec(prompt);
      const name = match?.[1] ?? "unknown";
      await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
      await writeVerdict(prompt, { status: "done", summary: `built ${name}` });
      await onImplementation?.();
    } else if (stage === "integration") {
      await writeVerdict(prompt, { resolution: "clean" });
    } else {
      await writeVerdict(prompt, { verdict: "pass" });
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
  it("refuses a corrupt report, preserves it, and moves the card to Blocked", async () => {
    await writeBoard(BOARD);
    const ticketId = ticketIdFromCard(CARD);
    const reportPath = path.join(fixture.stateDir, "runs", ticketId, "report.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const corruptContent = '{"summary":';
    await fs.writeFile(reportPath, corruptContent);
    const handler = vi.fn(passingHandler());

    expect(await runTicketInline(fixture.context(handler), CARD)).toBe(2);

    expect(handler).not.toHaveBeenCalled();
    expect(findColumn(await readBoard(), "Blocked")?.cards.map((card) => card.text)).toEqual([
      CARD,
    ]);
    expect(await fs.readFile(reportPath, "utf8")).toBe(corruptContent);
    const note = await fs.readFile(path.join(fixture.ticketsDirectory, `${ticketId}.md`), "utf8");
    expect(note).toContain(reportPath);
    expect(note).toContain("fix or restore");
    expect(note).toContain("delete the file");
  });

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
    const context = fixture.context(async (prompt) => {
      await writeVerdict(prompt, {
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

    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handler = async (prompt: string, options: { cwd: string }) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "alpha.txt", "alpha\n", "implement alpha");
        await writeVerdict(prompt, {
          status: "done",
          summary: "built alpha",
          observations: ["The legacy executable has no owner"],
        });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    };

    expect(await runTicketInline(fixture.context(handler), CARD)).toBe(0);

    await expect(fs.access(boardPath())).rejects.toThrow();
    expect(logs.mock.calls.flat().join("\n")).toContain("The legacy executable has no owner");
    logs.mockRestore();
  });
});

const BLOCKED_TICKET_CARD = "Add feature alpha [[alpha]]";

/** A board carrying only the blocker card, so a run reads its column for done-ness. */
function boardWithBlocker(column: string): string {
  return `---

kanban-plugin: board

---

## Ready

## Done

## ${column}

- [ ] fix the blocker [[blocker]]
`;
}

async function writeNote(id: string, frontmatter: string): Promise<void> {
  await fs.writeFile(
    path.join(fixture.ticketsDirectory, `${id}.md`),
    `---\n${frontmatter}\n---\n\n# ${id}\n\nSome work to do.\n`,
  );
}

describe("jfdi run — blocked-by", () => {
  it("refuses a ticket whose blocker is not done, naming it and running nothing", async () => {
    await writeNote("alpha", "blocked-by: [[blocker]]");
    await writeBoard(boardWithBlocker("Ready"));
    const context = fixture.context(passingHandler());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runTicketInline(context, BLOCKED_TICKET_CARD)).toBe(2);

    expect(context.harness.calls).toHaveLength(0);
    expect(errors.mock.calls.flat().join("\n")).toContain("blocker");
    errors.mockRestore();
  });

  it("names a dangling blocker that has no card at all", async () => {
    await writeNote("alpha", 'blocked-by:\n  - "[[ghost]]"');
    await writeBoard(boardWithBlocker("Ready"));
    const context = fixture.context(passingHandler());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runTicketInline(context, BLOCKED_TICKET_CARD)).toBe(2);

    expect(errors.mock.calls.flat().join("\n")).toContain("ghost (no card on the board)");
    errors.mockRestore();
  });

  it("runs a ticket whose blocker sits in Done", async () => {
    await writeNote("alpha", 'blocked-by:\n  - "[[blocker]]"');
    await writeBoard(boardWithBlocker("Done"));
    fixture.config.integration.mode = "on-approval";
    const context = fixture.context(passingHandler());

    expect(await runTicketInline(context, BLOCKED_TICKET_CARD)).toBe(0);
    expect(context.harness.calls.length).toBeGreaterThan(0);
  });

  it("--force runs a blocked ticket anyway, still printing the blockers", async () => {
    await writeNote("alpha", 'blocked-by:\n  - "[[blocker]]"');
    await writeBoard(boardWithBlocker("Ready"));
    fixture.config.integration.mode = "on-approval";
    const context = fixture.context(passingHandler());
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await runTicketInline(context, BLOCKED_TICKET_CARD, { isForced: true })).toBe(0);

    expect(context.harness.calls.length).toBeGreaterThan(0);
    expect(warnings.mock.calls.flat().join("\n")).toContain("blocker");
    warnings.mockRestore();
  });
});
