import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unresolvedBlockers } from "./blocking.js";
import type { Board, Card } from "./board.js";
import { ensureTicketNote, resolveTicket } from "./tickets.js";

function readyCard(text: string): Card {
  return { raw: `- [ ] ${text}`, text, checked: false };
}

let dir: string;
let ticketsDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-tickets-"));
  ticketsDir = path.join(dir, "tickets");
  await fs.mkdir(ticketsDir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("resolveTicket", () => {
  it("card without wikilink: card line is the entire spec", async () => {
    const ticket = await resolveTicket("Add a --help flag", ticketsDir);
    expect(ticket.spec).toBe("Add a --help flag");
    expect(ticket.notePath).toBeNull();
    expect(ticket.links).toEqual([]);
    expect(ticket.mode).toBe("default");
  });

  it("wikilinked note body becomes the spec", async () => {
    await fs.writeFile(
      path.join(ticketsDir, "fix-thing.md"),
      "# Fix the thing\n\nDetailed spec here.\n",
    );
    const ticket = await resolveTicket("Fix it [[fix-thing]]", ticketsDir);
    expect(ticket.spec).toContain("Detailed spec here.");
    expect(ticket.notePath).toBe(path.join(ticketsDir, "fix-thing.md"));
    expect(ticket.id).toBe("fix-thing");
  });

  it("reads mode: ask from frontmatter and strips it from the spec", async () => {
    await fs.writeFile(
      path.join(ticketsDir, "careful.md"),
      "---\nmode: ask\n---\n\nSensitive work.\n",
    );
    const ticket = await resolveTicket("[[careful]]", ticketsDir);
    expect(ticket.mode).toBe("ask");
    expect(ticket.spec).toBe("Sensitive work.");
  });

  it("pins the spec slice: title, description, questions and decision comments only", async () => {
    await fs.writeFile(
      path.join(ticketsDir, "full.md"),
      [
        "---",
        "mode: ask",
        "---",
        "",
        "# Fix the thing",
        "",
        "Detailed spec here.",
        "",
        "## Acceptance criteria",
        "",
        "- it works",
        "",
        "## Questions",
        "",
        "**Q:** which database?",
        "",
        "## Comments",
        "",
        "### 2026-08-03T10:00:00.000Z — implementation round 1",
        "",
        "Dispatched, gate green.",
        "",
        "### 2026-08-03T10:05:00.000Z — Decision (implementation, round 1)",
        "",
        "Chose sqlite: already a dependency.",
        "",
        "## Decisions",
        "",
        "- (round 1, implementation) legacy decision line",
        "",
        "## Report",
        "",
        "Shipped in 2 rounds.",
        "",
      ].join("\n"),
    );
    const ticket = await resolveTicket("[[full]]", ticketsDir);
    expect(ticket.spec).toBe(
      [
        "# Fix the thing",
        "",
        "Detailed spec here.",
        "",
        "## Acceptance criteria",
        "",
        "- it works",
        "",
        "## Questions",
        "",
        "**Q:** which database?",
        "",
        "## Decisions logged so far",
        "",
        "### 2026-08-03T10:05:00.000Z — Decision (implementation, round 1)",
        "",
        "> Chose sqlite: already a dependency.",
      ].join("\n"),
    );
    expect(ticket.spec).not.toContain("Dispatched, gate green.");
    expect(ticket.spec).not.toContain("legacy decision line");
    expect(ticket.spec).not.toContain("Shipped in 2 rounds.");
  });

  it("wikilink with missing note falls back to card text as spec", async () => {
    const ticket = await resolveTicket("Do it [[ghost]]", ticketsDir);
    expect(ticket.spec).toBe("Do it [[ghost]]");
    expect(ticket.notePath).toBe(path.join(ticketsDir, "ghost.md"));
  });

  it("resolves blocks/blocked-by links against ticketsDir, marking missing ones unresolved", async () => {
    await fs.writeFile(path.join(ticketsDir, "other.md"), "# Other\n");
    await fs.writeFile(
      path.join(ticketsDir, "linked.md"),
      [
        "---",
        "blocks:",
        '  - "[[other]]"',
        "blocked-by: [[ghost]]",
        "tags: [mine]",
        "---",
        "",
        "# Linked",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const ticket = await resolveTicket("[[linked]]", ticketsDir);
    expect(ticket.links).toEqual([
      { kind: "blocks", target: "other", notePath: path.join(ticketsDir, "other.md") },
      { kind: "blocked-by", target: "ghost", notePath: null },
    ]);
    // Frontmatter is the tool's, not the agent's: none of it reaches the spec.
    expect(ticket.spec).toBe("# Linked\n\nBody.");
  });

  it("never resolves a link outside ticketsDir", async () => {
    await fs.writeFile(path.join(dir, "outside.md"), "# Outside\n");
    await fs.writeFile(
      path.join(ticketsDir, "escaper.md"),
      '---\nblocked-by:\n  - "[[../outside]]"\n---\n\n# Escaper\n',
    );
    const ticket = await resolveTicket("[[escaper]]", ticketsDir);
    expect(ticket.links).toEqual([{ kind: "blocked-by", target: "../outside", notePath: null }]);
  });

  // Regression: the natural hand-written `blocked-by: [[foo]]` (unquoted, inline)
  // once hit a flow-list branch that mangled it to "[foo]", so extractWikilink
  // dropped it and the blocked ticket dispatched anyway. Prove the blocker
  // survives all the way to the dispatch-gating decision, not just the parse.
  it("gates dispatch on an unquoted inline blocked-by wikilink", async () => {
    await fs.writeFile(
      path.join(ticketsDir, "alpha.md"),
      "---\nblocked-by: [[foo]]\n---\n\n# alpha\n\nWork.\n",
    );
    const ticket = await resolveTicket("[[alpha]]", ticketsDir);
    expect(ticket.links).toEqual([{ kind: "blocked-by", target: "foo", notePath: null }]);
    const board: Board = { columns: [{ name: "Ready", cards: [readyCard("foo [[foo]]")] }] };
    expect(unresolvedBlockers(ticket.links, board, "Done").ids).toEqual(["foo"]);
  });
});

describe("ensureTicketNote", () => {
  it("creates a note for card-only tickets", async () => {
    const ticket = await resolveTicket("Add a --help flag", ticketsDir);
    const notePath = await ensureTicketNote(ticket, ticketsDir);
    expect(notePath).toBe(path.join(ticketsDir, `${ticket.id}.md`));
    expect(await fs.readFile(notePath, "utf8")).toContain("Add a --help flag");
  });

  it("does not clobber an existing note", async () => {
    const notePath = path.join(ticketsDir, "fix-thing.md");
    await fs.writeFile(notePath, "original");
    const ticket = await resolveTicket("[[fix-thing]]", ticketsDir);
    await ensureTicketNote(ticket, ticketsDir);
    expect(await fs.readFile(notePath, "utf8")).toBe("original");
  });
});
