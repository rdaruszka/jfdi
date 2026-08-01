import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findColumn, moveCard, parseBoard } from "./board.js";
import { git } from "./git.js";
import { ensurePrompts } from "./prompts.js";
import { ensureJfdiGitignore } from "./scaffold.js";
import { extractWikilink } from "./util/ids.js";

/**
 * Mint a runnable project fixture from a checked-in template (fixtures/*).
 * Templates carry no .git — git can't version a nested repo — so this factory
 * owns repo creation: copy the template, init a repo with a short realistic
 * history, and promote the requested Backlog cards to the Ready column.
 *
 * One factory, three consumers: `pnpm playground` for manual runs, the e2e
 * tests, and the prompt refiner. Copies must land OUTSIDE any parent git repo
 * (OS temp dir) — both git and Claude Code walk up the directory tree.
 */

export interface ProjectFixture {
  repo: string;
  /** Raw card lines promoted into Ready, in board order. */
  readyCards: string[];
}

export interface ProjectFixtureOptions {
  /**
   * Which Backlog cards to promote to Ready: "all" (default), "none", or a
   * list of selectors — a 1-based Backlog position, a [[wikilink]] id, or a
   * case-insensitive substring of the card text.
   */
  ready?: "all" | "none" | string[];
}

const BACKLOG_COLUMN = "Backlog";
const READY_COLUMN = "Ready";

/** Working artifacts that may exist in the template checkout but aren't part of it. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function matchesSelector(selector: string, cardText: string, position: number): boolean {
  if (/^\d+$/.test(selector)) return Number(selector) === position;
  const wanted = selector.toLowerCase();
  const link = extractWikilink(cardText);
  if (link && link.toLowerCase() === wanted) return true;
  return cardText.toLowerCase().includes(wanted);
}

async function commitPaths(repo: string, message: string, paths: string[]): Promise<void> {
  await git(repo, "add", "--", ...paths);
  await git(repo, "commit", "-m", message);
}

async function promoteCards(
  boardPath: string,
  ready: "all" | "none" | string[],
): Promise<string[]> {
  if (ready === "none") return [];
  const board = parseBoard(await fs.readFile(boardPath, "utf8"));
  const backlog = findColumn(board, BACKLOG_COLUMN);
  if (!backlog) throw new Error(`board has no "${BACKLOG_COLUMN}" column: ${boardPath}`);
  const selected = backlog.cards.filter(
    (card, i) => ready === "all" || ready.some((s) => matchesSelector(s, card.text, i + 1)),
  );
  if (ready !== "all" && selected.length === 0)
    throw new Error(`no ${BACKLOG_COLUMN} cards matched: ${ready.join(", ")}`);
  for (const card of selected) {
    await moveCard(boardPath, card.raw, BACKLOG_COLUMN, READY_COLUMN);
  }
  return selected.map((c) => c.raw);
}

export async function createProjectFixture(
  templateDir: string,
  destDir: string,
  opts: ProjectFixtureOptions = {},
): Promise<ProjectFixture> {
  await fs.cp(templateDir, destDir, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)),
  });
  await git(destDir, "init", "-b", "main");
  await git(destDir, "config", "user.email", "fixture@jfdi.local");
  await git(destDir, "config", "user.name", "JFDI Fixture");

  // Seed what the template can't carry: the canonical stage prompts, and the
  // .jfdi/.gitignore (a gitignore inside the template would hide the board and
  // tickets from THIS repo too, so scaffold it at mint time instead).
  const jfdiDir = path.join(destDir, ".jfdi");
  await ensureJfdiGitignore(jfdiDir);
  await ensurePrompts(jfdiDir);

  // A short realistic history, not one blob commit — merges and rebases get a
  // deterministic baseline and `git log` archaeology has something to find.
  await commitPaths(destDir, "chore: project tooling", [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "biome.json",
    ".gitignore",
    "README.md",
  ]);
  await commitPaths(destDir, "feat: add, list, and total commands", ["src"]);

  // Only config, sandbox, and prompts land in the commit — .jfdi/.gitignore
  // keeps the board, tickets, and runtime state out of product history
  // (spec §2: work tracking is external, like JIRA would be).
  await commitPaths(destDir, "chore: adopt jfdi (config, sandbox contract, prompts)", [".jfdi"]);

  const boardPath = path.join(destDir, ".jfdi", "board.md");
  const readyCards = await promoteCards(boardPath, opts.ready ?? "all");

  return { repo: destDir, readyCards };
}
