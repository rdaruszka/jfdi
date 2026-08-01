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
