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

function parseArgs(argv) {
  const opts = { tickets: "all", dest: null, install: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tickets") {
      const value = argv[++i];
      if (!value) fail("--tickets expects a comma-separated list, or 'all'/'none'");
      opts.tickets = value === "all" || value === "none" ? value : value.split(",");
    } else if (arg === "--dest") {
      opts.dest = argv[++i] ?? fail("--dest expects a path");
    } else if (arg === "--no-install") {
      opts.install = false;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));

let dest;
if (opts.dest) {
  dest = path.resolve(opts.dest);
  const existing = await fs.readdir(dest).catch(() => null);
  if (existing && existing.length > 0) fail(`--dest exists and is not empty: ${dest}`);
} else {
  // Outside any parent git repo — both git and Claude Code walk up the tree.
  dest = await fs.mkdtemp(path.join(os.tmpdir(), "penny-playground-"));
}

const { createProjectFixture } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "fixture-project.js"))
);
const fixture = await createProjectFixture(templateDir, dest, { ready: opts.tickets });

if (opts.install) {
  const install = spawnSync("pnpm", ["install", "--prefer-offline"], {
    cwd: dest,
    stdio: "inherit",
  });
  if (install.status !== 0) fail("pnpm install failed in the playground");
}

const jfdi = path.join(repoRoot, "dist", "index.js");
console.log(`\nPlayground ready: ${dest}\n`);
if (fixture.readyCards.length > 0) {
  console.log("In the Ready column:");
  for (const card of fixture.readyCards) console.log(`  ${card}`);
} else {
  console.log("All cards left in Backlog (promote them in .jfdi/board.md).");
}
console.log(`\nNext:\n  cd ${dest}\n  node ${jfdi} start        # coordinator + TUI`);
console.log(`  node ${jfdi} run "<card text>"   # or a single ticket`);
