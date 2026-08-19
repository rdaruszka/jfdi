import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createBoardIfMissing } from "./board.js";
import { defaultConfig, type JfdiConfig } from "./config.js";
import { ensurePrompts, isPristineDefaultPromptSet } from "./prompts.js";
import { TICKET_FORMAT } from "./ticket-format.js";
import { atomicWrite, ensureDir, fileExists } from "./util/fsx.js";

/**
 * Worktrees under .jfdi/ must never be committed — a stray `git add -A` would
 * pick them up as embedded repos. Neither are the board and tickets: they're
 * work-tracking artifacts external to the product (think JIRA), mutated mid-run
 * by human and coordinator alike (docs/guide/board-and-tickets.md). JFDI owns a .gitignore inside
 * .jfdi/ so this holds regardless of the repo's root .gitignore. (config.json,
 * sandbox.md, ticket-format.md, prompts/ remain versioned; runs/, events.jsonl
 * and state.json live outside the project entirely, under
 * ~/.jfdi/projects/<project-key>/.)
 */
const JFDI_GITIGNORE = `# JFDI worktrees — never committed
worktrees/

# Work tracking lives outside product history (often a symlink into a vault)
board.md
tickets

# Prompt sets retired by a re-init — kept for the human, never loaded
prompts.backup-*/
`;

export async function ensureJfdiGitignore(jfdiDir: string): Promise<void> {
  await ensureDir(jfdiDir);
  const ignorePath = path.join(jfdiDir, ".gitignore");
  if (!(await fileExists(ignorePath))) await atomicWrite(ignorePath, JFDI_GITIGNORE);
}

const SANDBOX_TEMPLATE = `# QA Sandbox Contract

How the QA agent builds, launches, drives, and tears down this product.
(\`jfdi init\` seeded this file; rerun it to refine the setup conversationally.)

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
 * Hook settings for JFDI-spawned Claude Code sessions only (passed via
 * `--settings`, never written into the target project's own .claude/). The
 * PostToolUse hook formats each edited file so agents never burn session turns
 * on lint-fix loops. Codex has no hook system; its sessions simply skip this.
 */
const CLAUDE_SETTINGS = `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "sh \\"$CLAUDE_PROJECT_DIR/.jfdi/hooks/format.sh\\""
          }
        ]
      }
    ]
  }
}
`;

const EXECUTABLE_FILE_MODE = 0o755;

const FORMAT_HOOK_TEMPLATE = `#!/bin/sh
# JFDI PostToolUse hook: format the file the agent just edited.
# Receives the Claude Code hook payload on stdin; the edited file's path is at
# .tool_input.file_path. \`jfdi init\` (or you) should replace the placeholder
# below with this project's real single-file format command. Keep it fast and
# always exit 0 — a formatter problem must never fail the agent's edit.
#
# Example (a Node project using biome):
#   file=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const f=JSON.parse(d).tool_input?.file_path;if(f)console.log(f)}catch{}})')
#   [ -n "$file" ] && cd "$CLAUDE_PROJECT_DIR" && pnpm exec biome check --write "$file" >/dev/null 2>&1
cat > /dev/null
exit 0
`;

/**
 * Full .jfdi/ scaffold for \`jfdi init\`: config, board, tickets dir, ticket
 * format, sandbox contract, and the generic stage prompt defaults. Idempotent
 * — existing files are never overwritten — with one deliberate exception: an
 * existing \`prompts/\` directory is retired wholesale to a timestamped backup
 * the init agent is instructed never to read, and fresh generic defaults are
 * seeded in its place. Instantiating those defaults for the project is the init
 * session's core deliverable, and it must start from clean raw material, never
 * from an earlier adaptation. Returns the backup's path when a retirement
 * happened, so the caller can tell the human.
 */
export async function scaffoldJfdi(
  repoRoot: string,
  jfdiDir: string,
  config: JfdiConfig = defaultConfig(),
): Promise<{ retiredPromptsPath: string | null }> {
  await ensureJfdiGitignore(jfdiDir);
  const promptsPath = path.join(jfdiDir, "prompts");
  let retiredPromptsPath: string | null = null;
  // A pristine default set has nothing worth backing up — retiring it would
  // just stack meaningless backups on every rerun. Anything else (an
  // adaptation, a stale file from an earlier era) is retired wholesale.
  if ((await fileExists(promptsPath)) && !(await isPristineDefaultPromptSet(jfdiDir))) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    retiredPromptsPath = path.join(jfdiDir, `prompts.backup-${timestamp}`);
    await fs.rename(promptsPath, retiredPromptsPath);
  }
  await ensurePrompts(jfdiDir);
  const configPath = path.join(jfdiDir, "config.json");
  if (!(await fileExists(configPath))) {
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  await ensureDir(path.join(repoRoot, config.ticketsDir));
  const columns = config.board.columns;
  await createBoardIfMissing(path.join(repoRoot, config.board.path), [
    columns.begin,
    columns.inProgress,
    columns.done,
    columns.blocked,
    columns.readyToMerge,
    columns.inbox,
  ]);
  const sandboxPath = path.join(jfdiDir, "sandbox.md");
  if (!(await fileExists(sandboxPath))) await atomicWrite(sandboxPath, SANDBOX_TEMPLATE);
  const ticketFormatPath = path.join(jfdiDir, "ticket-format.md");
  if (!(await fileExists(ticketFormatPath))) await atomicWrite(ticketFormatPath, TICKET_FORMAT);
  const settingsPath = path.join(jfdiDir, "claude-settings.json");
  if (!(await fileExists(settingsPath))) await atomicWrite(settingsPath, CLAUDE_SETTINGS);
  const formatHookPath = path.join(jfdiDir, "hooks", "format.sh");
  if (!(await fileExists(formatHookPath))) {
    await atomicWrite(formatHookPath, FORMAT_HOOK_TEMPLATE);
    await fs.chmod(formatHookPath, EXECUTABLE_FILE_MODE);
  }
  return { retiredPromptsPath };
}
