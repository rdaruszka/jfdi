import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("fills all defaults from an empty object", () => {
    expect(parseConfig({})).toEqual(defaultConfig());
  });

  it("accepts the spec example shape", () => {
    const config = parseConfig({
      board: {
        path: ".jfdi/board.md",
        columns: { begin: "Ready", inProgress: "In Progress", done: "Done" },
      },
      ticketsDir: ".jfdi/tickets",
      gate: [
        { name: "build", cmd: "npm run build" },
        { name: "test", cmd: "npm test" },
      ],
      pipeline: { max_rounds: 3 },
      integration: { target_branch: "develop", mode: "auto" },
      max_concurrent: 4,
      harness: "claude",
    });
    expect(config.integration).toEqual({ target_branch: "develop", mode: "auto" });
    expect(config.gate).toHaveLength(2);
    expect(config.max_concurrent).toBe(4);
    expect(config.board.columns.blocked).toBe("Blocked");
  });

  it("rejects a bad integration mode", () => {
    expect(() => parseConfig({ integration: { mode: "yolo" } })).toThrow(ConfigError);
  });

  it("rejects malformed gate entries", () => {
    expect(() => parseConfig({ gate: [{ name: "x" }] })).toThrow(ConfigError);
  });

  it("rejects non-integer max_concurrent", () => {
    expect(() => parseConfig({ max_concurrent: 0 })).toThrow(ConfigError);
  });

  it("accepts Codex and rejects unknown harnesses", () => {
    expect(parseConfig({ harness: "codex" }).harness).toBe("codex");
    expect(() => parseConfig({ harness: "other" })).toThrow('harness must be "claude" or "codex"');
  });

  it("rejects the removed harnessArgs setting", () => {
    expect(() => parseConfig({ harnessArgs: [] })).toThrow("harnessArgs is no longer supported");
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-cfg-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when config.json is absent", async () => {
    expect(await loadConfig(dir)).toEqual(defaultConfig());
  });

  it("loads from .jfdi/config.json", async () => {
    await fs.mkdir(path.join(dir, ".jfdi"), { recursive: true });
    await fs.writeFile(path.join(dir, ".jfdi/config.json"), JSON.stringify({ max_concurrent: 7 }));
    expect((await loadConfig(dir)).max_concurrent).toBe(7);
  });

  it("throws ConfigError on invalid JSON", async () => {
    await fs.mkdir(path.join(dir, ".jfdi"), { recursive: true });
    await fs.writeFile(path.join(dir, ".jfdi/config.json"), "{nope");
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });
});
