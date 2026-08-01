import * as path from "node:path";
import { createBoardIfMissing } from "./board.js";
import { defaultConfig, type JfdiConfig } from "./config.js";
import { ensurePrompts } from "./prompts.js";
import { atomicWrite, ensureDir, fileExists } from "./util/fsx.js";

/**
 * Runtime state under .jfdi/ must never be committed — worktrees would even be
 * picked up as embedded repos by a stray `git add -A`. JFDI owns a .gitignore
 * inside .jfdi/ so this holds regardless of the repo's root .gitignore.
 * (board.md, tickets/, config.json, sandbox.md, prompts/ remain versioned.)
 */
const JFDI_GITIGNORE = `# JFDI runtime state — never committed
worktrees/
runs/
events.jsonl
state.json
`;

export async function ensureJfdiStateScaffold(jfdiDir: string): Promise<void> {
  await ensureDir(jfdiDir);
  const ignorePath = path.join(jfdiDir, ".gitignore");
  if (!(await fileExists(ignorePath))) await atomicWrite(ignorePath, JFDI_GITIGNORE);
}

const SANDBOX_TEMPLATE = `# QA Sandbox Contract

How the QA agent builds, launches, drives, and tears down this product.
(\`jfdi init\` seeded this file; refine it with \`jfdi convo\`.)

## Build

<!-- Commands that produce the runnable artifact, e.g.: pnpm build -->

## Launch & drive

<!-- How to invoke the product and what to expect. For a CLI: commands, flags,
     expected stdout/exit codes. For a daemon: start command, port, health check. -->

## Scratch space

All QA scratch work (fixture repos, temp files) goes under the OS temp directory,
NEVER inside this repository or its parent directories. If the product under test
itself creates git repos or spawns agent sessions, isolate each test in its own
scratch directory outside any parent git repo, and guard against runaway nested
session spawning.

## Teardown

<!-- How to stop/clean up whatever was launched. -->
`;

/**
 * Full .jfdi/ scaffold for \`jfdi init\`: config, board, tickets dir, prompts,
 * sandbox contract. Idempotent — existing files are never overwritten.
 */
export async function scaffoldJfdi(
  repoRoot: string,
  jfdiDir: string,
  config: JfdiConfig = defaultConfig(),
): Promise<void> {
  await ensureJfdiStateScaffold(jfdiDir);
  const configPath = path.join(jfdiDir, "config.json");
  if (!(await fileExists(configPath))) {
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  await ensureDir(path.join(repoRoot, config.ticketsDir));
  const cols = config.board.columns;
  await createBoardIfMissing(path.join(repoRoot, config.board.path), [
    cols.begin,
    cols.inProgress,
    cols.done,
    cols.blocked,
    cols.readyToMerge,
  ]);
  await ensurePrompts(jfdiDir);
  const sandboxPath = path.join(jfdiDir, "sandbox.md");
  if (!(await fileExists(sandboxPath))) await atomicWrite(sandboxPath, SANDBOX_TEMPLATE);
}
