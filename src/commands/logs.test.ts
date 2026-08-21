import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsDirectory } from "../pipeline.js";
import { buildContext } from "./context.js";
import { logsCommand } from "./logs.js";

vi.mock("../pipeline.js", () => ({ runsDirectory: vi.fn() }));
vi.mock("./context.js", () => ({ buildContext: vi.fn() }));

const sandboxRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    sandboxRoots
      .splice(0)
      .map((sandboxRoot) => fs.rm(sandboxRoot, { recursive: true, force: true })),
  );
});

describe("logsCommand", () => {
  it("prints recursively discovered log files in sorted order", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-logs-test-"));
    sandboxRoots.push(sandboxRoot);
    const runBase = path.join(sandboxRoot, "runs", "ticket");
    const round = path.join(runBase, "run-1", "round-1");
    await fs.mkdir(path.join(round, "nested"), { recursive: true });
    await fs.writeFile(path.join(round, "z.log.jsonl"), "z");
    await fs.writeFile(path.join(round, "nested", "a.log.jsonl"), "a");
    await fs.writeFile(path.join(round, "implementation.verdict.json"), "ignored");

    vi.mocked(buildContext).mockResolvedValue({
      stateDirectory: sandboxRoot,
    } as Awaited<ReturnType<typeof buildContext>>);
    vi.mocked(runsDirectory).mockReturnValue(runBase);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(logsCommand("ticket")).resolves.toBe(0);

    const nestedLog = path.join("runs", "ticket", "run-1", "round-1", "nested", "a.log.jsonl");
    const rootLog = path.join("runs", "ticket", "run-1", "round-1", "z.log.jsonl");
    expect(consoleLog.mock.calls.flat()).toEqual([
      `\n===== ${nestedLog} =====`,
      "a",
      `\n===== ${rootLog} =====`,
      "z",
    ]);
  });
});
