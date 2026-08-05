/**
 * Instance-wide permission mode, pinned from outside the process.
 *
 * The harness unit suites construct a `ClaudeHarness`/`CodexHarness` with a
 * permission mode by hand and assert the argv it builds. The interactive-provider
 * suite covers `jfdi init`/`jfdi convo`. Nothing pinned the *pipeline* path: that
 * `config.permissions.mode` is read once, threaded through
 * `createSessionHarnesses`, and reaches every headless and continued session's
 * CLI — across both providers a single run spans.
 *
 * These tests drive `dist/index.js run` in a scratch repo with stub `claude` and
 * `codex` on `PATH` and assert the permission flags each CLI actually received,
 * for `auto` (the default), `bypass`, and a continuation. `JFDI_HOME`/`HOME`
 * stay inside the scratch tree, and the stubs never touch the network.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");
const PIPELINE_TIMEOUT_MS = 120_000;

/** The auto-mode Codex args, in order — sandbox plus the network override. */
const CODEX_AUTO_ARGS = [
  "--sandbox",
  "workspace-write",
  "-c",
  "sandbox_workspace_write.network_access=true",
];
const CODEX_BYPASS_ARG = "--dangerously-bypass-approvals-and-sandbox";

/** Record the argv, then answer the stage the prompt names. Never hits the net. */
const STUB_BODY = `
const fs = require("node:fs");
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({ cli: cliName, argv }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    verdict = { status: "done", summary: "wrote the feature" };
  } else if (stage === "code-review") {
    const seen = Number(fs.existsSync(process.env.STUB_REVIEW_COUNT)
      ? fs.readFileSync(process.env.STUB_REVIEW_COUNT, "utf8") : "0") + 1;
    fs.writeFileSync(process.env.STUB_REVIEW_COUNT, String(seen));
    verdict = seen === 1 && process.env.STUB_REVIEW_FAILS_ONCE
      ? { verdict: "fail", feedback: "name it better" }
      : { verdict: "pass" };
  } else if (stage === "qa") {
    verdict = { verdict: "pass", testsAdded: "one" };
  } else {
    verdict = { resolution: "clean" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "claude-session" }) + "\\n");
`;

const STUB_CODEX = `#!/usr/bin/env node
const cliName = "codex";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n");
`;

/** `PATH` with every directory holding a real agent CLI removed. */
function agentFreePath(binDir: string): string {
  const inherited = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(
      (dir) =>
        dir !== "" && !existsSync(path.join(dir, "claude")) && !existsSync(path.join(dir, "codex")),
    );
  return [binDir, ...inherited].join(path.delimiter);
}

interface Sandbox {
  root: string;
  project: string;
  binDir: string;
  argvLog: string;
  environment: NodeJS.ProcessEnv;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-permission-mode-"));
  sandboxRoots.push(created);
  const root = await fs.realpath(created);
  const project = path.join(root, "project");
  const binDir = path.join(root, "bin");
  const home = path.join(root, "home");
  const jfdiHome = path.join(home, ".jfdi");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(binDir);
  await fs.mkdir(home);
  await fs.writeFile(path.join(binDir, "claude"), STUB_CLAUDE, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "codex"), STUB_CODEX, { mode: 0o755 });
  await fs.symlink(process.execPath, path.join(binDir, "node"));

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  return {
    root,
    project,
    binDir,
    argvLog: path.join(root, "argv.jsonl"),
    environment: {
      ...process.env,
      PATH: agentFreePath(binDir),
      HOME: home,
      JFDI_HOME: jfdiHome,
      STUB_ARGV_LOG: path.join(root, "argv.jsonl"),
      STUB_REVIEW_COUNT: path.join(root, "review-count"),
      NO_COLOR: "1",
    },
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env: { ...sandbox.environment, ...extraEnvironment },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Scaffold, then set `permissions.mode` (omit to leave the scaffolded default). */
async function scaffold(sandbox: Sandbox, permissionMode?: "auto" | "bypass"): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  if (permissionMode === undefined) return;
  const configPath = path.join(sandbox.project, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  await fs.writeFile(
    configPath,
    JSON.stringify({ ...config, permissions: { mode: permissionMode } }, null, 2),
  );
}

interface Invocation {
  cli: string;
  argv: string[];
  isContinuation: boolean;
}

/** What each stub was actually handed, in the order the stages ran. */
async function invocations(sandbox: Sandbox): Promise<Invocation[]> {
  const raw = await fs.readFile(sandbox.argvLog, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { cli: string; argv: string[] })
    .map(({ cli, argv }) => ({
      cli,
      argv,
      isContinuation: argv.includes("--resume") || argv[1] === "resume",
    }));
}

/** The subsequence `[flag, value]` appears somewhere in argv, in that order. */
function hasFlagValue(argv: string[], flag: string, value: string): boolean {
  const at = argv.indexOf(flag);
  return at !== -1 && argv[at + 1] === value;
}

function containsInOrder(argv: string[], subsequence: string[]): boolean {
  const first = argv.indexOf(subsequence[0] ?? "");
  if (first === -1) return false;
  return subsequence.every((token, offset) => argv[first + offset] === token);
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("permission mode, end to end", () => {
  it(
    "defaults an un-set config to auto and maps it per provider across a full run",
    async () => {
      const sandbox = await makeSandbox();
      // No permissions block written: the scaffolded default must be auto.
      await scaffold(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);

      const calls = await invocations(sandbox);
      // The cross-provider default spans both CLIs in one run.
      expect(calls.some((call) => call.cli === "claude")).toBe(true);
      expect(calls.some((call) => call.cli === "codex")).toBe(true);

      for (const call of calls) {
        if (call.cli === "claude") {
          expect(hasFlagValue(call.argv, "--permission-mode", "auto")).toBe(true);
          expect(call.argv).not.toContain("bypassPermissions");
        } else {
          expect(containsInOrder(call.argv, CODEX_AUTO_ARGS)).toBe(true);
          expect(call.argv).not.toContain(CODEX_BYPASS_ARG);
          // The deprecated compatibility path is never used.
          expect(call.argv).not.toContain("--full-auto");
        }
      }
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "maps an explicit bypass to each provider's full-bypass flag across a full run",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox, "bypass");

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);

      const calls = await invocations(sandbox);
      expect(calls.some((call) => call.cli === "claude")).toBe(true);
      expect(calls.some((call) => call.cli === "codex")).toBe(true);

      for (const call of calls) {
        if (call.cli === "claude") {
          expect(hasFlagValue(call.argv, "--permission-mode", "bypassPermissions")).toBe(true);
          expect(call.argv).not.toContain("auto");
        } else {
          expect(call.argv).toContain(CODEX_BYPASS_ARG);
          expect(call.argv).not.toContain("--sandbox");
          expect(call.argv).not.toContain("sandbox_workspace_write.network_access=true");
        }
      }
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "carries the mode into a continued (resumed) session too",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox, "auto");

      // A first-round review failure forces round 2 to continue the earlier
      // Implementation and Code Review sessions, exercising the resume paths.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        STUB_REVIEW_FAILS_ONCE: "1",
      });
      expect(run.code).toBe(0);

      const continuations = (await invocations(sandbox)).filter((call) => call.isContinuation);
      // Both a Claude `--resume` and a Codex `exec resume` should appear.
      expect(continuations.some((call) => call.cli === "claude")).toBe(true);
      expect(continuations.some((call) => call.cli === "codex")).toBe(true);

      for (const call of continuations) {
        if (call.cli === "claude") {
          expect(hasFlagValue(call.argv, "--permission-mode", "auto")).toBe(true);
        } else {
          expect(containsInOrder(call.argv, CODEX_AUTO_ARGS)).toBe(true);
          // Flags still precede the positional thread id on a resume.
          const threadAt = call.argv.indexOf("codex-thread");
          expect(threadAt).toBeGreaterThan(call.argv.indexOf("--sandbox"));
        }
      }
    },
    PIPELINE_TIMEOUT_MS,
  );
});
