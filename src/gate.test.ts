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
    const logPath = path.join(dir, "gate.log");
    const result = await runGate(
      [
        { name: "one", command: "echo first" },
        { name: "two", command: "echo second" },
      ],
      dir,
      logPath,
      (name) => seen.push(name),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["one", "two"]);
    expect(result.results[0]?.output).toContain("first");
    expect(await fs.readFile(logPath, "utf8")).toBe("first\nsecond\n");
  });

  it("stops at the first failure", async () => {
    const result = await runGate(
      [
        { name: "boom", command: "echo oops >&2; exit 3" },
        { name: "never", command: "echo unreachable" },
      ],
      dir,
      path.join(dir, "gate.log"),
    );
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.code).toBe(3);
    expect(result.results[0]?.output).toContain("oops");
  });

  it("runs in the given cwd", async () => {
    await fs.writeFile(path.join(dir, "marker.txt"), "here");
    const result = await runGate(
      [{ name: "ls", command: "cat marker.txt" }],
      dir,
      path.join(dir, "gate.log"),
    );
    expect(result.ok).toBe(true);
    expect(result.results[0]?.output).toContain("here");
  });

  it("an empty gate passes", async () => {
    const logPath = path.join(dir, "gate.log");
    expect((await runGate([], dir, logPath)).ok).toBe(true);
    expect(await fs.readFile(logPath, "utf8")).toBe("");
  });

  it("persists full output before creating a head-and-tail prompt excerpt", async () => {
    const logPath = path.join(dir, "gate.log");
    const result = await runGate(
      [
        {
          name: "large",
          command:
            "printf HEAD_CAUSE; head -c 30000 /dev/zero | tr '\\0' x; printf TAIL_DETAIL; exit 1",
        },
      ],
      dir,
      logPath,
    );

    const fullOutput = await fs.readFile(logPath, "utf8");
    expect(fullOutput).toHaveLength(30_021);
    expect(fullOutput).toMatch(/^HEAD_CAUSE/);
    expect(fullOutput).toMatch(/TAIL_DETAIL$/);
    expect(result.results[0]?.output).toHaveLength(20_000);
    expect(result.results[0]?.output).toMatch(/^HEAD_CAUSE/);
    expect(result.results[0]?.output).toMatch(/TAIL_DETAIL$/);
  });
});

describe("formatGateFailure", () => {
  it("names the failing step and includes output", async () => {
    const logPath = path.join(dir, "gate.log");
    const result = await runGate(
      [{ name: "lint", command: "echo bad style; exit 1" }],
      dir,
      logPath,
    );
    const message = formatGateFailure(result);
    expect(message).toContain('failed at step "lint"');
    expect(message).toContain("bad style");
    expect(message).toContain(logPath);
  });
});
