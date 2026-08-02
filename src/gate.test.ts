import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatGateFailure, runGate } from "./gate.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-gate-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("runGate", () => {
  it("runs all commands in order and passes", async () => {
    const seen: string[] = [];
    const result = await runGate(
      [
        { name: "one", cmd: "echo first" },
        { name: "two", cmd: "echo second" },
      ],
      dir,
      (name) => seen.push(name),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["one", "two"]);
    expect(result.results[0]?.output).toContain("first");
  });

  it("stops at the first failure", async () => {
    const result = await runGate(
      [
        { name: "boom", cmd: "echo oops >&2; exit 3" },
        { name: "never", cmd: "echo unreachable" },
      ],
      dir,
    );
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.code).toBe(3);
    expect(result.results[0]?.output).toContain("oops");
  });

  it("runs in the given cwd", async () => {
    await fs.writeFile(path.join(dir, "marker.txt"), "here");
    const result = await runGate([{ name: "ls", cmd: "cat marker.txt" }], dir);
    expect(result.ok).toBe(true);
    expect(result.results[0]?.output).toContain("here");
  });

  it("an empty gate passes", async () => {
    expect((await runGate([], dir)).ok).toBe(true);
  });
});

describe("formatGateFailure", () => {
  it("names the failing step and includes output", async () => {
    const result = await runGate([{ name: "lint", cmd: "echo bad style; exit 1" }], dir);
    const message = formatGateFailure(result);
    expect(message).toContain('failed at step "lint"');
    expect(message).toContain("bad style");
  });
});
