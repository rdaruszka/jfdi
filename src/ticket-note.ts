import { atomicWrite, readIfExists, readModifyWrite } from "./util/fsx.js";
import { extractWikilink } from "./util/ids.js";

/**
 * A ticket note's anatomy — the JIRA shape JFDI emulates in markdown:
 * frontmatter, an H1 title, a free-form description, `## Questions`, and an
 * append-only `## Comments` trail. Every part is optional, and an absent one
 * parses as empty rather than as an error: notes predate this anatomy, and a
 * human writes them by hand.
 */
export interface TicketNote {
  /** The H1 text — the canonical title. Empty when the note has no H1. */
  title: string;
  /** The H1 down to the first JFDI-owned section: the body agents implement from. */
  description: string;
  /** The `## Questions` body verbatim — the escalation queue. */
  questions: string;
  /** The `## Comments` entries, oldest first. */
  comments: TicketComment[];
  /** Frontmatter `blocks:` wikilink targets, in file order. */
  blocks: string[];
  /** Frontmatter `blocked-by:` wikilink targets, in file order. */
  blockedBy: string[];
  /** Per-ticket escalation override from frontmatter (`mode: ask`). */
  mode: "default" | "ask";
}

/**
 * One entry in the `## Comments` trail. A *transition* entry is the pipeline
 * narrating a round to humans; a *decision* entry is one assumption or
 * interpretation choice an agent logged — the JIRA emulation, where an agent's
 * decision lands in the same chronological trail a human's would.
 */
export interface TicketComment {
  kind: "transition" | "decision";
  /** ISO-8601 timestamp, as written in the entry heading. */
  timestamp: string;
  /** The stage that produced the entry (`implementation`, `qa`, …). */
  stage: string;
  round: number;
  /** Everything under the heading, verbatim. */
  body: string;
}

const QUESTIONS_SECTION = "Questions";
const COMMENTS_SECTION = "Comments";

/**
 * The section names JFDI owns — the two it reads and the two a pre-anatomy
 * pipeline wrote. They mark where the human's description stops: a note's own
 * sub-sections (`## Acceptance criteria` and friends) are part of the
 * description an agent implements from, while everything from the first
 * JFDI-owned heading on is the tool's record, read only as this file defines.
 */
const JFDI_SECTIONS = new Set([QUESTIONS_SECTION, COMMENTS_SECTION, "Decisions", "Report"]);

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const TITLE_RE = /^#\s+(.+?)\s*$/;
const SECTION_RE = /^##\s+(.+?)\s*$/;
const ENTRY_RE = /^###\s/;
const DECISION_HEADING_RE = /^###\s+(\S+)\s+—\s+Decision\s+\((.+?),\s*round\s+(\d+)\)\s*$/;
const TRANSITION_HEADING_RE = /^###\s+(\S+)\s+—\s+(.+?)\s+round\s+(\d+)\s*$/;
const FRONTMATTER_KEY_RE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const FRONTMATTER_ITEM_RE = /^\s*-\s+(.*)$/;

/**
 * Wrap text JFDI did not author in a markdown blockquote before it lands in a
 * note. Such text arrives from agent verdict JSON — a trust boundary — and a
 * line in it beginning with `#` would forge a section or an entry heading: the
 * trail splits at the forgery, the parser keeps only the first section of a
 * name, and everything after it silently stops reaching later prompts. Quoted,
 * no line of the text sits at the start of a line anymore, so nothing in it
 * can read as note structure — whatever pattern that structure grows next.
 * Quoting nests (`> ` becomes `> > `), so `unquoteAgentText` strips exactly
 * the one level this added and the round trip is exact for any body.
 */
export function quoteAgentText(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Strip exactly one blockquote level — the inverse of `quoteAgentText`. */
function unquoteAgentText(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("> ") ? line.slice(2) : line === ">" ? "" : line))
    .join("\n");
}

/** Parse a note into its anatomy. Absent sections are empty, never an error. */
export function parseTicketNote(content: string): TicketNote {
  const fields = parseFrontmatterFields(FRONTMATTER_RE.exec(content)?.[1] ?? "");
  const lines = content.replace(FRONTMATTER_RE, "").split("\n");
  const firstSection = lines.findIndex((line) => SECTION_RE.test(line));
  const headerEnd = firstSection === -1 ? lines.length : firstSection;
  const descriptionEnd = boundedBy(lines, (name) => JFDI_SECTIONS.has(name));
  const titleIndex = lines.slice(0, headerEnd).findIndex((line) => TITLE_RE.test(line));
  const sections = splitSections(lines, headerEnd);
  return {
    title: titleIndex === -1 ? "" : (TITLE_RE.exec(lines[titleIndex] ?? "")?.[1] ?? ""),
    description: lines
      .slice(titleIndex + 1, descriptionEnd)
      .join("\n")
      .trim(),
    questions: sections.get(QUESTIONS_SECTION) ?? "",
    comments: parseComments(sections.get(COMMENTS_SECTION) ?? ""),
    blocks: wikilinkTargets(fields.get("blocks") ?? []),
    blockedBy: wikilinkTargets(fields.get("blocked-by") ?? []),
    mode: fields.get("mode")?.[0] === "ask" ? "ask" : "default",
  };
}

/**
 * The slice of a note that reaches a stage prompt: title, description, open
 * questions, and the decisions logged so far. Transition entries, legacy
 * `## Decisions`/`## Report` blocks and any other section stay out — the
 * pipeline's narration is for humans, and review feedback reaches the
 * implementer through the feedback history instead.
 */
export function ticketSpec(note: TicketNote): string {
  const parts: string[] = [];
  if (note.title !== "") parts.push(`# ${note.title}`);
  if (note.description !== "") parts.push(note.description);
  if (note.questions !== "") parts.push(`## ${QUESTIONS_SECTION}\n\n${note.questions}`);
  const decisions = note.comments.filter((comment) => comment.kind === "decision");
  if (decisions.length > 0)
    parts.push(`## Decisions logged so far\n\n${decisions.map(formatComment).join("\n\n")}`);
  return parts.join("\n\n");
}

/**
 * Render a comment as it appears in the note — the format `parseComments`
 * reads back. The body is blockquoted, so a comment carrying a heading of its
 * own (an agent quoting this very format in a decision) stays one entry — and
 * in Obsidian the quote bar marks the body as an utterance, the way a JIRA
 * comment reads.
 */
export function formatComment(comment: TicketComment): string {
  const heading =
    comment.kind === "decision"
      ? `### ${comment.timestamp} — Decision (${comment.stage}, round ${comment.round})`
      : `### ${comment.timestamp} — ${comment.stage} round ${comment.round}`;
  return `${heading}\n\n${quoteAgentText(comment.body.trim())}`;
}

/** Append one entry to the note's `## Comments` trail, creating the section if absent. */
export function appendComment(notePath: string, comment: TicketComment): Promise<void> {
  return appendToSection(notePath, COMMENTS_SECTION, formatComment(comment));
}

/**
 * Append content under a `## Heading` of a note, creating the section at the
 * end of the file if absent. Notes are co-edited by humans in Obsidian, so an
 * append to an existing note runs through the same read → re-read → retry →
 * temp-file-rename discipline as the board, landing on a symlink's real
 * target; every byte outside the appended block survives untouched.
 */
export async function appendToSection(
  notePath: string,
  heading: string,
  content: string,
): Promise<void> {
  const block = content.trimEnd();
  // A note that does not exist yet has no concurrent editor to lose a write
  // to, and `readModifyWrite` has nothing to read: create it whole.
  if ((await readIfExists(notePath)) === null) {
    await atomicWrite(notePath, `## ${heading}\n\n${block}\n`);
    return;
  }
  await readModifyWrite(notePath, (existing) => withAppendedBlock(existing, heading, block));
}

function withAppendedBlock(existing: string, heading: string, block: string): string {
  const lines = existing.split("\n");
  // The same notion of a section the parser has: a heading the parser would
  // not see is not one this may append under either.
  const headingIndex = lines.findIndex((line) => SECTION_RE.exec(line)?.[1] === heading);
  if (headingIndex === -1) {
    const base = existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`;
    return `${base}\n## ${heading}\n\n${block}\n`;
  }
  lines.splice(sectionInsertionPoint(lines, headingIndex), 0, "", block);
  const next = lines.join("\n");
  return next.endsWith("\n") ? next : `${next}\n`;
}

/**
 * Line index the block belongs at: just past the section's last non-blank
 * line, which is either the line before the next `## ` heading or the end of
 * the file. Shrinks monotonically from that bound, so it terminates.
 */
function sectionInsertionPoint(lines: string[], headingIndex: number): number {
  let insertAt = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (SECTION_RE.test(lines[index] ?? "")) {
      insertAt = index;
      break;
    }
  }
  while (insertAt > headingIndex + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
  return insertAt;
}

/** Index of the first `## ` line whose name matches, or the line count when none does. */
function boundedBy(lines: string[], matches: (name: string) => boolean): number {
  const index = lines.findIndex((line) => {
    const name = SECTION_RE.exec(line)?.[1];
    return name !== undefined && matches(name);
  });
  return index === -1 ? lines.length : index;
}

/** Section bodies keyed by heading, from `startIndex` on. A repeated heading keeps its first body. */
function splitSections(lines: string[], startIndex: number): Map<string, string> {
  const sections = new Map<string, string>();
  let name: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (name !== null && !sections.has(name)) sections.set(name, buffer.join("\n").trim());
  };
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = SECTION_RE.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      name = match[1];
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function parseComments(section: string): TicketComment[] {
  if (section === "") return [];
  const comments: TicketComment[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    const comment = heading === null ? null : toComment(heading, buffer.join("\n").trim());
    if (comment !== null) comments.push(comment);
  };
  for (const line of section.split("\n")) {
    if (ENTRY_RE.test(line)) {
      flush();
      heading = line;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return comments;
}

/**
 * An entry whose heading matches neither format is a human's own comment (or
 * prose before the first entry): left out of the model deliberately, and left
 * untouched on disk — appends never rewrite what they did not write.
 */
function toComment(heading: string, body: string): TicketComment | null {
  const decision = DECISION_HEADING_RE.exec(heading);
  if (decision?.[1] && decision[2] && decision[3])
    return {
      kind: "decision",
      timestamp: decision[1],
      stage: decision[2],
      round: Number(decision[3]),
      body: unquoteAgentText(body),
    };
  const transition = TRANSITION_HEADING_RE.exec(heading);
  if (transition?.[1] && transition[2] && transition[3])
    return {
      kind: "transition",
      timestamp: transition[1],
      stage: transition[2],
      round: Number(transition[3]),
      body: unquoteAgentText(body),
    };
  return null;
}

/**
 * Frontmatter as key → values, over the YAML subset Obsidian properties emit:
 * scalars and block sequences (`- item` lines). Keys JFDI does not know are
 * read and ignored — humans add their own.
 */
function parseFrontmatterFields(block: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let currentKey: string | null = null;
  for (const line of block.split("\n")) {
    const item = FRONTMATTER_ITEM_RE.exec(line);
    if (item?.[1] !== undefined && currentKey !== null) {
      fields.get(currentKey)?.push(unquote(item[1]));
      continue;
    }
    const keyed = FRONTMATTER_KEY_RE.exec(line);
    if (keyed?.[1] === undefined) {
      currentKey = null;
      continue;
    }
    fields.set(keyed[1], inlineValues(keyed[2] ?? ""));
    currentKey = keyed[1];
  }
  return fields;
}

function inlineValues(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  return [unquote(trimmed)];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const isQuoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return isQuoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The link targets among a frontmatter field's values. `blocks`/`blocked-by`
 * hold wikilinks; a value that is not one names no ticket, so it is not
 * reported as an unresolved link either.
 */
function wikilinkTargets(values: string[]): string[] {
  const targets: string[] = [];
  for (const value of values) {
    const target = extractWikilink(value);
    if (target !== null) targets.push(target);
  }
  return targets;
}
