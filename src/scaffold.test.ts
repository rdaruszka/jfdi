import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBoard } from "./board.js";
import { defaultConfig } from "./config.js";
import { scaffoldJfdi } from "./scaffold.js";

let root: string;
let jfdiDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-scaffold-"));
  jfdiDir = path.join(root, ".jfdi");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scaffoldJfdi", () => {
  it("creates config, board, tickets dir, prompts, sandbox, and state gitignore", async () => {
    await scaffoldJfdi(root, jfdiDir);
    const scaffoldedConfig = JSON.parse(
      await fs.readFile(path.join(jfdiDir, "config.json"), "utf8"),
    );
    expect(scaffoldedConfig).toEqual(defaultConfig());
    expect(scaffoldedConfig.permissions).toEqual({ mode: "auto" });
    const board = parseBoard(await fs.readFile(path.join(jfdiDir, "board.md"), "utf8"));
    expect(board.columns.map((c) => c.name)).toEqual([
      "Ready",
      "In Progress",
      "Done",
      "Blocked",
      "Ready to Merge",
      "Inbox",
    ]);
    const stats = await fs.stat(path.join(jfdiDir, "tickets"));
    expect(stats.isDirectory()).toBe(true);
    expect(await fs.readdir(path.join(jfdiDir, "prompts"))).toHaveLength(9);
    expect(await fs.readFile(path.join(jfdiDir, "sandbox.md"), "utf8")).toContain(
      "Sandbox Contract",
    );
    // Hook config for JFDI-spawned Claude sessions: format-on-edit.
    const settings = await fs.readFile(path.join(jfdiDir, "claude-settings.json"), "utf8");
    expect(JSON.parse(settings).hooks.PostToolUse[0].matcher).toBe("Edit|Write");
    const hookStats = await fs.stat(path.join(jfdiDir, "hooks", "format.sh"));
    expect(hookStats.mode & 0o100).toBeTruthy();
    const ignore = await fs.readFile(path.join(jfdiDir, ".gitignore"), "utf8");
    // Worktrees plus the board and tickets — work tracking stays out of
    // product history (work tracking is external to the product). "tickets" has no trailing slash so the
    // pattern also matches a symlink into a vault.
    for (const entry of ["worktrees/", "board.md", "tickets"]) expect(ignore).toContain(entry);
    // Run state lives under ~/.jfdi/projects/<key>/, so it needs no entry here.
    for (const gone of ["runs/", "events.jsonl", "state.json"]) expect(ignore).not.toContain(gone);
  });

  it("is idempotent and never overwrites user files", async () => {
    await scaffoldJfdi(root, jfdiDir);
    await fs.writeFile(path.join(jfdiDir, "sandbox.md"), "my custom contract");
    await fs.writeFile(path.join(jfdiDir, "config.json"), '{"max_concurrent": 9}');
    await scaffoldJfdi(root, jfdiDir);
    expect(await fs.readFile(path.join(jfdiDir, "sandbox.md"), "utf8")).toBe("my custom contract");
    expect(await fs.readFile(path.join(jfdiDir, "config.json"), "utf8")).toBe(
      '{"max_concurrent": 9}',
    );
  });

  it("respects configured column names and paths", async () => {
    const config = defaultConfig();
    config.board.columns.begin = "To Do";
    await scaffoldJfdi(root, jfdiDir, config);
    const board = parseBoard(await fs.readFile(path.join(jfdiDir, "board.md"), "utf8"));
    expect(board.columns[0]?.name).toBe("To Do");
  });
});
