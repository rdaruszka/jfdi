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

/**
 * An interactive launch takes the implementation stage's agent, so that is the
 * only entry a project here needs to vary. Omitting it means no config.json at
 * all — the scaffold defaults.
 */
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
fs.writeFileSync(process.env.TRACE_PATH, JSON.stringify({
  executable: require("node:path").basename(process.argv[1]),
  args: process.argv.slice(2),
  cwd: process.cwd(),
}));
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

async function runCli(
  project: string,
  environment: NodeJS.ProcessEnv,
  command: "init" | "convo",
): Promise<void> {
  await execFileAsync(process.execPath, [cliPath, command], { cwd: project, env: environment });
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
  it.each(["init", "convo"] as const)(
    "routes %s through the implementation stage's Codex",
    async (command) => {
      const sandbox = await makeProject({ harness: "codex" });
      await runCli(sandbox.project, sandbox.environment, command);

      const trace = await readTrace(sandbox.tracePath);
      expect(trace.executable).toBe("codex");
      expect(trace.args.slice(0, 4)).toEqual([
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
      ]);
      expect(trace.args).not.toContain("--full-auto");
      expect(trace.args.at(-1)).toContain(
        command === "init"
          ? "You are bootstrapping **JFDI**"
          : "You are working on the **JFDI layer**",
      );
      // A harness-only entry inherits no model from the scaffolded mix.
      expect(trace.args).not.toContain("--model");
      expect(trace.cwd).toBe(sandbox.project);
    },
  );

  it("carries the implementation stage's model and effort into the session", async () => {
    const sandbox = await makeProject({ harness: "codex", model: "gpt-5.6-sol", effort: "low" });
    await runCli(sandbox.project, sandbox.environment, "convo");

    const trace = await readTrace(sandbox.tracePath);
    expect(trace.args).toEqual([
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=low",
      expect.stringContaining("You are working on the **JFDI layer**"),
    ]);
  });

  it("keeps new scaffolds on the default mix's Claude", async () => {
    const sandbox = await makeProject();
    await runCli(sandbox.project, sandbox.environment, "init");

    const trace = await readTrace(sandbox.tracePath);
    expect(trace.executable).toBe("claude");
    const { model, effort } = defaultConfig().stages.implementation;
    expect(trace.args.slice(0, 6)).toEqual([
      "--permission-mode",
      "auto",
      "--model",
      model,
      "--effort",
      effort,
    ]);
    expect(trace.args.at(-1)).toContain("You are bootstrapping **JFDI**");
    expect(trace.cwd).toBe(sandbox.project);
  });
});
