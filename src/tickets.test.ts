import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToSection, ensureTicketNote, resolveTicket } from "./tickets.js";

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

  it("pins the spec slice: the whole note body, minus frontmatter", async () => {
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
        "## Questions",
        "",
        "**Q:** which database?",
        "",
        "## Decisions",
        "",
        "- (round 1, implementation) chose sqlite",
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
        "## Questions",
        "",
        "**Q:** which database?",
        "",
        "## Decisions",
        "",
        "- (round 1, implementation) chose sqlite",
        "",
        "## Report",
        "",
        "Shipped in 2 rounds.",
      ].join("\n"),
    );
  });

  it("wikilink with missing note falls back to card text as spec", async () => {
    const ticket = await resolveTicket("Do it [[ghost]]", ticketsDir);
    expect(ticket.spec).toBe("Do it [[ghost]]");
    expect(ticket.notePath).toBe(path.join(ticketsDir, "ghost.md"));
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

describe("appendToSection", () => {
  it("creates the section at end of file when absent", async () => {
    const notePath = path.join(ticketsDir, "n.md");
    await fs.writeFile(notePath, "# Title\n\nBody.\n");
    await appendToSection(notePath, "Decisions", "- chose sqlite over flat files");
    const content = await fs.readFile(notePath, "utf8");
    expect(content).toBe("# Title\n\nBody.\n\n## Decisions\n\n- chose sqlite over flat files\n");
  });

  it("appends within an existing section, before the next heading", async () => {
    const notePath = path.join(ticketsDir, "n.md");
    await fs.writeFile(notePath, "# T\n\n## Decisions\n\n- first\n\n## Report\n\ndone\n");
    await appendToSection(notePath, "Decisions", "- second");
    const content = await fs.readFile(notePath, "utf8");
    expect(content).toContain("- first\n\n- second\n\n## Report");
  });

  it("creates the file when missing", async () => {
    const notePath = path.join(ticketsDir, "new.md");
    await appendToSection(notePath, "Questions", "**Q:** which db?\n**Recommendation:** none");
    expect(await fs.readFile(notePath, "utf8")).toContain("## Questions");
  });
});
