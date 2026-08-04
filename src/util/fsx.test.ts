import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
  fileExists,
  MtimeConflictError,
  readIfExists,
  readModifyWrite,
  withPathLock,
} from "./fsx.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-fsx-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("writes content and leaves no temp files", async () => {
    const file = path.join(dir, "a.txt");
    await atomicWrite(file, "hello");
    expect(await fs.readFile(file, "utf8")).toBe("hello");
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["a.txt"]);
  });
  it("creates parent directories", async () => {
    const file = path.join(dir, "x/y/z.txt");
    await atomicWrite(file, "deep");
    expect(await fs.readFile(file, "utf8")).toBe("deep");
  });
});

describe("atomicWrite through symlinks", () => {
  it("writes through a file symlink and preserves the link", async () => {
    const vault = path.join(dir, "vault");
    await fs.mkdir(vault);
    const target = path.join(vault, "board.md");
    await fs.writeFile(target, "original");
    const link = path.join(dir, "board.md");
    await fs.symlink(target, link);

    await atomicWrite(link, "updated");

    expect(await fs.readFile(target, "utf8")).toBe("updated");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(vault)).toEqual(["board.md"]);
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(["board.md", "vault"]));
  });

  it("follows a dangling symlink and creates its target", async () => {
    const vault = path.join(dir, "vault");
    await fs.mkdir(vault);
    const target = path.join(vault, "new-note.md");
    const link = path.join(dir, "note.md");
    await fs.symlink(target, link);

    await atomicWrite(link, "born");

    expect(await fs.readFile(target, "utf8")).toBe("born");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("creates new files through a symlinked directory", async () => {
    const vault = path.join(dir, "vault");
    await fs.mkdir(vault);
    const linkedDir = path.join(dir, "tickets");
    await fs.symlink(vault, linkedDir);

    await atomicWrite(path.join(linkedDir, "ticket.md"), "note");

    expect(await fs.readFile(path.join(vault, "ticket.md"), "utf8")).toBe("note");
    expect((await fs.lstat(linkedDir)).isSymbolicLink()).toBe(true);
  });
});

describe("readIfExists / fileExists", () => {
  it("returns null / false for missing files", async () => {
    expect(await readIfExists(path.join(dir, "nope"))).toBeNull();
    expect(await fileExists(path.join(dir, "nope"))).toBe(false);
  });
});

describe("readModifyWrite", () => {
  it("applies the modification", async () => {
    const file = path.join(dir, "b.txt");
    await fs.writeFile(file, "one");
    const wrote = await readModifyWrite(file, (c) => c.replace("one", "two"));
    expect(wrote).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("two");
  });
  it("re-reads and retries when the file changed under it", async () => {
    const file = path.join(dir, "raced.txt");
    await fs.writeFile(file, "original\n");
    let attempts = 0;
    // Writing from inside `modify` lands exactly where a human's Obsidian save
    // would: after the read this attempt worked from, before the re-read.
    const wrote = await readModifyWrite(file, (content) => {
      attempts++;
      if (attempts === 1) fsSync.writeFileSync(file, "edited elsewhere\n");
      return `${content}appended\n`;
    });
    expect(wrote).toBe(true);
    expect(attempts).toBe(2);
    expect(await fs.readFile(file, "utf8")).toBe("edited elsewhere\nappended\n");
  });

  it("gives up with a conflict error when the file never settles", async () => {
    const file = path.join(dir, "hot.txt");
    await fs.writeFile(file, "one\n");
    let writes = 0;
    await expect(
      readModifyWrite(
        file,
        (content) => {
          writes++;
          fsSync.writeFileSync(file, `churn ${writes}\n`);
          return content;
        },
        { retries: 2, retryDelayMs: 1 },
      ),
    ).rejects.toThrow(MtimeConflictError);
    expect(writes).toBe(3);
  });

  it("skips writing when modify returns null", async () => {
    const file = path.join(dir, "c.txt");
    await fs.writeFile(file, "keep");
    const wrote = await readModifyWrite(file, () => null);
    expect(wrote).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });
});

describe("withPathLock", () => {
  /** Records entry and exit, so an overlap is visible as an interleaving. */
  function tracedJob(trace: string[], name: string, holdMs: number) {
    return async () => {
      trace.push(`${name}:enter`);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      trace.push(`${name}:exit`);
    };
  }

  it("never lets two jobs on one key overlap", async () => {
    const trace: string[] = [];
    // The second job holds for longer, so an unserialized pair would finish
    // out of order — the assertion is the whole point of the lock.
    await Promise.all([
      withPathLock("/same", tracedJob(trace, "first", 20)),
      withPathLock("/same", tracedJob(trace, "second", 5)),
    ]);
    expect(trace).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);
  });

  it("holds the key for the next job even when the previous one throws", async () => {
    const trace: string[] = [];
    const failing = withPathLock("/same", async () => {
      trace.push("failing:enter");
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("boom");
    });
    const following = withPathLock("/same", tracedJob(trace, "following", 0));
    await expect(failing).rejects.toThrow("boom");
    await following;
    expect(trace).toEqual(["failing:enter", "following:enter", "following:exit"]);
  });

  it("does not serialize different keys against each other", async () => {
    const trace: string[] = [];
    let releaseOne: () => void = () => undefined;
    const isOneReleased = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });
    const one = withPathLock("/one", async () => {
      trace.push("one:enter");
      await isOneReleased;
      trace.push("one:exit");
    });
    // Awaited while /one is still held: a lock that keyed on nothing would
    // never let this run, so the test would hang rather than mis-assert.
    await withPathLock("/two", tracedJob(trace, "two", 0));
    releaseOne();
    await one;
    expect(trace).toEqual(["one:enter", "two:enter", "two:exit", "one:exit"]);
  });
});
