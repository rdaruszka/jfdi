import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite, fileExists, readIfExists } from "./util/fsx.js";
import { extractWikilink, ticketIdFromCard } from "./util/ids.js";

export interface Ticket {
  id: string;
  /** The card line text (checkbox marker stripped). */
  cardText: string;
  /** The task spec handed to the Implementation agent. */
  spec: string;
  /** Path to the ticket note; exists only if the card wikilinked one (or one was created). */
  notePath: string | null;
  /** Per-ticket escalation override from note frontmatter (`mode: ask`). */
  mode: "default" | "ask";
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatterMode(content: string): "default" | "ask" {
  const m = FRONTMATTER_RE.exec(content);
  if (!m?.[1]) return "default";
  const modeLine = m[1].split("\n").find((l) => /^mode\s*:/.test(l.trim()));
  if (!modeLine) return "default";
  const value = modeLine.split(":", 2)[1]?.trim();
  return value === "ask" ? "ask" : "default";
}

function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_RE, "");
}

/**
 * Resolve a card into a Ticket. Wikilinks resolve ONLY against ticketsDir —
 * the tool never searches beyond that folder. When a note exists its body is
 * the spec; otherwise the card line itself is the entire spec.
 */
export async function resolveTicket(cardText: string, ticketsDir: string): Promise<Ticket> {
  const id = ticketIdFromCard(cardText);
  const link = extractWikilink(cardText);
  if (link) {
    const notePath = path.join(ticketsDir, `${link}.md`);
    const content = await readIfExists(notePath);
    if (content !== null) {
      return {
        id,
        cardText,
        spec: stripFrontmatter(content).trim(),
        notePath,
        mode: parseFrontmatterMode(content),
      };
    }
    // Linked note missing: treat the card line as spec but keep the note path
    // so run records land where the link points.
    return { id, cardText, spec: cardText, notePath, mode: "default" };
  }
  return { id, cardText, spec: cardText, notePath: null, mode: "default" };
}

/** The note path a ticket's run records should be written to, creating the note if needed. */
export async function ensureTicketNote(ticket: Ticket, ticketsDir: string): Promise<string> {
  const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
  if (!(await fileExists(notePath))) {
    await atomicWrite(notePath, `# ${ticket.cardText}\n\n${ticket.spec}\n`);
  }
  return notePath;
}

/**
 * Append content under a `## Heading` section of a note, creating the section
 * at the end of the file if absent.
 */
export async function appendToSection(
  notePath: string,
  heading: string,
  content: string,
): Promise<void> {
  const existing = (await readIfExists(notePath)) ?? "";
  const lines = existing.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === `## ${heading}`);
  const block = content.trimEnd();
  let next: string;
  if (headingIdx === -1) {
    const base = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
    next = `${base}\n## ${heading}\n\n${block}\n`;
  } else {
    // Insert before the next `## ` heading (or end of file).
    let insertAt = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i] as string)) {
        insertAt = i;
        break;
      }
    }
    // Trim trailing blank lines within the section, then append with spacing.
    while (insertAt > headingIdx + 1 && (lines[insertAt - 1] as string).trim() === "") insertAt--;
    lines.splice(insertAt, 0, "", block);
    next = lines.join("\n");
    if (!next.endsWith("\n")) next += "\n";
  }
  await atomicWrite(notePath, next);
}

/** Read a note's raw content, or null. */
export async function readNote(notePath: string): Promise<string | null> {
  return readIfExists(notePath);
}

export async function ensureTicketsDir(ticketsDir: string): Promise<void> {
  await fs.mkdir(ticketsDir, { recursive: true });
}
