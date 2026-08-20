/**
 * End-to-end acceptance for `jfdi update-config`, derived from the ticket.
 *
 * The sibling `config-legacy-aliases.e2e.test.ts` proves legacy spellings still
 * *drive a run*; this file proves the migration *command* itself, driving the
 * built CLI (`dist/index.js`) in a scratch repo under the OS temp dir. The
 * acceptance criteria exercised here:
 *
 *   1. Running on a config using every legacy spelling produces a canonical
 *      config; keys the schema does not define survive the rewrite.
 *   2. A second run reports there was nothing to change and leaves the file
 *      byte-for-byte identical.
 *   3. No agent session is spawned on any path — a stub `claude`/`codex` on
 *      PATH that would leave a sentinel is never invoked.
 *   4. Invalid JSON exits non-zero naming the file and the parse error, and the
 *      file is left unmodified.
 *   5. An absent config is a clean, zero-exit no-op.
 *
 * `HOME`/`JFDI_HOME` always point inside the scratch tree, and the stub agents
 * guard against runaway session spawning — nothing here reaches a real CLI or
 * the real `~/.jfdi`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const projectRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(projectRoot, "dist", "index.js");

/**
 * A stub agent that, if ever spawned, writes a sentinel file — so a test can
 * assert `update-config` never reached a harness. It exits immediately; the
 * command must not depend on any agent output.
 */
const SENTINEL_STUB = `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.AGENT_SENTINEL, "spawned\\n");
process.exit(0);
`;

const CANONICAL_STAGES = {
  implementation: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
  "code-review": { harness: "codex", model: "gpt-5.6-sol", effort: "high" },
  qa: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
  integration: { harness: "claude", model: "claude-opus-4-8", effort: "medium" },
  "commit-message": { harness: "claude", model: "claude-sonnet-5" },
};

interface Sandbox {
  project: string;
  configPath: string;
  sentinel: string;
  binDirectory: string;
  home: string;
  jfdiHome: string;
}

const scratchDirs: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-uc-cmd-"));
  const root = await fs.realpath(created);
  scratchDirs.push(created);
  const project = path.join(root, "project");
  const binDirectory = path.join(root, "bin");
  const home = path.join(root, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(binDirectory);
  await fs.mkdir(home);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(binDirectory, executable), SENTINEL_STUB, { mode: 0o755 });
  }
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");
  await fs.mkdir(path.join(project, ".jfdi"));
  return {
    project,
    configPath: path.join(project, ".jfdi", "config.json"),
    sentinel: path.join(root, "agent-sentinel"),
    binDirectory,
    home,
    jfdiHome: path.join(home, ".jfdi"),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    AGENT_SENTINEL: sandbox.sentinel,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function noAgentSpawned(sandbox: Sandbox): Promise<boolean> {
  return !(await fs
    .access(sandbox.sentinel)
    .then(() => true)
    .catch(() => false));
}

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("jfdi update-config migrates legacy config keys mechanically", () => {
  it("rewrites every legacy spelling to canonical, keeps unknown keys, and spawns no agent", async () => {
    const sandbox = await makeSandbox();
    const legacyConfig = {
      customTop: { owner: "example" },
      ticketsDir: ".legacy-tickets",
      gate: [{ name: "test", cmd: "pnpm test", customGate: true }],
      pipeline: { max_rounds: 5, customPipe: "kept" },
      integration: {
        target_branch: "develop",
        mode: "auto",
        remote: { fetch_before: true, push_after: true, customRemote: 17 },
      },
      max_concurrent: 4,
      stages: CANONICAL_STAGES,
    };
    await fs.writeFile(sandbox.configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);

    const result = await runCli(sandbox, ["update-config"]);
    expect(result.code).toBe(0);
    // Reports each rename it performed.
    for (const rename of [
      "ticketsDir → ticketsDirectory",
      "gate[0].cmd → gate[0].command",
      "pipeline.max_rounds → pipeline.maxRounds",
      "integration.target_branch → integration.targetBranch",
      "integration.remote.fetch_before → integration.remote.fetchBefore",
      "integration.remote.push_after → integration.remote.pushAfter",
      "max_concurrent → maxConcurrent",
    ]) {
      expect(result.stdout).toContain(rename);
    }

    const migrated = JSON.parse(await fs.readFile(sandbox.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    // Canonical spellings present, legacy spellings gone.
    expect(migrated).toMatchObject({
      customTop: { owner: "example" },
      ticketsDirectory: ".legacy-tickets",
      gate: [{ name: "test", command: "pnpm test", customGate: true }],
      pipeline: { maxRounds: 5, customPipe: "kept" },
      integration: {
        targetBranch: "develop",
        mode: "auto",
        remote: { fetchBefore: true, pushAfter: true, customRemote: 17 },
      },
      maxConcurrent: 4,
    });
    const serialized = JSON.stringify(migrated);
    for (const legacyKey of [
      "ticketsDir",
      "cmd",
      "max_rounds",
      "target_branch",
      "fetch_before",
      "push_after",
      "max_concurrent",
    ]) {
      expect(serialized).not.toContain(`"${legacyKey}"`);
    }
    // The canonical result no longer trips the read-time notice.
    const status = await runCli(sandbox, ["status"]);
    expect(status.stderr).not.toContain("update-config");
    // No agent session on any path.
    expect(await noAgentSpawned(sandbox)).toBe(true);
  });

  it("is idempotent: a second run changes nothing and reports nothing to update", async () => {
    const sandbox = await makeSandbox();
    await fs.writeFile(
      sandbox.configPath,
      `${JSON.stringify({ ticketsDir: ".legacy-tickets", stages: CANONICAL_STAGES }, null, 2)}\n`,
    );
    expect((await runCli(sandbox, ["update-config"])).code).toBe(0);
    const afterFirst = await fs.readFile(sandbox.configPath, "utf8");

    const second = await runCli(sandbox, ["update-config"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("nothing to update");
    expect(await fs.readFile(sandbox.configPath, "utf8")).toBe(afterFirst);
    expect(await noAgentSpawned(sandbox)).toBe(true);
  });

  it("fails loud on invalid JSON, naming the file, and leaves it unmodified", async () => {
    const sandbox = await makeSandbox();
    const invalid = "{ not json";
    await fs.writeFile(sandbox.configPath, invalid);

    const result = await runCli(sandbox, ["update-config"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(sandbox.configPath);
    expect(result.stderr.toLowerCase()).toContain("invalid json");
    expect(await fs.readFile(sandbox.configPath, "utf8")).toBe(invalid);
    expect(await noAgentSpawned(sandbox)).toBe(true);
  });

  it("treats an absent config as a clean no-op", async () => {
    const sandbox = await makeSandbox();
    // .jfdi exists but holds no config.json.
    const result = await runCli(sandbox, ["update-config"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("does not exist");
    expect(await noAgentSpawned(sandbox)).toBe(true);
  });
});
