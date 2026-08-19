import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { CODING_GUIDELINES } from "./guidelines.js";
import { JFDI_OPERATIONS } from "./jfdi-operations.js";
import { TICKET_FORMAT } from "./ticket-format.js";

/**
 * Behavioral proof that `jfdi init` builds the setup session the fresh-eyes
 * way: the operations brief and coding guidelines land in the appended system
 * prompt (--append-system-prompt), the opening user message is the action
 * sequence, the session is isolated from the project's own agent instructions
 * (--bare), and a pre-existing prompts directory is retired to a backup the
 * agent never reads. It drives the built CLI end to end with a stub `claude`
 * that dumps its argv (see harness/claude.ts spawnInteractive).
 */
const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const sandboxRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxRoots
      .splice(0)
      .map((sandboxRoot) => fs.rm(sandboxRoot, { recursive: true, force: true })),
  );
});

interface InitRun {
  systemPrompt: string;
  userPrompt: string;
  args: string[];
  project: string;
}

async function runInitAndCapturePrompt(staleInitPrompt?: string): Promise<InitRun> {
  const createdSandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-init-operations-"));
  sandboxRoots.push(createdSandboxRoot);
  const sandboxRoot = await fs.realpath(createdSandboxRoot);
  const project = path.join(sandboxRoot, "project");
  const binDir = path.join(sandboxRoot, "bin");
  const jfdiHome = path.join(sandboxRoot, "home");
  const tracePath = path.join(sandboxRoot, "trace.json");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(binDir);
  await fs.mkdir(jfdiHome);
  if (staleInitPrompt !== undefined) {
    await fs.mkdir(path.join(project, ".jfdi/prompts"), { recursive: true });
    await fs.writeFile(path.join(project, ".jfdi/prompts/init.md"), staleInitPrompt);
  }

  // The default scaffold routes the interactive launch through Claude; stub both
  // so the inner session never reaches a real agent CLI, dumping argv instead.
  const stub = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.TRACE_PATH, JSON.stringify({ args: process.argv.slice(2) }));
`;
  await Promise.all(
    ["claude", "codex"].map((executable) =>
      fs.writeFile(path.join(binDir, executable), stub, { mode: 0o755 }),
    ),
  );

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: project,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TRACE_PATH: tracePath,
      JFDI_HOME: jfdiHome,
    },
  });

  const trace = JSON.parse(await fs.readFile(tracePath, "utf8")) as { args: string[] };
  const systemPromptFlagIndex = trace.args.indexOf("--append-system-prompt");
  const systemPrompt = systemPromptFlagIndex === -1 ? "" : trace.args[systemPromptFlagIndex + 1];
  const userPrompt = trace.args.at(-1);
  if (systemPrompt === undefined || systemPrompt === "" || userPrompt === undefined)
    throw new Error("init launched no agent session with a system prompt and opening message");
  return { systemPrompt, userPrompt, args: trace.args, project };
}

describe("jfdi init builds an isolated fresh-eyes setup session", () => {
  it("injects the operations brief and guidelines into the system prompt, brief first", async () => {
    const { systemPrompt, userPrompt } = await runInitAndCapturePrompt();

    // The {{JFDI_OPERATIONS}} placeholder is fully substituted — not dropped,
    // not left literal.
    expect(systemPrompt).not.toContain("{{JFDI_OPERATIONS}}");

    // Both compiled constants reach the agent verbatim, in the system prompt.
    expect(systemPrompt).toContain(JFDI_OPERATIONS);
    expect(systemPrompt).toContain(CODING_GUIDELINES);

    // Placement: the machine before the rules it instantiates.
    expect(systemPrompt.indexOf(JFDI_OPERATIONS)).toBeLessThan(
      systemPrompt.indexOf(CODING_GUIDELINES),
    );
    expect(systemPrompt.indexOf("# How the workflow runs your project")).toBeLessThan(
      systemPrompt.indexOf("# Coding Guidelines"),
    );

    // The opening user message is the action sequence, exploration first.
    expect(userPrompt).toContain("Explore the project first");
    expect(userPrompt).toContain("It must point to .jfdi/ticket-format.md as required reading");
  });

  it("ships the authoritative ticket format for the setup agent to link", async () => {
    const { project } = await runInitAndCapturePrompt();

    expect(await fs.readFile(path.join(project, ".jfdi/ticket-format.md"), "utf8")).toBe(
      TICKET_FORMAT,
    );
  });

  it("isolates the session from the project's own agent instructions", async () => {
    const { args, systemPrompt } = await runInitAndCapturePrompt();

    // --setting-sources "" keeps CLAUDE.md/AGENTS.md auto-discovery, settings,
    // and hooks out of the session (not --bare — that severs OAuth auth), and
    // autoMemoryEnabled=false keeps the user's per-project auto-memory out —
    // a separate subsystem --setting-sources does not cover. The appended
    // system prompt is deliberately brand-free.
    const settingSourcesFlagIndex = args.indexOf("--setting-sources");
    expect(settingSourcesFlagIndex).toBeGreaterThan(-1);
    expect(args[settingSourcesFlagIndex + 1]).toBe("");
    const settingsFlagIndex = args.indexOf("--settings");
    expect(settingsFlagIndex).toBeGreaterThan(-1);
    expect(args[settingsFlagIndex + 1]).toBe('{"autoMemoryEnabled": false}');
    expect(systemPrompt).toContain("agentic coding workflow");
    expect(systemPrompt).not.toContain("JFDI");
  });

  // A stale prompts directory (from any earlier era) is retired before the
  // session and replaced with clean generic defaults, so no earlier prompt
  // text can shadow or contaminate the setup agent.
  it("retires a pre-existing prompts directory and reseeds defaults", async () => {
    const legacyBootstrapPrompt =
      "You are bootstrapping **JFDI** (an automated implement → review → QA → merge\n" +
      "pipeline) for this repository. A skeleton .jfdi/ directory has just been scaffolded.";
    const { systemPrompt, userPrompt, project } =
      await runInitAndCapturePrompt(legacyBootstrapPrompt);

    expect(systemPrompt).not.toContain("bootstrapping **JFDI**");
    expect(userPrompt).not.toContain("bootstrapping **JFDI**");
    // The stale init.md is gone from prompts/ (init's prompt is source-owned,
    // so the reseeded set never contains one).
    const reseeded = await fs.readdir(path.join(project, ".jfdi/prompts"));
    expect(reseeded).not.toContain("init.md");
    expect(reseeded).toHaveLength(8);
  });

  // Retired means preserved for the human, byte-for-byte — never deleted.
  it("preserves a retired prompt file in the backup directory unchanged", async () => {
    const staleInitPrompt = "legacy bootstrap text — SENTINEL-DO-NOT-TOUCH\n";
    const { project } = await runInitAndCapturePrompt(staleInitPrompt);

    const jfdiEntries = await fs.readdir(path.join(project, ".jfdi"));
    const backupName = jfdiEntries.find((entry) => entry.startsWith("prompts.backup-"));
    if (backupName === undefined) throw new Error("no prompts backup directory was created");
    const onDisk = await fs.readFile(path.join(project, ".jfdi", backupName, "init.md"), "utf8");
    expect(onDisk).toBe(staleInitPrompt);
  });
});
