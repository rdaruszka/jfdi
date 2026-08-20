import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";
import { defaultConfig, parseConfig } from "../config.js";
import { git } from "../git.js";
import { updateConfigCommand } from "./update-config.js";

describe("updateConfigCommand", () => {
  let project: string;
  let configPath: string;

  beforeEach(async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-update-config-"));
    project = await fs.realpath(created);
    await git(project, "init");
    configPath = path.join(project, ".jfdi", "config.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(project, { recursive: true, force: true });
  });

  it("migrates every legacy spelling without dropping unknown keys or changing config meaning", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const legacyConfig = {
      customTopLevel: { owner: "example" },
      ticketsDir: ".workflow/tickets",
      gate: [{ name: "test", cmd: "pnpm test", customGateField: true }],
      pipeline: { max_rounds: 5, customPipelineField: "kept" },
      integration: {
        target_branch: "develop",
        mode: "auto",
        remote: { fetch_before: true, push_after: true, customRemoteField: 17 },
      },
      max_concurrent: 4,
      stages: defaultConfig().stages,
    };
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
    const configBefore = parseConfig(legacyConfig);

    expect(await updateConfigCommand(project)).toBe(0);

    const migrated = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(parseConfig(migrated)).toEqual(configBefore);
    expect(migrated).toMatchObject({
      customTopLevel: { owner: "example" },
      ticketsDirectory: ".workflow/tickets",
      gate: [{ name: "test", command: "pnpm test", customGateField: true }],
      pipeline: { maxRounds: 5, customPipelineField: "kept" },
      integration: {
        targetBranch: "develop",
        mode: "auto",
        remote: { fetchBefore: true, pushAfter: true, customRemoteField: 17 },
      },
      maxConcurrent: 4,
    });
    const serialized = JSON.stringify(migrated);
    for (const legacyKey of [
      "ticketsDir",
      "cmd",
      "max_rounds",
      "target_branch",
      "fetch_before",
      "push_after",
      "max_concurrent",
    ]) {
      expect(serialized).not.toContain(`"${legacyKey}"`);
    }
    const reportedRenames = output.mock.calls.map(([line]) => String(line)).join("\n");
    for (const rename of [
      "ticketsDir → ticketsDirectory",
      "gate[0].cmd → gate[0].command",
      "pipeline.max_rounds → pipeline.maxRounds",
      "integration.target_branch → integration.targetBranch",
      "integration.remote.fetch_before → integration.remote.fetchBefore",
      "integration.remote.push_after → integration.remote.pushAfter",
      "max_concurrent → maxConcurrent",
    ]) {
      expect(reportedRenames).toContain(rename);
    }
  });

  it("is idempotent and reports a canonical config as unchanged", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          ticketsDirectory: ".workflow/tickets",
          ticketsDir: ".workflow/tickets",
          stages: defaultConfig().stages,
        },
        null,
        2,
      )}\n`,
    );
    expect(await updateConfigCommand(project)).toBe(0);
    const afterFirstRun = await fs.readFile(configPath, "utf8");
    output.mockClear();

    expect(await updateConfigCommand(project)).toBe(0);

    expect(await fs.readFile(configPath, "utf8")).toBe(afterFirstRun);
    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("nothing to update"));
  });

  it("treats an absent config as a clean no-op", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await updateConfigCommand(project)).toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });

  it("exits non-zero naming invalid JSON and leaves the file unmodified", async () => {
    const invalidJson = "{ nope";
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, invalidJson);
    const previousCwd = process.cwd();

    try {
      process.chdir(project);
      expect(await main(["update-config"])).toBe(1);
    } finally {
      process.chdir(previousCwd);
    }

    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining(`invalid JSON in ${configPath}`),
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(invalidJson);
  });

  it("rejects conflicting spellings without partially rewriting the file", async () => {
    const conflicting = `${JSON.stringify({
      ticketsDirectory: ".canonical",
      ticketsDir: ".legacy",
      gate: [{ name: "test", cmd: "pnpm test" }],
      stages: defaultConfig().stages,
    })}\n`;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, conflicting);

    await expect(updateConfigCommand(project)).rejects.toThrow(
      /conflicting.*ticketsDirectory.*ticketsDir/,
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(conflicting);
  });
});
