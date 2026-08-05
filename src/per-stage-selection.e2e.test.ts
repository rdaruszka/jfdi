/**
 * Per-stage harness selection, pinned from outside the process.
 *
 * The unit suites prove each harness builds the right argv and that the fake
 * harnesses are handed the right stages. These tests prove the whole chain a
 * user actually meets: config.json → `dist/index.js` → the argv a provider CLI
 * on `PATH` really received, across rounds, continuations, integration, and a
 * provider that isn't installed at all.
 *
 * Isolation is stricter here than elsewhere in the suite: the sandbox `PATH`
 * has every directory holding a real `claude` or `codex` removed, so a stage
 * whose stub is missing cannot silently reach the human's own CLI (and its
 * provider's API) instead of failing.
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
/** `jfdi run` exits 2 when the ticket ends blocked. */
const EXIT_BLOCKED = 2;

/** Shared stub body: record the argv, then answer the stage the prompt names. */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({ cli: cliName, argv }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "branch version\\n");
    verdict = { status: "done", summary: "wrote the feature" };
  } else if (stage === "code-review") {
    // Fail the first review only, so a later round exercises continuation.
    const seen = Number(fs.existsSync(process.env.STUB_REVIEW_COUNT)
      ? fs.readFileSync(process.env.STUB_REVIEW_COUNT, "utf8") : "0") + 1;
    fs.writeFileSync(process.env.STUB_REVIEW_COUNT, String(seen));
    verdict = seen === 1 && process.env.STUB_REVIEW_FAILS_ONCE
      ? { verdict: "fail", feedback: "name it better" }
      : { verdict: "pass" };
  } else if (stage === "qa") {
    verdict = { verdict: "pass", testsAdded: "one" };
  } else {
    // Integration: resolve the conflict the way the real agent would, then
    // hand the merge back to the coordinator.
    fs.writeFileSync(process.cwd() + "/feature.txt", "reconciled\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "--no-edit"], { cwd: process.cwd() });
    verdict = { resolution: "clean", notes: "kept both" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

/** Claude Code's protocol: prompt after `-p`, a session id, a result line. */
const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "claude-session" }) + "\\n");
`;

/** Codex's protocol: prompt last, a thread id, success inferred from a message. */
const STUB_CODEX = `#!/usr/bin/env node
const cliName = "codex";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n");
`;

/**
 * `PATH` with every directory holding a real agent CLI removed. Prepending a
 * stub dir is not enough on its own: the missing-binary case deletes a stub,
 * and whatever the human has installed would answer in its place.
 */
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
  stateDir: string;
  argvLog: string;
  environment: NodeJS.ProcessEnv;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: git and the agent CLIs both walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-per-stage-"));
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
  // `env node` must still resolve after the sanitizing above dropped whichever
  // directory node shares with an agent CLI.
  await fs.symlink(process.execPath, path.join(binDir, "node"));

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  const argvLog = path.join(root, "argv.jsonl");
  return {
    root,
    project,
    binDir,
    argvLog,
    stateDir: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
    environment: {
      ...process.env,
      PATH: agentFreePath(binDir),
      HOME: home,
      JFDI_HOME: jfdiHome,
      STUB_ARGV_LOG: argvLog,
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

async function scaffold(sandbox: Sandbox, stages: unknown): Promise<void> {
  // `--bare` scaffolds prompts and config without launching an agent.
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  await writeStages(sandbox, stages);
}

async function writeStages(sandbox: Sandbox, stages: unknown): Promise<void> {
  const configPath = path.join(sandbox.project, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  await fs.writeFile(configPath, JSON.stringify({ ...config, stages }, null, 2));
}

/** Colour codes, built from the escape byte so no control character is inlined. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function plainLines(stdout: string): string[] {
  return stdout
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => line !== "");
}

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

interface Invocation {
  cli: string;
  stage: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  isContinuation: boolean;
}

/** What each stub was actually handed, in the order the stages ran. */
async function invocations(sandbox: Sandbox): Promise<Invocation[]> {
  const raw = await fs.readFile(sandbox.argvLog, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { cli: string; argv: string[] })
    .map(({ cli, argv }) => {
      const valueAfter = (flag: string) => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
      };
      // Each provider's own spelling only: Claude takes `--effort`, Codex takes
      // it as a `-c` override. Reading either spelling from either CLI would
      // let a swapped mapping pass.
      const codexEffort = () => {
        const effortOverride = argv.find(
          (argument, index) =>
            argv[index - 1] === "-c" && argument.startsWith("model_reasoning_effort="),
        );
        return effortOverride?.replace("model_reasoning_effort=", "");
      };
      return {
        cli,
        // The scribe writes no verdict, so it is named by its own prompt.
        stage: argv.join(" ").includes("Write the commit message")
          ? "commit-message"
          : /(\w[\w-]*)\.verdict\.json/.exec(argv.join(" "))?.[1],
        model: valueAfter("--model"),
        effort: cli === "claude" ? valueAfter("--effort") : codexEffort(),
        isContinuation: argv.includes("--resume") || argv[1] === "resume",
      };
    });
}

async function stageStarts(sandbox: Sandbox): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
    .filter((event) => event.type === "stage_start")
    .map((event) => event.data ?? {});
}

/**
 * A mix in which no two stages share a selection, and QA names only a harness —
 * so a session that reached the wrong CLI, or borrowed a neighbour's model,
 * fails rather than passing for the wrong reason.
 */
const MIXED_STAGES = {
  implementation: { harness: "claude", model: "impl-model", effort: "max" },
  "code-review": { harness: "codex", model: "review-model", effort: "minimal" },
  qa: { harness: "claude" },
  integration: { harness: "codex", effort: "xhigh" },
  "commit-message": { harness: "codex", model: "scribe-model" },
};

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("per-stage selection, end to end", () => {
  it(
    "hands each stage — and its continuation — to that stage's own CLI and flags",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox, MIXED_STAGES);

      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        STUB_REVIEW_FAILS_ONCE: "1",
      });
      expect(run.code).toBe(0);

      // Round 1 fresh, round 2 continuing — each in its own stage's CLI, with
      // that stage's flags carried into the continuation too.
      expect(await invocations(sandbox)).toEqual([
        {
          cli: "claude",
          stage: "implementation",
          model: "impl-model",
          effort: "max",
          isContinuation: false,
        },
        // The scribe, on its own entry's CLI and model: the pipeline commits
        // what the session left, and asks this session for the message.
        {
          cli: "codex",
          stage: "commit-message",
          model: "scribe-model",
          effort: undefined,
          isContinuation: false,
        },
        {
          cli: "codex",
          stage: "code-review",
          model: "review-model",
          effort: "minimal",
          isContinuation: false,
        },
        {
          cli: "claude",
          stage: "implementation",
          model: "impl-model",
          effort: "max",
          isContinuation: true,
        },
        {
          cli: "codex",
          stage: "code-review",
          model: "review-model",
          effort: "minimal",
          isContinuation: true,
        },
        // A harness-only entry passes no flag at all: not the model of the
        // stage either side of it, and not the scaffolded default's.
        {
          cli: "claude",
          stage: "qa",
          model: undefined,
          effort: undefined,
          isContinuation: false,
        },
      ]);

      // The record answers "which model produced this" per stage, absent
      // fields included.
      const starts = await stageStarts(sandbox);
      expect(starts.filter((data) => data.stage === "code-review")).toEqual([
        { stage: "code-review", harness: "codex", model: "review-model", effort: "minimal" },
        {
          stage: "code-review",
          harness: "codex",
          model: "review-model",
          effort: "minimal",
          isContinuation: true,
        },
      ]);
      const qaStart = starts.find((data) => data.stage === "qa");
      expect(qaStart).toEqual({ stage: "qa", harness: "claude" });

      // The inline renderer shows it too, naming only what was configured.
      const activity = plainLines(run.stdout).filter((line) => line.includes(" started "));
      expect(activity).toEqual([
        "implementation started (claude impl-model max)",
        "code-review started (codex review-model minimal)",
        "implementation started (claude impl-model max)",
        "code-review started (codex review-model minimal)",
        "qa started (claude)",
      ]);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "resolves a conflicted merge through the integration stage's own CLI",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox, MIXED_STAGES);
      const run = await runCli(sandbox, ["run", "Add a feature file"]);
      expect(run.code).toBe(0);

      // Collide on the target branch, so integration cannot fast-forward.
      await fs.writeFile(path.join(sandbox.project, "feature.txt"), "main version\n");
      await git(sandbox.project, "add", "-A");
      await git(sandbox.project, "commit", "-m", "collide");

      await fs.rm(sandbox.argvLog);
      const merge = await runCli(sandbox, ["merge", ticketIdOf(run)]);
      expect(merge.code).toBe(0);

      // Integration's entry names a harness and an effort but no model — and
      // Codex, not the Claude the other stages used.
      expect(await invocations(sandbox)).toEqual([
        {
          cli: "codex",
          stage: "integration",
          model: undefined,
          effort: "xhigh",
          isContinuation: false,
        },
      ]);
      expect((await stageStarts(sandbox)).at(-1)).toEqual({
        stage: "integration",
        harness: "codex",
        effort: "xhigh",
      });
      expect(await fs.readFile(path.join(sandbox.project, "feature.txt"), "utf8")).toBe(
        "reconciled\n",
      );
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "names the missing binary and the stages entry that chose it",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox, MIXED_STAGES);
      // The cross-provider default's consequence, made concrete: only one
      // provider's CLI is installed.
      await fs.rm(path.join(sandbox.binDir, "codex"));

      const run = await runCli(sandbox, ["run", "Review with no reviewer"]);
      expect(run.code).toBe(EXIT_BLOCKED);
      // Not a bare exit: the run says where the account of it is.
      expect(run.stderr).toContain("See the ticket note");

      const note = await fs.readFile(
        path.join(sandbox.project, ".jfdi", "tickets", `${ticketIdOf(run)}.md`),
        "utf8",
      );
      expect(note).toContain('failed to spawn "codex" for the code-review session');
      expect(note).toContain("install the codex CLI and put it on PATH");
      expect(note).toContain("stages.code-review.harness");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "rejects a bad stages section at load, per harness",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox, MIXED_STAGES);

      const rejected: Array<[string, unknown, string]> = [
        [
          "an unknown stage key",
          { ...MIXED_STAGES, review: { harness: "claude" } },
          'stages has an unknown entry "review"',
        ],
        [
          "a stage entry with no harness",
          { ...MIXED_STAGES, qa: { model: "claude-opus-4-8" } },
          "stages.qa.harness must be a non-empty string",
        ],
        [
          "a harness that does not exist",
          { ...MIXED_STAGES, qa: { harness: "gpt" } },
          'stages.qa.harness must be "claude" or "codex"',
        ],
        [
          // The effort tables belong to the implementations, not to config: a
          // level Codex accepts is still a startup error under Claude.
          "an effort only the other provider accepts",
          { ...MIXED_STAGES, qa: { harness: "claude", effort: "none" } },
          'stages.qa.effort is "none", which the claude harness does not accept; use one of: low, medium, high, xhigh, max',
        ],
        [
          "an effort neither provider accepts",
          { ...MIXED_STAGES, qa: { harness: "codex", effort: "hgih" } },
          "which the codex harness does not accept; use one of: none, minimal, low, medium, high, xhigh, max",
        ],
        [
          "a model that is not a string",
          { ...MIXED_STAGES, qa: { harness: "claude", model: 5 } },
          "stages.qa.model must be a non-empty string",
        ],
      ];
      for (const [what, stages, expected] of rejected) {
        await writeStages(sandbox, stages);
        const status = await runCli(sandbox, ["status"]);
        expect(status.code, what).toBe(1);
        expect(status.stderr, what).toContain(expected);
        // A config error is a message, never a stack trace.
        expect(status.stderr, what).not.toContain("    at ");
      }

      // …and the same effort level is fine on the harness that does accept it.
      await writeStages(sandbox, { ...MIXED_STAGES, qa: { harness: "codex", effort: "none" } });
      expect((await runCli(sandbox, ["status"])).code).toBe(0);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
