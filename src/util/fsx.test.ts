import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, fileExists, readIfExists, readModifyWrite } from "./fsx.js";

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
  it("skips writing when modify returns null", async () => {
    const file = path.join(dir, "c.txt");
    await fs.writeFile(file, "keep");
    const wrote = await readModifyWrite(file, () => null);
    expect(wrote).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });
});
