import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBoard } from "./board.js";
import { defaultConfig } from "./config.js";
import { scaffoldJfdi } from "./scaffold.js";
import { TICKET_FORMAT } from "./ticket-format.js";

let root: string;
let jfdiDirectory: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-scaffold-"));
  jfdiDirectory = path.join(root, ".jfdi");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scaffoldJfdi", () => {
  it("creates config, board, tickets dir, prompts, ticket format, sandbox, and gitignore", async () => {
    await scaffoldJfdi(root, jfdiDirectory);
    const scaffoldedConfig = JSON.parse(
      await fs.readFile(path.join(jfdiDirectory, "config.json"), "utf8"),
    );
    expect(scaffoldedConfig).toEqual(defaultConfig());
    expect(scaffoldedConfig.permissions).toEqual({ mode: "auto" });
    const board = parseBoard(await fs.readFile(path.join(jfdiDirectory, "board.md"), "utf8"));
    expect(board.columns.map((c) => c.name)).toEqual([
      "Ready",
      "In Progress",
      "Done",
      "Blocked",
      "Ready to Merge",
      "Inbox",
    ]);
    const stats = await fs.stat(path.join(jfdiDirectory, "tickets"));
    expect(stats.isDirectory()).toBe(true);
    // The eight generic stage prompt defaults — the raw material the init
    // session instantiates for the project.
    expect(await fs.readdir(path.join(jfdiDirectory, "prompts"))).toHaveLength(8);
    expect(await fs.readFile(path.join(jfdiDirectory, "sandbox.md"), "utf8")).toContain(
      "Sandbox Contract",
    );
    expect(await fs.readFile(path.join(jfdiDirectory, "ticket-format.md"), "utf8")).toBe(
      TICKET_FORMAT,
    );
    // Hook config for JFDI-spawned Claude sessions: format-on-edit.
    const settings = await fs.readFile(path.join(jfdiDirectory, "claude-settings.json"), "utf8");
    expect(JSON.parse(settings).hooks.PostToolUse[0].matcher).toBe("Edit|Write");
    const hookStats = await fs.stat(path.join(jfdiDirectory, "hooks", "format.sh"));
    expect(hookStats.mode & 0o100).toBeTruthy();
    const ignore = await fs.readFile(path.join(jfdiDirectory, ".gitignore"), "utf8");
    // Worktrees plus the board and tickets — work tracking stays out of
    // product history (work tracking is external to the product). "tickets" has no trailing slash so the
    // pattern also matches a symlink into a vault.
    for (const entry of ["worktrees/", "board.md", "tickets", "prompts.backup-*/"])
      expect(ignore).toContain(entry);
    // Run state lives under ~/.jfdi/projects/<key>/, so it needs no entry here.
    for (const gone of ["runs/", "events.jsonl", "state.json"]) expect(ignore).not.toContain(gone);
  });

  it("retires an existing prompts directory to a backup and reseeds defaults", async () => {
    const promptsDirectory = path.join(jfdiDirectory, "prompts");
    await fs.mkdir(promptsDirectory, { recursive: true });
    await fs.writeFile(path.join(promptsDirectory, "implementation.md"), "tuned prompt — keep me");

    const { retiredPromptsPath } = await scaffoldJfdi(root, jfdiDirectory);

    expect(retiredPromptsPath).not.toBeNull();
    expect(path.basename(retiredPromptsPath ?? "")).toMatch(/^prompts\.backup-/);
    // The tuned file survives byte-for-byte in the backup...
    const preserved = await fs.readFile(
      path.join(retiredPromptsPath ?? "", "implementation.md"),
      "utf8",
    );
    expect(preserved).toBe("tuned prompt — keep me");
    // ...and the prompts directory holds clean generic defaults again — the
    // raw material the init session instantiates, never the old adaptation.
    const reseeded = await fs.readFile(path.join(promptsDirectory, "implementation.md"), "utf8");
    expect(reseeded).toContain("Implement the ticket below completely");
  });

  it("is idempotent and never overwrites user files", async () => {
    await scaffoldJfdi(root, jfdiDirectory);
    await fs.writeFile(path.join(jfdiDirectory, "sandbox.md"), "my custom contract");
    await fs.writeFile(path.join(jfdiDirectory, "ticket-format.md"), "my local ticket format");
    await fs.writeFile(path.join(jfdiDirectory, "config.json"), '{"maxConcurrent": 9}');
    await scaffoldJfdi(root, jfdiDirectory);
    expect(await fs.readFile(path.join(jfdiDirectory, "sandbox.md"), "utf8")).toBe(
      "my custom contract",
    );
    expect(await fs.readFile(path.join(jfdiDirectory, "config.json"), "utf8")).toBe(
      '{"maxConcurrent": 9}',
    );
    expect(await fs.readFile(path.join(jfdiDirectory, "ticket-format.md"), "utf8")).toBe(
      "my local ticket format",
    );
  });

  it("respects configured column names and paths", async () => {
    const config = defaultConfig();
    config.board.columns.begin = "To Do";
    await scaffoldJfdi(root, jfdiDirectory, config);
    const board = parseBoard(await fs.readFile(path.join(jfdiDirectory, "board.md"), "utf8"));
    expect(board.columns[0]?.name).toBe("To Do");
  });
});
