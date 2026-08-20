/**
 * End-to-end acceptance for the canonical config schema's legacy-key aliases.
 *
 * Derived from the ticket, not the diff. The schema's keys became camelCase
 * (`gate[].command`, `ticketsDirectory`, `pipeline.maxRounds`,
 * `integration.targetBranch`, `integration.remote.fetchBefore`/`pushAfter`,
 * `maxConcurrent`), and every prior spelling (`cmd`, `ticketsDir`, `max_rounds`,
 * `target_branch`, `fetch_before`, `push_after`, `max_concurrent`) must keep
 * working as aliases while producing one migration notice. The acceptance
 * criteria this file exercises against the built CLI, not `parseConfig` in
 * isolation:
 *
 *   1. A config written entirely in legacy spellings drives a real run
 *      identically — the gate command reaches execution from `cmd`, the ticket
 *      note lands in the directory named by `ticketsDir`, and the run passes
 *      with one actionable warning about the spellings.
 *   2. A gate entry carrying both `cmd` and `command` with conflicting values
 *      fails the CLI, and the error names the entry and both values.
 *
 * Everything drives the built CLI (`dist/index.js`) in a scratch repo under the
 * OS temp dir, with stub `claude` and `codex` binaries on PATH.
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const SCENARIO_TIMEOUT_MS = 180_000;

/**
 * The agent both stubbed CLIs play; it never talks to the network. The
 * implementation session commits one file so the worktree changes and the gate
 * has something to run against; every reviewer verdict passes.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "impl"], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented" };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

/**
 * A green gate that echoes a unique marker, so the persisted gate transcript
 * proves the command supplied under the *legacy* `cmd` key actually executed —
 * not a default and not a silently-dropped step.
 */
const GATE_MARKER = "LEGACY_CMD_RAN";
const GATE_COMMAND = `echo ${GATE_MARKER}`;
const LEGACY_TICKETS_DIR = ".legacy-tickets";

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
}

const sandboxes: string[] = [];

function expectedProjectKey(projectRoot: string): string {
  return projectRoot.split(path.sep).join("-");
}

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-cfg-alias-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(binDir, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    project,
    home,
    jfdiHome,
    stateDir: path.join(jfdiHome, "projects", expectedProjectKey(project)),
    binDir,
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
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
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

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

/** Read the config.json `init --bare` wrote (all canonical keys). */
async function readConfig(sandbox: Sandbox): Promise<Record<string, unknown>> {
  const configPath = path.join(sandbox.project, ".jfdi", "config.json");
  return JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
}

async function writeConfig(sandbox: Sandbox, config: unknown): Promise<void> {
  const configPath = path.join(sandbox.project, ".jfdi", "config.json");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("legacy config keys drive a real run identically to canonical", () => {
  it(
    "runs the pipeline from an all-legacy config: cmd gate executes and the note lands in ticketsDir",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // Rewrite the scaffolded (canonical) config entirely in legacy spellings.
      // `stages` is untouched by this ticket, so it is carried over verbatim to
      // keep the config valid; every aliased key uses its legacy name.
      const canonical = await readConfig(sandbox);
      const legacyConfig = {
        board: canonical.board,
        ticketsDir: LEGACY_TICKETS_DIR,
        gate: [{ name: "check", cmd: GATE_COMMAND }],
        pipeline: { max_rounds: 3 },
        integration: {
          target_branch: "main",
          mode: "on-approval",
          remote: { fetch_before: false, push_after: false },
        },
        permissions: { mode: "auto" },
        max_concurrent: 2,
        stages: canonical.stages,
      };
      await writeConfig(sandbox, legacyConfig);

      const run = await runCli(sandbox, ["run", "Legacy keys drive me"]);
      // The run passed end to end: the gate supplied under legacy `cmd` was read
      // and executed (a missing/misread gate would have surfaced as a config
      // rejection or a skipped check), and on-approval parked it ready to merge.
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Approve with: jfdi merge");
      // One read-time notice nudges the user toward the mechanical migration.
      expect(run.stderr.match(/jfdi update-config/g)).toHaveLength(1);
      expect(run.stderr).toContain("ticketsDir");
      expect(run.stderr).toContain("cmd");

      const ticketId = ticketIdOf(run);

      // The gate command from legacy `cmd` actually executed: its unique marker
      // is in the persisted transcript under the run directory.
      const gateLog = await fs.readFile(
        path.join(
          sandbox.stateDir,
          "runs",
          ticketId,
          "run-1",
          "round-1",
          "gate-implementation-1.log",
        ),
        "utf8",
      );
      expect(gateLog).toContain(GATE_MARKER);

      // `ticketsDir` (legacy) directed where the ticket note was written.
      const legacyTicketsDir = path.join(sandbox.project, LEGACY_TICKETS_DIR);
      const notes = await fs.readdir(legacyTicketsDir);
      expect(notes.some((name) => name.endsWith(".md"))).toBe(true);
      const noteBody = await fs.readFile(path.join(legacyTicketsDir, `${ticketId}.md`), "utf8");
      // The note carries the pipeline's phase comments, proving the run wrote
      // through the legacy-configured directory, not the default `.jfdi/tickets`.
      expect(noteBody).toContain("## Comments");

      // The default tickets directory was never used for this run's note.
      const defaultTicketsDir = path.join(sandbox.project, ".jfdi", "tickets");
      const defaultNotes = await fs.readdir(defaultTicketsDir).catch(() => [] as string[]);
      expect(defaultNotes).not.toContain(`${ticketId}.md`);

      // It really is mergeable: approval lands it on the (legacy-named) target.
      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(0);
      expect(await git(sandbox.project, "log", "--oneline", "main")).toContain(`${ticketId}:`);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "rejects a gate entry whose cmd and command disagree, naming the entry and both values",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      const canonical = await readConfig(sandbox);
      await writeConfig(sandbox, {
        ...canonical,
        gate: [{ name: "check", command: "echo canonical", cmd: "echo legacy" }],
      });

      const run = await runCli(sandbox, ["run", "Ambiguous gate"]);
      expect(run.code).not.toBe(0);
      const output = run.stderr + run.stdout;
      expect(output).toContain("gate[0]");
      expect(output).toContain('"echo canonical"');
      expect(output).toContain('"echo legacy"');
    },
    SCENARIO_TIMEOUT_MS,
  );
});
