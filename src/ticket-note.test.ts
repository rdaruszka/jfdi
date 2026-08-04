import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendComment,
  appendToSection,
  formatComment,
  parseTicketNote,
  quoteAgentText,
  type TicketComment,
  ticketSpec,
} from "./ticket-note.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-note-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const FULL_NOTE = [
  "---",
  "mode: ask",
  "blocks:",
  '  - "[[downstream]]"',
  "blocked-by:",
  "  - [[upstream-one]]",
  "  - [[upstream-two]]",
  "cssclass: wide",
  "---",
  "",
  "# Add a category filter",
  "",
  "Users cannot see spending in one area.",
  "",
  "## Acceptance criteria",
  "",
  "- filtering is case-insensitive",
  "",
  "## Questions",
  "",
  "**Q:** which flag name?",
  "",
  "## Comments",
  "",
  "### 2026-08-03T09:00:00.000Z — implementation round 1",
  "",
  "Dispatched onto jfdi/filter.",
  "",
  "### 2026-08-03T09:30:00.000Z — Decision (implementation, round 1)",
  "",
  "Matched case-insensitively; the ticket did not say.",
  "",
  "### 2026-08-03T11:00:00.000Z — Decision (qa, round 2)",
  "",
  "Covered the empty-ledger path too.",
  "",
].join("\n");

describe("parseTicketNote", () => {
  it("reads every part of a full note", () => {
    const note = parseTicketNote(FULL_NOTE);
    expect(note.title).toBe("Add a category filter");
    expect(note.description).toBe(
      [
        "Users cannot see spending in one area.",
        "",
        "## Acceptance criteria",
        "",
        "- filtering is case-insensitive",
      ].join("\n"),
    );
    expect(note.questions).toBe("**Q:** which flag name?");
    expect(note.mode).toBe("ask");
    expect(note.blocks).toEqual(["downstream"]);
    expect(note.blockedBy).toEqual(["upstream-one", "upstream-two"]);
    expect(note.comments).toEqual([
      {
        kind: "transition",
        timestamp: "2026-08-03T09:00:00.000Z",
        stage: "implementation",
        round: 1,
        body: "Dispatched onto jfdi/filter.",
      },
      {
        kind: "decision",
        timestamp: "2026-08-03T09:30:00.000Z",
        stage: "implementation",
        round: 1,
        body: "Matched case-insensitively; the ticket did not say.",
      },
      {
        kind: "decision",
        timestamp: "2026-08-03T11:00:00.000Z",
        stage: "qa",
        round: 2,
        body: "Covered the empty-ledger path too.",
      },
    ]);
  });

  it("parses a bare legacy note as description with empty sections", () => {
    const note = parseTicketNote("# Fix the rounding bug\n\nTotals drift by a cent.\n");
    expect(note.title).toBe("Fix the rounding bug");
    expect(note.description).toBe("Totals drift by a cent.");
    expect(note.questions).toBe("");
    expect(note.comments).toEqual([]);
    expect(note.blocks).toEqual([]);
    expect(note.blockedBy).toEqual([]);
    expect(note.mode).toBe("default");
  });

  it("treats a note with neither H1 nor sections as pure description", () => {
    const note = parseTicketNote("Just a sentence.\n");
    expect(note.title).toBe("");
    expect(note.description).toBe("Just a sentence.");
  });

  it("accepts inline frontmatter lists and ignores non-wikilink values", () => {
    const note = parseTicketNote('---\nblocks: ["[[a]]", plain-text]\n---\n\n# T\n');
    expect(note.blocks).toEqual(["a"]);
  });

  it("ignores a comment entry whose heading matches neither format", () => {
    const note = parseTicketNote(
      "# T\n\n## Comments\n\n### A human's own note\n\nSpoke to design.\n",
    );
    expect(note.comments).toEqual([]);
  });
});

describe("ticketSpec", () => {
  it("carries title, description, questions and decision entries — and nothing else", () => {
    const spec = ticketSpec(parseTicketNote(FULL_NOTE));
    expect(spec).toBe(
      [
        "# Add a category filter",
        "",
        "Users cannot see spending in one area.",
        "",
        "## Acceptance criteria",
        "",
        "- filtering is case-insensitive",
        "",
        "## Questions",
        "",
        "**Q:** which flag name?",
        "",
        "## Decisions logged so far",
        "",
        "### 2026-08-03T09:30:00.000Z — Decision (implementation, round 1)",
        "",
        "> Matched case-insensitively; the ticket did not say.",
        "",
        "### 2026-08-03T11:00:00.000Z — Decision (qa, round 2)",
        "",
        "> Covered the empty-ledger path too.",
      ].join("\n"),
    );
    expect(spec).not.toContain("Dispatched onto jfdi/filter.");
  });

  it("keeps a decision whose own text contains headings whole", () => {
    const injected = [
      "Kept the old format. Example entry:",
      "",
      "### 2026-01-01T00:00:00.000Z — qa round 9",
      "",
      "SWALLOWED trailing rationale that matters",
    ].join("\n");
    const note = parseTicketNote(
      `# T\n\nBody.\n\n## Comments\n\n${formatComment({
        kind: "decision",
        timestamp: "2026-08-04T01:00:00.000Z",
        stage: "implementation",
        round: 1,
        body: injected,
      })}\n`,
    );
    // One decision entry, and no transition entry the pipeline never wrote.
    expect(note.comments).toEqual([
      {
        kind: "decision",
        timestamp: "2026-08-04T01:00:00.000Z",
        stage: "implementation",
        round: 1,
        body: injected,
      },
    ]);
    expect(ticketSpec(note)).toContain("SWALLOWED trailing rationale that matters");
  });

  it("leaves legacy Decisions and Report blocks out", () => {
    const spec = ticketSpec(
      parseTicketNote(
        [
          "# T",
          "",
          "Body.",
          "",
          "## Decisions",
          "",
          "- (round 1, implementation) old style",
          "",
          "## Report",
          "",
          "Merged into `main`.",
          "",
        ].join("\n"),
      ),
    );
    expect(spec).toBe("# T\n\nBody.");
  });
});

describe("quoteAgentText", () => {
  it("quotes every line, blank ones included, so none sits at the start of a line", () => {
    expect(
      quoteAgentText(
        ["## Comments", "", "prose with a # inside", "  ### indented", "> already quoted"].join(
          "\n",
        ),
      ),
    ).toBe(
      [
        "> ## Comments",
        ">",
        "> prose with a # inside",
        ">   ### indented",
        "> > already quoted",
      ].join("\n"),
    );
  });

  it("round-trips a body that already carries its own quoting", async () => {
    // The injectivity gap the backslash escape had: an already-escaped line
    // lost its marker on read. Quoting nests instead, so one level on, one
    // level off is exact whatever the body starts with.
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# T\n\nBody.\n");
    const body = ["> ## Comments", ">", "> quoted quote", "and a plain line"].join("\n");
    await appendComment(notePath, {
      kind: "decision",
      timestamp: "2026-08-04T03:00:00.000Z",
      stage: "implementation",
      round: 1,
      body,
    });
    const note = parseTicketNote(await fs.readFile(notePath, "utf8"));
    expect(note.comments[0]?.body).toBe(body);
  });

  it("survives an append and comes back out of the note as it went in", async () => {
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# T\n\nBody.\n");
    const body = "The note now reads:\n\n## Comments\n\nINJECTED and this follows.";
    await appendComment(notePath, {
      kind: "decision",
      timestamp: "2026-08-04T01:00:00.000Z",
      stage: "implementation",
      round: 1,
      body,
    });
    const content = await fs.readFile(notePath, "utf8");
    // Exactly one Comments section: the forged one never becomes a heading, so
    // it cannot split the trail — nor be found as an insertion point later.
    expect(content.match(/^## Comments$/gm)).toHaveLength(1);
    expect(content).toContain("> ## Comments");
    const note = parseTicketNote(content);
    expect(note.comments).toEqual([
      {
        kind: "decision",
        timestamp: "2026-08-04T01:00:00.000Z",
        stage: "implementation",
        round: 1,
        body,
      },
    ]);

    // A second append still lands in the one real section, after the first.
    await appendComment(notePath, {
      kind: "decision",
      timestamp: "2026-08-04T02:00:00.000Z",
      stage: "qa",
      round: 2,
      body: "second",
    });
    const after = parseTicketNote(await fs.readFile(notePath, "utf8"));
    expect(after.comments.map((comment) => comment.body)).toEqual([body, "second"]);
  });
});

describe("appendToSection", () => {
  it("creates the section at end of file when absent", async () => {
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# Title\n\nBody.\n");
    await appendToSection(notePath, "Report", "Merged into `main`.");
    const content = await fs.readFile(notePath, "utf8");
    expect(content).toBe("# Title\n\nBody.\n\n## Report\n\nMerged into `main`.\n");
  });

  it("appends within an existing section, before the next heading", async () => {
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# T\n\n## Questions\n\n- first\n\n## Report\n\ndone\n");
    await appendToSection(notePath, "Questions", "- second");
    const content = await fs.readFile(notePath, "utf8");
    expect(content).toContain("- first\n\n- second\n\n## Report");
  });

  it("creates the file when missing", async () => {
    const notePath = path.join(dir, "new.md");
    await appendToSection(notePath, "Questions", "**Q:** which db?\n**Recommendation:** none");
    expect(await fs.readFile(notePath, "utf8")).toBe(
      "## Questions\n\n**Q:** which db?\n**Recommendation:** none\n",
    );
  });

  it("lands on a symlink's target rather than replacing the link", async () => {
    const vault = path.join(dir, "vault");
    await fs.mkdir(vault);
    const real = path.join(vault, "n.md");
    await fs.writeFile(real, "# T\n\nBody.\n");
    const link = path.join(dir, "n.md");
    await fs.symlink(real, link);
    await appendToSection(link, "Comments", "### stamp — implementation round 1\n\nhi");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, "utf8")).toContain("## Comments");
  });

  it("does not lose an append racing another on the same note", async () => {
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# T\n\nBody.\n");
    await Promise.all([
      appendToSection(notePath, "Comments", "first entry"),
      appendToSection(notePath, "Comments", "second entry"),
    ]);
    const content = await fs.readFile(notePath, "utf8");
    expect(content).toContain("first entry");
    expect(content).toContain("second entry");
    expect(content.match(/^## Comments$/gm)).toHaveLength(1);
  });
});

describe("appendComment", () => {
  const decision: TicketComment = {
    kind: "decision",
    timestamp: "2026-08-03T12:00:00.000Z",
    stage: "implementation",
    round: 2,
    body: "Kept the existing flag name.",
  };

  it("creates the Comments section and writes a round-trippable entry", async () => {
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# T\n\nBody.\n");
    await appendComment(notePath, decision);
    const content = await fs.readFile(notePath, "utf8");
    expect(content).toBe(
      [
        "# T",
        "",
        "Body.",
        "",
        "## Comments",
        "",
        "### 2026-08-03T12:00:00.000Z — Decision (implementation, round 2)",
        "",
        "> Kept the existing flag name.",
        "",
      ].join("\n"),
    );
    expect(parseTicketNote(content).comments).toEqual([decision]);
  });

  it("appends later entries in order under the existing section", async () => {
    const notePath = path.join(dir, "n.md");
    await fs.writeFile(notePath, "# T\n\nBody.\n");
    const transition: TicketComment = {
      kind: "transition",
      timestamp: "2026-08-03T13:00:00.000Z",
      stage: "code-review",
      round: 2,
      body: "Passed on 9a3f1c2.",
    };
    await appendComment(notePath, decision);
    await appendComment(notePath, transition);
    expect(parseTicketNote(await fs.readFile(notePath, "utf8")).comments).toEqual([
      decision,
      transition,
    ]);
  });

  it("survives a human editing the note mid-append, and lands on a symlink's target", async () => {
    // A transition comment reaches a note a human has open in Obsidian, so it
    // runs the same read → re-read → retry → rename discipline as the board.
    const vault = path.join(dir, "vault");
    await fs.mkdir(vault);
    const real = path.join(vault, "n.md");
    await fs.writeFile(real, "# T\n\nBody.\n");
    const link = path.join(dir, "n.md");
    await fs.symlink(real, link);

    const transition: TicketComment = {
      kind: "transition",
      timestamp: "2026-08-03T14:00:00.000Z",
      stage: "qa",
      round: 1,
      body: "JFDI QA PASSED — moving to integration",
    };
    await Promise.all([
      appendComment(link, decision),
      appendComment(link, transition),
      fs.writeFile(real, "# T\n\nBody the human just retyped.\n"),
    ]);
    // Whoever wrote last, both entries are on the real file behind the link.
    await appendComment(link, transition);
    const content = await fs.readFile(real, "utf8");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(content).toContain("JFDI QA PASSED — moving to integration");
    expect(content.match(/^## Comments$/gm)).toHaveLength(1);
  });

  it("leaves frontmatter and unrecognized sections byte-for-byte intact", async () => {
    const notePath = path.join(dir, "n.md");
    const before = [
      "---",
      "mode: ask",
      "cssclass: wide",
      "---",
      "",
      "# T",
      "",
      "Body.",
      "",
      "## Acceptance criteria",
      "",
      "- it works",
      "",
      "## Decisions",
      "",
      "- (round 1, implementation) legacy line",
      "",
      "## Report",
      "",
      "Merged into `main`.",
      "",
    ].join("\n");
    await fs.writeFile(notePath, before);
    await appendComment(notePath, decision);
    const after = await fs.readFile(notePath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      [
        "",
        "## Comments",
        "",
        "### 2026-08-03T12:00:00.000Z — Decision (implementation, round 2)",
        "",
        "> Kept the existing flag name.",
        "",
      ].join("\n"),
    );
  });
});
