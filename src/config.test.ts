import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig, parseConfig } from "./config.js";

/** The scaffolded mix, so a case can vary one entry without restating four. */
const STAGES = defaultConfig().stages;

describe("parseConfig", () => {
  it("fills all defaults around a stages section", () => {
    expect(parseConfig({ stages: STAGES })).toEqual(defaultConfig());
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
      permissions: { mode: "bypass" },
      max_concurrent: 4,
      stages: STAGES,
    });
    expect(config.integration).toEqual({ target_branch: "develop", mode: "auto" });
    expect(config.permissions).toEqual({ mode: "bypass" });
    expect(config.gate).toHaveLength(2);
    expect(config.max_concurrent).toBe(4);
    expect(config.board.columns.blocked).toBe("Blocked");
  });

  it("rejects a bad integration mode", () => {
    expect(() => parseConfig({ integration: { mode: "yolo" }, stages: STAGES })).toThrow(
      ConfigError,
    );
  });

  it("defaults, accepts, and validates the global permission mode", () => {
    expect(parseConfig({ stages: STAGES }).permissions).toEqual({ mode: "auto" });
    expect(parseConfig({ permissions: { mode: "auto" }, stages: STAGES }).permissions).toEqual({
      mode: "auto",
    });
    expect(parseConfig({ permissions: { mode: "bypass" }, stages: STAGES }).permissions).toEqual({
      mode: "bypass",
    });
    expect(() => parseConfig({ permissions: { mode: "manual" }, stages: STAGES })).toThrowError(
      new ConfigError('permissions.mode must be "auto" or "bypass", got "manual"'),
    );
  });

  it("rejects malformed gate entries", () => {
    expect(() => parseConfig({ gate: [{ name: "x" }], stages: STAGES })).toThrow(ConfigError);
  });

  it("rejects non-integer max_concurrent", () => {
    expect(() => parseConfig({ max_concurrent: 0, stages: STAGES })).toThrow(ConfigError);
  });

  it("rejects the removed harnessArgs setting", () => {
    expect(() => parseConfig({ harnessArgs: [], stages: STAGES })).toThrow(
      "harnessArgs is no longer supported",
    );
  });
});

describe("parseConfig stages", () => {
  it("rejects a config with no stages section, showing the block to add", () => {
    expect(() => parseConfig({})).toThrow(/missing the required "stages" section/);
    expect(() => parseConfig({})).toThrow(/"implementation": \{ "harness": "claude"/);
  });

  it("rejects the retired top-level harness key", () => {
    expect(() => parseConfig({ harness: "claude", stages: STAGES })).toThrow(
      /"harness" key is no longer supported/,
    );
    expect(() => parseConfig({ harness: "claude", stages: STAGES })).toThrow(/"stages": \{/);
  });

  it("names the stage entries a partial stages section is missing", () => {
    expect(() => parseConfig({ stages: { implementation: { harness: "claude" } } })).toThrow(
      /missing an entry for code-review, qa, integration, commit-message/,
    );
  });

  it("rejects a config that predates the scribe, naming the entry and the block to add", () => {
    const { "commit-message": _scribe, ...withoutScribe } = STAGES;
    expect(() => parseConfig({ stages: withoutScribe })).toThrow(ConfigError);
    expect(() => parseConfig({ stages: withoutScribe })).toThrow(
      /missing an entry for commit-message/,
    );
    // Actionable: the message says what the entry is for and shows the fix.
    expect(() => parseConfig({ stages: withoutScribe })).toThrow(
      /"commit-message" selects the scribe that writes commit messages/,
    );
    expect(() => parseConfig({ stages: withoutScribe })).toThrow(
      /"commit-message": \{ "harness": "claude", "model": "claude-sonnet-5" \}/,
    );
  });

  it("selects the scribe like any other entry, effort included", () => {
    const config = parseConfig({
      stages: { ...STAGES, "commit-message": { harness: "codex", effort: "minimal" } },
    });
    expect(config.stages["commit-message"]).toEqual({ harness: "codex", effort: "minimal" });
    expect(() =>
      parseConfig({
        stages: { ...STAGES, "commit-message": { harness: "claude", effort: "none" } },
      }),
    ).toThrow(/stages.commit-message.effort is "none"/);
  });

  it("rejects an unknown stage key", () => {
    expect(() =>
      parseConfig({ stages: { ...STAGES, "code-reveiw": { harness: "claude" } } }),
    ).toThrow(/unknown entry "code-reveiw"/);
  });

  it("rejects a stage entry without a harness", () => {
    expect(() => parseConfig({ stages: { ...STAGES, qa: { model: "opus" } } })).toThrow(
      "stages.qa.harness must be a non-empty string",
    );
    expect(() => parseConfig({ stages: { ...STAGES, qa: { harness: "gemini" } } })).toThrow(
      'stages.qa.harness must be "claude" or "codex", got "gemini"',
    );
  });

  it("rejects an effort the selected harness does not accept, naming the accepted list", () => {
    // "minimal" is a Codex level; Claude Code has no such effort.
    expect(() =>
      parseConfig({ stages: { ...STAGES, qa: { harness: "claude", effort: "minimal" } } }),
    ).toThrow(/stages\.qa\.effort is "minimal".*claude.*low, medium, high, xhigh, max/s);
    // The same value under the harness that does accept it.
    expect(
      parseConfig({ stages: { ...STAGES, qa: { harness: "codex", effort: "minimal" } } }).stages.qa,
    ).toEqual({ harness: "codex", effort: "minimal" });
    expect(() =>
      parseConfig({ stages: { ...STAGES, "code-review": { harness: "codex", effort: "hgih" } } }),
    ).toThrow(/stages\.code-review\.effort is "hgih"/);
  });

  it("leaves a harness-only entry with no model or effort — it inherits nobody's", () => {
    const stages = parseConfig({ stages: { ...STAGES, qa: { harness: "codex" } } }).stages;
    expect(stages.qa).toEqual({ harness: "codex" });
    expect(Object.hasOwn(stages.qa, "model")).toBe(false);
    expect(Object.hasOwn(stages.qa, "effort")).toBe(false);
    // The neighbours keep theirs; nothing leaked either way.
    expect(stages.implementation.model).toBe("claude-opus-4-8");
  });

  it("passes model strings through verbatim, alias or full id", () => {
    const stages = parseConfig({
      stages: { ...STAGES, qa: { harness: "claude", model: "opus" } },
    }).stages;
    expect(stages.qa.model).toBe("opus");
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
    await fs.writeFile(
      path.join(dir, ".jfdi/config.json"),
      JSON.stringify({ max_concurrent: 7, stages: STAGES }),
    );
    expect((await loadConfig(dir)).max_concurrent).toBe(7);
  });

  it("rejects a config.json that predates per-stage selection", async () => {
    await fs.mkdir(path.join(dir, ".jfdi"), { recursive: true });
    await fs.writeFile(path.join(dir, ".jfdi/config.json"), JSON.stringify({ harness: "claude" }));
    await expect(loadConfig(dir)).rejects.toThrow(/"harness" key is no longer supported/);
  });

  it("throws ConfigError on invalid JSON", async () => {
    await fs.mkdir(path.join(dir, ".jfdi"), { recursive: true });
    await fs.writeFile(path.join(dir, ".jfdi/config.json"), "{nope");
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });
});
