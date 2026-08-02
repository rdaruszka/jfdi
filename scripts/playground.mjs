#!/usr/bin/env node
/**
 * Mint a disposable penny playground from fixtures/half-app and print where it
 * landed. Run via `pnpm playground` (which builds dist/ first).
 *
 *   pnpm playground                        # all 7 tickets promoted to Ready
 *   pnpm playground --tickets 1,7          # by Backlog position
 *   pnpm playground --tickets remove-entry # by wikilink id or text substring
 *   pnpm playground --tickets none         # everything stays in Backlog
 *   pnpm playground --dest ~/scratch/penny --no-install
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const templateDir = path.join(repoRoot, "fixtures", "half-app");

function parseTicketSelector(value) {
  if (!value) fail("--tickets expects a comma-separated list, or 'all'/'none'");
  return value === "all" || value === "none" ? value : value.split(",");
}

function parseArgs(argv) {
  const options = { tickets: "all", destination: null, shouldInstall: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tickets") {
      options.tickets = parseTicketSelector(argv[++i]);
    } else if (arg === "--dest") {
      options.destination = argv[++i] ?? fail("--dest expects a path");
    } else if (arg === "--no-install") {
      options.shouldInstall = false;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));

let destination;
if (options.destination) {
  destination = path.resolve(options.destination);
  const existing = await fs.readdir(destination).catch(() => null);
  if (existing && existing.length > 0) fail(`--dest exists and is not empty: ${destination}`);
} else {
  // Outside any parent git repo — both git and Claude Code walk up the tree.
  destination = await fs.mkdtemp(path.join(os.tmpdir(), "penny-playground-"));
}

const { createProjectFixture } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "fixture-project.js"))
);
const fixture = await createProjectFixture(templateDir, destination, { ready: options.tickets });

if (options.shouldInstall) {
  const install = spawnSync("pnpm", ["install", "--prefer-offline"], {
    cwd: destination,
    stdio: "inherit",
  });
  if (install.status !== 0) fail("pnpm install failed in the playground");
}

const jfdi = path.join(repoRoot, "dist", "index.js");
console.log(`\nPlayground ready: ${destination}\n`);
if (fixture.readyCards.length > 0) {
  console.log("In the Ready column:");
  for (const card of fixture.readyCards) console.log(`  ${card}`);
} else {
  console.log("All cards left in Backlog (promote them in .jfdi/board.md).");
}
console.log(`\nNext:\n  cd ${destination}\n  node ${jfdi} start        # coordinator + TUI`);
console.log(`  node ${jfdi} run "<card text>"   # or a single ticket`);
