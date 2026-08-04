import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseTicketNote, ticketSpec } from "./ticket-note.js";
import { atomicWrite, fileExists, readIfExists } from "./util/fsx.js";
import { extractWikilink, ticketIdFromCard } from "./util/ids.js";

/** One `blocks`/`blocked-by` frontmatter link, resolved against ticketsDir. */
export interface TicketLink {
  kind: "blocks" | "blocked-by";
  /** The wikilink target, e.g. `fix-thing`. */
  target: string;
  /** The note it resolves to, or null when no such note exists in ticketsDir. */
  notePath: string | null;
}

export interface Ticket {
  id: string;
  /** The card line text (checkbox marker stripped). */
  cardText: string;
  /** The task spec handed to the Implementation agent. */
  spec: string;
  /** Path to the ticket note; exists only if the card wikilinked one (or one was created). */
  notePath: string | null;
  /** Frontmatter links to other tickets; empty for a card with no note. */
  links: TicketLink[];
  /** Per-ticket escalation override from note frontmatter (`mode: ask`). */
  mode: "default" | "ask";
}

/**
 * Resolve a card into a Ticket. Wikilinks resolve ONLY against ticketsDir —
 * the tool never searches beyond that folder. When a note exists, its defined
 * slice (title, description, open questions, logged decisions) is the spec;
 * otherwise the card line itself is the entire spec.
 */
export async function resolveTicket(cardText: string, ticketsDir: string): Promise<Ticket> {
  const id = ticketIdFromCard(cardText);
  const link = extractWikilink(cardText);
  if (link) {
    const notePath = path.join(ticketsDir, `${link}.md`);
    const content = await readIfExists(notePath);
    if (content !== null) {
      const note = parseTicketNote(content);
      return {
        id,
        cardText,
        spec: ticketSpec(note),
        notePath,
        links: await resolveLinks(note.blocks, note.blockedBy, ticketsDir),
        mode: note.mode,
      };
    }
    // Linked note missing: treat the card line as spec but keep the note path
    // so run records land where the link points.
    return { id, cardText, spec: cardText, notePath, links: [], mode: "default" };
  }
  return { id, cardText, spec: cardText, notePath: null, links: [], mode: "default" };
}

async function resolveLinks(
  blocks: string[],
  blockedBy: string[],
  ticketsDir: string,
): Promise<TicketLink[]> {
  const links: TicketLink[] = [];
  const groups: Array<[TicketLink["kind"], string[]]> = [
    ["blocks", blocks],
    ["blocked-by", blockedBy],
  ];
  for (const [kind, targets] of groups) {
    for (const target of targets) {
      links.push({ kind, target, notePath: await linkedNotePath(target, ticketsDir) });
    }
  }
  return links;
}

/**
 * Where a `blocks`/`blocked-by` target resolves, or null when nothing answers
 * to it. A target that would step out of ticketsDir (`../elsewhere`) resolves
 * to nothing at all: the wikilink scope is the folder, so a link outside it
 * names no ticket — and is reported unresolved rather than followed.
 */
async function linkedNotePath(target: string, ticketsDir: string): Promise<string | null> {
  const notePath = path.join(ticketsDir, `${target}.md`);
  if (path.dirname(path.resolve(notePath)) !== path.resolve(ticketsDir)) return null;
  return (await fileExists(notePath)) ? notePath : null;
}

/** The note path a ticket's run records should be written to, creating the note if needed. */
export async function ensureTicketNote(ticket: Ticket, ticketsDir: string): Promise<string> {
  const notePath = ticket.notePath ?? path.join(ticketsDir, `${ticket.id}.md`);
  if (!(await fileExists(notePath))) {
    await atomicWrite(notePath, `# ${ticket.cardText}\n\n${ticket.spec}\n`);
  }
  return notePath;
}

export async function ensureTicketsDir(ticketsDir: string): Promise<void> {
  await fs.mkdir(ticketsDir, { recursive: true });
}
