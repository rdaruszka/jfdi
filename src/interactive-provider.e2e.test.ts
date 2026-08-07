import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { git } from "./git.js";

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

/** A pre-existing implementation selection proves init does not borrow it. */
async function makeProject(implementationStage?: {
  harness: "claude" | "codex";
  model?: string;
  effort?: string;
}): Promise<{
  project: string;
  environment: NodeJS.ProcessEnv;
  tracePath: string;
}> {
  const createdSandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-interactive-provider-"));
  sandboxRoots.push(createdSandboxRoot);
  const sandboxRoot = await fs.realpath(createdSandboxRoot);
  const project = path.join(sandboxRoot, "project");
  const binDir = path.join(sandboxRoot, "bin");
  const tracePath = path.join(sandboxRoot, "trace.json");
  await fs.mkdir(path.join(project, ".jfdi"), { recursive: true });
  await fs.mkdir(binDir);
  if (implementationStage) {
    const stages = { ...defaultConfig().stages, implementation: implementationStage };
    await fs.writeFile(
      path.join(project, ".jfdi", "config.json"),
      `${JSON.stringify({ stages }, null, 2)}\n`,
    );
  }

  const stub = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.GATE_AFTER_SESSION) {
  const configPath = require("node:path").join(process.cwd(), ".jfdi", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.gate = [{ name: "after-session", cmd: process.env.GATE_AFTER_SESSION }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
}
fs.writeFileSync(process.env.TRACE_PATH, JSON.stringify({
  executable: require("node:path").basename(process.argv[1]),
  args: process.argv.slice(2),
  cwd: process.cwd(),
}));
process.exit(Number(process.env.SESSION_EXIT ?? 0));
`;
  await Promise.all(
    ["claude", "codex"].map((executable) =>
      fs.writeFile(path.join(binDir, executable), stub, { mode: 0o755 }),
    ),
  );

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  return {
    project,
    tracePath,
    environment: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TRACE_PATH: tracePath,
    },
  };
}

function runCli(project: string, environment: NodeJS.ProcessEnv, args: string[]) {
  return execFileAsync(process.execPath, [cliPath, ...args], { cwd: project, env: environment });
}

async function readTrace(tracePath: string): Promise<{
  executable: string;
  args: string[];
  cwd: string;
}> {
  return JSON.parse(await fs.readFile(tracePath, "utf8")) as {
    executable: string;
    args: string[];
    cwd: string;
  };
}

describe("interactive provider selection", () => {
  it("takes the provider, model, and effort from init flags", async () => {
    const sandbox = await makeProject();
    await runCli(sandbox.project, sandbox.environment, [
      "init",
      "--harness",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "low",
    ]);

    const trace = await readTrace(sandbox.tracePath);
    expect(trace.executable).toBe("codex");
    expect(trace.args).toEqual([
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=low",
      // Fresh-eyes isolation: Codex must not ingest the project's AGENTS.md.
      "-c",
      "project_doc_max_bytes=0",
      // No system-prompt seam on Codex: the system framing degrades to a
      // preamble on the opening message, followed by the action sequence.
      expect.stringContaining("You are configuring an agentic coding workflow"),
    ]);
    expect(trace.args.at(-1)).toContain("Explore the project first");
    expect(trace.cwd).toBe(sandbox.project);
  });

  it("uses init's defaults instead of the implementation stage selection", async () => {
    const sandbox = await makeProject({ harness: "codex", model: "gpt-5.6-sol", effort: "low" });
    await runCli(sandbox.project, sandbox.environment, ["init"]);

    const trace = await readTrace(sandbox.tracePath);
    expect(trace.executable).toBe("claude");
    expect(trace.args.slice(0, 4)).toEqual([
      "--permission-mode",
      "auto",
      "--model",
      "claude-fable-5",
    ]);
    expect(trace.args).not.toContain("--effort");
    // Fresh-eyes isolation plus the appended (never replaced) system prompt.
    // --setting-sources "", not --bare: bare mode refuses OAuth/keychain auth.
    // Auto-memory is a separate subsystem, disabled via its settings key.
    const settingSourcesFlagIndex = trace.args.indexOf("--setting-sources");
    expect(settingSourcesFlagIndex).toBeGreaterThan(-1);
    expect(trace.args[settingSourcesFlagIndex + 1]).toBe("");
    const settingsFlagIndex = trace.args.indexOf("--settings");
    expect(settingsFlagIndex).toBeGreaterThan(-1);
    expect(trace.args[settingsFlagIndex + 1]).toBe('{"autoMemoryEnabled": false}');
    const systemPromptFlagIndex = trace.args.indexOf("--append-system-prompt");
    expect(systemPromptFlagIndex).toBeGreaterThan(-1);
    expect(trace.args[systemPromptFlagIndex + 1]).toContain(
      "You are configuring an agentic coding workflow",
    );
    expect(trace.args.at(-1)).toContain("Explore the project first");
    expect(trace.cwd).toBe(sandbox.project);
  });

  it("verifies the gate itself after a session that exited cleanly", async () => {
    const sandbox = await makeProject();
    const { stdout } = await runCli(sandbox.project, sandbox.environment, ["init"]);
    expect(stdout).toContain("gate verified");
  });

  it("scaffolds without launching a session under --bare", async () => {
    const sandbox = await makeProject();
    const { stdout } = await runCli(sandbox.project, sandbox.environment, ["init", "--bare"]);

    expect(stdout).toContain("scaffolded .jfdi/");
    expect(stdout).not.toContain("gate verified");
    await expect(fs.access(sandbox.tracePath)).rejects.toThrow();
  });

  it("no longer exposes a convo command", async () => {
    const sandbox = await makeProject();
    let failure: unknown;
    try {
      await runCli(sandbox.project, sandbox.environment, ["convo"]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('unknown command "convo"'),
    });
    await expect(fs.access(sandbox.tracePath)).rejects.toThrow();
  });

  it("propagates the session exit code while still running the gate backstop", async () => {
    const sandbox = await makeProject();
    let failure: unknown;
    try {
      await runCli(sandbox.project, { ...sandbox.environment, SESSION_EXIT: "3" }, ["init"]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 3,
      stderr: expect.stringContaining("setup session exited with code 3"),
      stdout: expect.stringContaining("gate verified"),
    });
  });

  it("reloads the post-session config and reports the failing gate step", async () => {
    const sandbox = await makeProject();
    let failure: unknown;
    try {
      await runCli(sandbox.project, { ...sandbox.environment, GATE_AFTER_SESSION: "exit 7" }, [
        "init",
      ]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        'gate failed at "after-session"; rerun `jfdi init` to finish setup',
      ),
    });
  });
});
