import { createHash } from "node:crypto";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\[|\]\]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/;

/** Slug words kept from a bare card's text — enough to stay readable as a directory name. */
const MAX_SLUG_WORDS = 6;
/** Hex characters of the content hash appended to a bare card's slug. */
const SLUG_HASH_CHARS = 6;

/** Extract the first [[wikilink]] target from a card line, or null. */
export function extractWikilink(text: string): string | null {
  const match = WIKILINK_RE.exec(text);
  return match?.[1]?.trim() ?? null;
}

/**
 * Derive a stable ticket id from a card line.
 * Wikilinked cards use the slugified link target; bare cards use a slug of the
 * text plus a short content hash so distinct cards never collide.
 */
export function ticketIdFromCard(cardText: string): string {
  const link = extractWikilink(cardText);
  if (link) return slugify(link);
  const slug = slugify(cardText).split("-").slice(0, MAX_SLUG_WORDS).join("-") || "ticket";
  const hash = createHash("sha256").update(cardText).digest("hex").slice(0, SLUG_HASH_CHARS);
  return `${slug}-${hash}`;
}
