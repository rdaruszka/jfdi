import * as os from "node:os";
import * as path from "node:path";

/**
 * The user-global JFDI directory (`~/.jfdi`). `JFDI_HOME` overrides it so tests
 * and sandboxed runs never touch the real one; everything project-specific
 * lives under `projects/` within it, leaving the rest reserved.
 */
export function jfdiHome(): string {
  const override = process.env.JFDI_HOME;
  return override ? override : path.join(os.homedir(), ".jfdi");
}

/**
 * The project root's absolute path, dash-flattened the way Claude Code keys
 * `~/.claude/projects/`: every path separator becomes `-`, so
 * `/Users/alice/dev/app` → `-Users-alice-dev-app`. A `-` inside a folder name
 * is then indistinguishable from a separator; that ambiguity is accepted,
 * exactly as Claude Code accepts it.
 */
export function projectKey(projectRoot: string): string {
  return path.resolve(projectRoot).split(path.sep).join("-");
}

/**
 * Where a project's run state lives: `runs/`, `events.jsonl`, `state.json`.
 * Derived from the project root (the directory holding `.jfdi/`) once per
 * process — state written on behalf of a worktree still keys off the project,
 * never the worktree's own path. Worktrees themselves stay in `.jfdi/`.
 */
export function projectStateDirectory(projectRoot: string): string {
  return path.join(jfdiHome(), "projects", projectKey(projectRoot));
}
