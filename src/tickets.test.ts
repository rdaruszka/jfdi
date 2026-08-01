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
    const t = await resolveTicket("Add a --help flag", ticketsDir);
    expect(t.spec).toBe("Add a --help flag");
    expect(t.notePath).toBeNull();
    expect(t.mode).toBe("default");
  });

  it("wikilinked note body becomes the spec", async () => {
    await fs.writeFile(
      path.join(ticketsDir, "fix-thing.md"),
      "# Fix the thing\n\nDetailed spec here.\n",
    );
    const t = await resolveTicket("Fix it [[fix-thing]]", ticketsDir);
    expect(t.spec).toContain("Detailed spec here.");
    expect(t.notePath).toBe(path.join(ticketsDir, "fix-thing.md"));
    expect(t.id).toBe("fix-thing");
  });

  it("reads mode: ask from frontmatter and strips it from the spec", async () => {
    await fs.writeFile(
      path.join(ticketsDir, "careful.md"),
      "---\nmode: ask\n---\n\nSensitive work.\n",
    );
    const t = await resolveTicket("[[careful]]", ticketsDir);
    expect(t.mode).toBe("ask");
    expect(t.spec).toBe("Sensitive work.");
  });

  it("wikilink with missing note falls back to card text as spec", async () => {
    const t = await resolveTicket("Do it [[ghost]]", ticketsDir);
    expect(t.spec).toBe("Do it [[ghost]]");
    expect(t.notePath).toBe(path.join(ticketsDir, "ghost.md"));
  });
});

describe("ensureTicketNote", () => {
  it("creates a note for card-only tickets", async () => {
    const t = await resolveTicket("Add a --help flag", ticketsDir);
    const notePath = await ensureTicketNote(t, ticketsDir);
    expect(notePath).toBe(path.join(ticketsDir, `${t.id}.md`));
    expect(await fs.readFile(notePath, "utf8")).toContain("Add a --help flag");
  });

  it("does not clobber an existing note", async () => {
    const p = path.join(ticketsDir, "fix-thing.md");
    await fs.writeFile(p, "original");
    const t = await resolveTicket("[[fix-thing]]", ticketsDir);
    await ensureTicketNote(t, ticketsDir);
    expect(await fs.readFile(p, "utf8")).toBe("original");
  });
});

describe("appendToSection", () => {
  it("creates the section at end of file when absent", async () => {
    const p = path.join(ticketsDir, "n.md");
    await fs.writeFile(p, "# Title\n\nBody.\n");
    await appendToSection(p, "Decisions", "- chose sqlite over flat files");
    const content = await fs.readFile(p, "utf8");
    expect(content).toBe("# Title\n\nBody.\n\n## Decisions\n\n- chose sqlite over flat files\n");
  });

  it("appends within an existing section, before the next heading", async () => {
    const p = path.join(ticketsDir, "n.md");
    await fs.writeFile(p, "# T\n\n## Decisions\n\n- first\n\n## Report\n\ndone\n");
    await appendToSection(p, "Decisions", "- second");
    const content = await fs.readFile(p, "utf8");
    expect(content).toContain("- first\n\n- second\n\n## Report");
  });

  it("creates the file when missing", async () => {
    const p = path.join(ticketsDir, "new.md");
    await appendToSection(p, "Questions", "**Q:** which db?\n**Recommendation:** none");
    expect(await fs.readFile(p, "utf8")).toContain("## Questions");
  });
});
