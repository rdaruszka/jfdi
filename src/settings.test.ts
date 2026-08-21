import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { loadSettings, saveSettings, SettingsStaleError } from "./settings.js";

let projectRoot: string;
let configPath: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-settings-"));
  const jfdiDirectory = path.join(projectRoot, ".jfdi");
  await fs.mkdir(jfdiDirectory);
  configPath = path.join(jfdiDirectory, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe("settings file", () => {
  it("loads every effective configuration option with a revision", async () => {
    const loaded = await loadSettings(projectRoot);

    expect(loaded.config).toEqual(defaultConfig());
    expect(loaded.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates the staged config as a whole before writing", async () => {
    const loaded = await loadSettings(projectRoot);
    const original = await fs.readFile(configPath, "utf8");

    await expect(
      saveSettings(projectRoot, { ...loaded.config, maxConcurrent: 0 }, loaded.revision),
    ).rejects.toThrow("maxConcurrent must be a positive integer");
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  it("refuses a stale save without replacing the external edit", async () => {
    const loaded = await loadSettings(projectRoot);
    const external = `${JSON.stringify({ ...loaded.config, maxConcurrent: 5 }, null, 2)}\n`;
    await fs.writeFile(configPath, external);

    await expect(
      saveSettings(projectRoot, { ...loaded.config, maxConcurrent: 3 }, loaded.revision),
    ).rejects.toBeInstanceOf(SettingsStaleError);
    expect(await fs.readFile(configPath, "utf8")).toBe(external);
  });

  it("atomically writes a valid current edit and returns its new revision", async () => {
    const loaded = await loadSettings(projectRoot);
    const saved = await saveSettings(
      projectRoot,
      { ...loaded.config, maxConcurrent: 4, frontEnd: "web" },
      loaded.revision,
    );

    expect(saved.config.maxConcurrent).toBe(4);
    expect(saved.config.frontEnd).toBe("web");
    expect(saved.revision).not.toBe(loaded.revision);
    expect((await loadSettings(projectRoot)).config).toEqual(saved.config);
    expect(
      (await fs.readdir(path.dirname(configPath))).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });
});
