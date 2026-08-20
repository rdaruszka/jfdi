import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Randomness in a temp-file name — enough to make a collision a non-event. */
const TEMPORARY_SUFFIX_BYTES = 4;
/** Re-read/retry budget when an external writer changes the file mid-update. */
const DEFAULT_RETRIES = 5;
/** Base backoff between retries; the wait grows linearly with the attempt. */
const DEFAULT_RETRY_DELAY_MS = 50;

export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

/**
 * Write a file atomically via temp-file-in-same-dir + rename, following
 * symlinks. The rename targets the link's *real* path — renaming onto the
 * given path would replace a symlink (e.g. a board.md linked into an Obsidian
 * vault) with a private regular file, silently splitting it from the file the
 * human edits. The temp file lives in the target's real directory so the
 * rename stays atomic on one filesystem.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const target = await realWriteTarget(filePath);
  const directory = path.dirname(target);
  await ensureDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(target)}.${randomBytes(TEMPORARY_SUFFIX_BYTES).toString("hex")}.tmp`,
  );
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, target);
}

/**
 * Resolve the real path a write to `filePath` should land on: the fully
 * resolved file if it exists, the link's (eventual) target if it is a
 * dangling symlink — matching plain-writeFile semantics, which would create
 * the target — else the real parent directory plus the new basename.
 */
async function realWriteTarget(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    // ENOENT means missing file or dangling link; cycles (ELOOP) and
    // permission errors propagate to the caller.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let linkTarget: string | null = null;
  try {
    linkTarget = await fs.readlink(filePath);
  } catch {
    // Not a symlink — a genuinely absent file.
  }
  if (linkTarget !== null) {
    // Dangling link: recurse on the target. Terminates because each hop
    // shortens the remaining chain; a cycle would have thrown ELOOP above.
    return realWriteTarget(path.resolve(path.dirname(filePath), linkTarget));
  }
  const parentDirectory = path.dirname(filePath);
  await ensureDirectory(parentDirectory);
  return path.join(await fs.realpath(parentDirectory), path.basename(filePath));
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    // Unreadable is indistinguishable from absent for every caller here.
    return false;
  }
}

export async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class MtimeConflictError extends Error {
  constructor(filePath: string) {
    super(`File changed on disk during read-modify-write: ${filePath}`);
    this.name = "MtimeConflictError";
  }
}

/**
 * In-process writers to the same path are strictly serialized. The path is a
 * lock key, not something this reads: a file for `readModifyWrite`, a
 * repository directory for the writers to its `.git/worktrees/`.
 *
 * Module-level mutable state, deliberately: the guarantee is "one writer per
 * path per process", which cannot be expressed by anything narrower than a
 * process-wide table. It is the only such state in the codebase.
 *
 * Entries are evicted as they settle (see below) so the coordinator, which
 * runs for days and writes a new path per run directory, does not accumulate
 * one map entry per path it has ever touched.
 */
const pathLocks = new Map<string, Promise<unknown>>();

export function withPathLock<T>(lockPath: string, job: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(lockPath) ?? Promise.resolve();
  const run = previous.then(job, job);
  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  pathLocks.set(lockPath, settled);
  void settled.then(() => {
    // Drop the entry only if nobody chained onto it meanwhile — otherwise the
    // later writer would lose its predecessor and the two could interleave.
    if (pathLocks.get(lockPath) === settled) pathLocks.delete(lockPath);
  });
  return run;
}

/**
 * Atomic read-modify-write with conflict detection and retry. In-process
 * writers are serialized by a per-path lock; external writers (Obsidian edits
 * the board too) are detected by re-reading the content just before the
 * rename and retrying on any change. `modify` returns the new content, or
 * null to skip writing.
 */
export function readModifyWrite(
  filePath: string,
  modify: (content: string) => string | null,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  return withPathLock(filePath, async () => {
    // Termination measure: `attempt` only grows and the loop is bounded by
    // `retries`; the last attempt either writes or throws.
    for (let attempt = 0; attempt <= retries; attempt++) {
      const content = await fs.readFile(filePath, "utf8");
      const next = modify(content);
      if (next === null) return false;
      const reread = await fs.readFile(filePath, "utf8");
      if (reread !== content) {
        if (attempt >= retries) throw new MtimeConflictError(filePath);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        continue;
      }
      await atomicWrite(filePath, next);
      return true;
    }
    // Unreachable: the final iteration always returns or throws above.
    throw new MtimeConflictError(filePath);
  });
}
