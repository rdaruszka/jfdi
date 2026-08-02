import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");
const BUILD_TIMEOUT_MS = 180_000;

const sandboxRoots: string[] = [];

beforeAll(async () => {
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot, timeout: BUILD_TIMEOUT_MS });
});

afterEach(async () => {
  await Promise.all(
    sandboxRoots
      .splice(0)
      .map((sandboxRoot) => fs.rm(sandboxRoot, { recursive: true, force: true })),
  );
});

async function makeProject(harness?: "claude" | "codex"): Promise<{
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
  if (harness) {
    await fs.writeFile(
      path.join(project, ".jfdi", "config.json"),
      `${JSON.stringify({ harness })}\n`,
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
  it.each(["init", "convo"] as const)("routes %s through Codex", async (command) => {
    const sandbox = await makeProject("codex");
    await runCli(sandbox.project, sandbox.environment, command);

    const trace = await readTrace(sandbox.tracePath);
    expect(trace.executable).toBe("codex");
    expect(trace.args[0]).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(trace.args[1]).toContain(
      command === "init"
        ? "You are bootstrapping **JFDI**"
        : "You are working on the **JFDI layer**",
    );
    expect(trace.cwd).toBe(sandbox.project);
  });

  it("keeps new scaffolds on Claude", async () => {
    const sandbox = await makeProject();
    await runCli(sandbox.project, sandbox.environment, "init");

    const trace = await readTrace(sandbox.tracePath);
    expect(trace.executable).toBe("claude");
    expect(trace.args[0]).toContain("You are bootstrapping **JFDI**");
    expect(trace.cwd).toBe(sandbox.project);
  });
});
