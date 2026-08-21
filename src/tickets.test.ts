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

let directory: string;
let ticketsDirectory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-tickets-"));
  ticketsDirectory = path.join(directory, "tickets");
  await fs.mkdir(ticketsDirectory);
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("resolveTicket", () => {
  it("card without wikilink: card line is the entire description", async () => {
    const ticket = await resolveTicket("Add a --help flag", ticketsDirectory);
    expect(ticket.description).toBe("Add a --help flag");
    expect(ticket.notePath).toBeNull();
    expect(ticket.links).toEqual([]);
    expect(ticket.mode).toBe("default");
  });

  it("wikilinked note body becomes the description", async () => {
    await fs.writeFile(
      path.join(ticketsDirectory, "fix-thing.md"),
      "# Fix the thing\n\nDetailed spec here.\n",
    );
    const ticket = await resolveTicket("Fix it [[fix-thing]]", ticketsDirectory);
    expect(ticket.description).toContain("Detailed spec here.");
    expect(ticket.notePath).toBe(path.join(ticketsDirectory, "fix-thing.md"));
    expect(ticket.id).toBe("fix-thing");
  });

  it("reads mode: ask from frontmatter and strips it from the description", async () => {
    await fs.writeFile(
      path.join(ticketsDirectory, "careful.md"),
      "---\nmode: ask\n---\n\nSensitive work.\n",
    );
    const ticket = await resolveTicket("[[careful]]", ticketsDirectory);
    expect(ticket.mode).toBe("ask");
    expect(ticket.description).toBe("Sensitive work.");
  });

  it("pins the description slice: title, description, questions and decision comments only", async () => {
    await fs.writeFile(
      path.join(ticketsDirectory, "full.md"),
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
    const ticket = await resolveTicket("[[full]]", ticketsDirectory);
    expect(ticket.description).toBe(
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
    expect(ticket.description).not.toContain("Dispatched, gate green.");
    expect(ticket.description).not.toContain("legacy decision line");
    expect(ticket.description).not.toContain("Shipped in 2 rounds.");
  });

  it("wikilink with missing note falls back to card text as its description", async () => {
    const ticket = await resolveTicket("Do it [[ghost]]", ticketsDirectory);
    expect(ticket.description).toBe("Do it [[ghost]]");
    expect(ticket.notePath).toBe(path.join(ticketsDirectory, "ghost.md"));
  });

  it("resolves blocks/blocked-by links against ticketsDirectory, marking missing ones unresolved", async () => {
    await fs.writeFile(path.join(ticketsDirectory, "other.md"), "# Other\n");
    await fs.writeFile(
      path.join(ticketsDirectory, "linked.md"),
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
    const ticket = await resolveTicket("[[linked]]", ticketsDirectory);
    expect(ticket.links).toEqual([
      { kind: "blocks", target: "other", notePath: path.join(ticketsDirectory, "other.md") },
      { kind: "blocked-by", target: "ghost", notePath: null },
    ]);
    // Frontmatter is the tool's, not the agent's: none of it reaches the description.
    expect(ticket.description).toBe("# Linked\n\nBody.");
  });

  it("never resolves a link outside ticketsDirectory", async () => {
    await fs.writeFile(path.join(directory, "outside.md"), "# Outside\n");
    await fs.writeFile(
      path.join(ticketsDirectory, "escaper.md"),
      '---\nblocked-by:\n  - "[[../outside]]"\n---\n\n# Escaper\n',
    );
    const ticket = await resolveTicket("[[escaper]]", ticketsDirectory);
    expect(ticket.links).toEqual([{ kind: "blocked-by", target: "../outside", notePath: null }]);
  });

  // Regression: the natural hand-written `blocked-by: [[foo]]` (unquoted, inline)
  // once hit a flow-list branch that mangled it to "[foo]", so extractWikilink
  // dropped it and the blocked ticket dispatched anyway. Prove the blocker
  // survives all the way to the dispatch-gating decision, not just the parse.
  it("gates dispatch on an unquoted inline blocked-by wikilink", async () => {
    await fs.writeFile(
      path.join(ticketsDirectory, "alpha.md"),
      "---\nblocked-by: [[foo]]\n---\n\n# alpha\n\nWork.\n",
    );
    const ticket = await resolveTicket("[[alpha]]", ticketsDirectory);
    expect(ticket.links).toEqual([{ kind: "blocked-by", target: "foo", notePath: null }]);
    const board: Board = { columns: [{ name: "Ready", cards: [readyCard("foo [[foo]]")] }] };
    expect(unresolvedBlockers(ticket.links, board, "Done").ids).toEqual(["foo"]);
  });
});

describe("ensureTicketNote", () => {
  it("creates a note for card-only tickets", async () => {
    const ticket = await resolveTicket("Add a --help flag", ticketsDirectory);
    const notePath = await ensureTicketNote(ticket, ticketsDirectory);
    expect(notePath).toBe(path.join(ticketsDirectory, `${ticket.id}.md`));
    expect(await fs.readFile(notePath, "utf8")).toContain("Add a --help flag");
  });

  it("does not clobber an existing note", async () => {
    const notePath = path.join(ticketsDirectory, "fix-thing.md");
    await fs.writeFile(notePath, "original");
    const ticket = await resolveTicket("[[fix-thing]]", ticketsDirectory);
    await ensureTicketNote(ticket, ticketsDirectory);
    expect(await fs.readFile(notePath, "utf8")).toBe("original");
  });
});
