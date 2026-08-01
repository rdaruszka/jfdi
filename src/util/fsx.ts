import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Write a file atomically via temp-file-in-same-dir + rename. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export class MtimeConflictError extends Error {
  constructor(filePath: string) {
    super(`File changed on disk during read-modify-write: ${filePath}`);
    this.name = "MtimeConflictError";
  }
}

/** In-process writers to the same file are strictly serialized. */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, job: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  const run = prev.then(job, job);
  fileLocks.set(
    filePath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Atomic read-modify-write with conflict detection and retry. In-process
 * writers are serialized by a per-path lock; external writers (Obsidian edits
 * the board too) are detected by re-reading the content just before the
 * rename and retrying on any change. `modify` returns the new content, or
 * null to skip writing.
 */
export async function readModifyWrite(
  filePath: string,
  modify: (content: string) => string | null,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const retries = opts.retries ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  return withFileLock(filePath, async () => {
    for (let attempt = 0; ; attempt++) {
      const content = await fs.readFile(filePath, "utf8");
      const next = modify(content);
      if (next === null) return false;
      const reread = await fs.readFile(filePath, "utf8");
      if (reread !== content) {
        if (attempt >= retries) throw new MtimeConflictError(filePath);
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }
      await atomicWrite(filePath, next);
      return true;
    }
  });
}
