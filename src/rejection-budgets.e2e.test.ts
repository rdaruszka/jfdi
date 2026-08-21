/**
 * End-to-end acceptance for per-reviewer rejection budgets, derived from the
 * ticket — not from the diff.
 *
 * The sibling conformance suite pins the two uniform paths (all-pass merges,
 * all-code-review-fail blocks). This file pins the paths that only per-reviewer
 * budgets make legal, and that the old single `pipeline.maxRounds` counter could
 * not express:
 *
 *   - A mixed sequence where Code Review spends both its rejections *and* QA
 *     spends its one, across four rounds, and still merges — proving a pass
 *     costs nothing and the derived ceiling is 1 + 2 + 1 = 4.
 *   - A sequence where a Code Review rejection lands *after* a QA rejection
 *     (round 3), proving a code-review re-review triggered by a QA fail is free
 *     by construction: only the fail is counted.
 *   - The second QA rejection blocks, naming QA and its counts — the reviewer
 *     the old shared budget could starve.
 *   - The mechanical gate, red after three fix sessions (four attempts), blocks
 *     directly with the failing step named and consumes no round; green on a
 *     later attempt continues the same round.
 *
 * Every scenario runs in a scratch git repo under the OS temp dir with stub
 * `claude`/`codex` binaries on PATH and `HOME`/`JFDI_HOME` inside the scratch
 * tree — nothing here reaches a real agent CLI or the real `~/.jfdi`. The stub
 * is *scripted*: per-stage verdict sequences come from the environment, indexed
 * by a persistent counter kept outside the worktree so a reviewer's `git reset
 * --hard` cannot rewind it.
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

const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * The scripted agent both stubs play. It reads the verdict path its prompt
 * names, indexes a per-stage sequence from the environment (SCRIPT_CR / SCRIPT_QA)
 * by a persistent counter in STUB_STATE_DIR, and writes the verdict. Counters
 * live outside the worktree so a reviewer's hard reset cannot rewind them.
 *
 * Implementation always commits a per-session file; when IMPLEMENTATION_BREAK_UNTIL is set
 * it also writes (then, past that count, removes) a `BROKEN` sentinel a gate
 * command can trip — the only way to drive a red gate deterministically.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const stateDirectory = process.env.STUB_STATE_DIR;
function nextIndex(stage) {
  const counterPath = stateDirectory + "/" + stage + ".count";
  let seen = 0;
  try { seen = parseInt(fs.readFileSync(counterPath, "utf8"), 10) || 0; } catch (_) {}
  fs.writeFileSync(counterPath, String(seen + 1));
  return seen;
}
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = "scripted subject\\n\\nWhat the session did, in the stub's words.";
}
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    const idx = nextIndex("implementation");
    const breakUntil = parseInt(process.env.IMPLEMENTATION_BREAK_UNTIL || "0", 10);
    const brokenPath = process.cwd() + "/BROKEN";
    if (idx < breakUntil) fs.writeFileSync(brokenPath, "x\\n");
    else { try { fs.rmSync(brokenPath); } catch (_) {} }
    fs.writeFileSync(process.cwd() + "/feature" + idx + ".txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement session " + idx], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: [], observations: [], testsAdded: "unit tests" };
  } else if (stage === "code-review") {
    const seq = JSON.parse(process.env.SCRIPT_CR || "[]");
    const outcome = seq[nextIndex("code-review")] || "pass";
    verdict = outcome === "fail" ? { verdict: "fail", feedback: "code review needs work" } : { verdict: "pass" };
  } else if (stage === "qa") {
    const seq = JSON.parse(process.env.SCRIPT_QA || "[]");
    const outcome = seq[nextIndex("qa")] || "pass";
    verdict = outcome === "fail" ? { verdict: "fail", feedback: "qa needs work" } : { verdict: "pass", testsAdded: "e2e tests" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

const STUB_CODEX = `#!/usr/bin/env node
const cliName = "codex";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }) + "\\n");
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  stateDirectory: string;
  executableDirectory: string;
  stubStateDirectory: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-budgets-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  const stubStateDirectory = path.join(root, "stub-state");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  await fs.mkdir(stubStateDirectory);
  await fs.writeFile(path.join(executableDirectory, "claude"), STUB_CLAUDE, { mode: 0o755 });
  await fs.writeFile(path.join(executableDirectory, "codex"), STUB_CODEX, { mode: 0o755 });

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    projectRoot,
    home,
    jfdiHome,
    executableDirectory,
    stubStateDirectory,
    stateDirectory: path.join(jfdiHome, "projects", projectRoot.split(path.sep).join("-")),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  scriptCodeReview?: string[];
  scriptQa?: string[];
  implementationBreakUntil?: number;
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: RunOptions = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_STATE_DIR: sandbox.stubStateDirectory,
    SCRIPT_CR: JSON.stringify(options.scriptCodeReview ?? []),
    SCRIPT_QA: JSON.stringify(options.scriptQa ?? []),
    IMPLEMENTATION_BREAK_UNTIL: String(options.implementationBreakUntil ?? 0),
    NO_COLOR: "1",
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function initProject(sandbox: Sandbox): Promise<void> {
  const init = await runCli(sandbox, ["init", "--bare"]);
  expect(init.code).toBe(0);
}

/** Point the mechanical gate at a single command that fails while `BROKEN` exists. */
async function configureBreakableGate(sandbox: Sandbox): Promise<void> {
  const configPath = path.join(sandbox.projectRoot, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.gate = [{ name: "lint", command: "test ! -f BROKEN" }];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

interface RecordedEvent {
  type: string;
  ticketId?: string;
  data?: Record<string, unknown>;
}

async function readEvents(sandbox: Sandbox): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(path.join(sandbox.stateDirectory, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

function readTicketNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.projectRoot, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
}

async function readReport(sandbox: Sandbox, ticketId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(sandbox.stateDirectory, "runs", ticketId, "report.json"), "utf8"),
  ) as Record<string, unknown>;
}

function countStarts(events: RecordedEvent[], type: string, stage?: string): number {
  return events.filter(
    (event) => event.type === type && (stage === undefined || event.data?.stage === stage),
  ).length;
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("per-reviewer rejection budgets", () => {
  it(
    "merges a run that spends both Code Review rejections and QA's one across four rounds",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Round 1 CR✗, round 2 CR✗, round 3 CR✓ QA✗, round 4 CR✓ QA✓.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        scriptCodeReview: ["fail", "fail", "pass", "pass"],
        scriptQa: ["fail", "pass"],
      });
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      const events = await readEvents(sandbox);
      // Four rounds, both reviewers exhausting their budget without blocking, and
      // QA reached (its two looks) — the old shared counter starved that.
      expect(countStarts(events, "round_start")).toBe(4);
      expect(countStarts(events, "stage_end", "code-review")).toBe(4);
      expect(countStarts(events, "stage_end", "qa")).toBe(2);
      expect(events.some((event) => event.type === "blocked")).toBe(false);
      expect(events.some((event) => event.type === "merge_ready")).toBe(true);

      expect((await readReport(sandbox, ticketId)).rounds).toBe(4);

      // The card is merge-ready, and merging lands the reviewed tree on main.
      const status = JSON.parse((await runCli(sandbox, ["status", "--json"])).stdout);
      expect(status.tickets[ticketId].status).toBe("merge-ready");
      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(0);
      expect(merge.stdout).toContain("Merged into main.");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "keeps a code-review re-review after a QA fail free, merging at round four",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Round 1 CR✗, round 2 CR✓ QA✗, round 3 CR✗, round 4 CR✓ QA✓. Code Review
      // rejects in rounds 1 and 3 (two rejections, within budget), and its passes
      // in rounds 2 and 4 cost nothing — if a pass counted, this would block.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        scriptCodeReview: ["fail", "pass", "fail", "pass"],
        scriptQa: ["fail", "pass"],
      });
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      const events = await readEvents(sandbox);
      expect(countStarts(events, "round_start")).toBe(4);
      expect(events.some((event) => event.type === "blocked")).toBe(false);
      expect(events.some((event) => event.type === "merge_ready")).toBe(true);
      expect((await readReport(sandbox, ticketId)).rounds).toBe(4);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "blocks on the second QA rejection, naming QA and its counts",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Code Review passes both looks (free); QA fails twice — the second is one
      // past its budget of one, so the run blocks on QA, not Code Review.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        scriptCodeReview: ["pass", "pass"],
        scriptQa: ["fail", "fail"],
      });
      // Blocked is exit 2 — distinct from a plain failure (1).
      expect(run.code).toBe(2);
      const ticketId = ticketIdOf(run);

      const events = await readEvents(sandbox);
      // Two rounds only, both reviewers ran each round (the re-review was free),
      // and the run stopped at the second QA rejection.
      expect(countStarts(events, "round_start")).toBe(2);
      expect(countStarts(events, "stage_end", "code-review")).toBe(2);
      expect(countStarts(events, "stage_end", "qa")).toBe(2);

      const blocked = events.find((event) => event.type === "blocked");
      expect(blocked?.data?.reason).toBe("QA rejected 2 times (budget 1)");

      const note = await readTicketNote(sandbox, ticketId);
      expect(note).toContain("QA rejected 2 times (budget 1)");
      // The reviewer named is QA, not Code Review — the shared-budget starvation
      // this ticket removes would have blocked on Code Review's rounds instead.
      expect(note).not.toContain("Code Review rejected");

      // Nothing reached the target branch.
      expect(await git(sandbox.projectRoot, "log", "--oneline", "main")).not.toContain("implement");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "blocks directly when the gate is still red after three fix sessions, consuming no round",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      await configureBreakableGate(sandbox);

      // Every implementation session leaves BROKEN in the tree, so all four gate
      // attempts (1 + 3 fix sessions) fail at `lint`.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        implementationBreakUntil: 99,
      });
      expect(run.code).toBe(2);
      const ticketId = ticketIdOf(run);

      const events = await readEvents(sandbox);
      // Gate exhaustion consumes no round: exactly one round started, and the
      // reviewers were never reached.
      expect(countStarts(events, "round_start")).toBe(1);
      expect(countStarts(events, "stage_start", "implementation")).toBe(4);
      expect(countStarts(events, "stage_start", "code-review")).toBe(0);
      expect(countStarts(events, "stage_start", "qa")).toBe(0);

      const blocked = events.find((event) => event.type === "blocked");
      expect(blocked?.data?.reason).toBe("Mechanical gate failed at `lint` after 4 attempts");

      const note = await readTicketNote(sandbox, ticketId);
      expect(note).toContain("after 4 attempts");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "continues the round when a red gate goes green on a later attempt",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      await configureBreakableGate(sandbox);

      // The first two implementation sessions break the gate; the third (the
      // third of the four allowed attempts) leaves the tree clean, so the round
      // continues to the reviewers and the run passes in a single round.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        implementationBreakUntil: 2,
        scriptCodeReview: ["pass"],
        scriptQa: ["pass"],
      });
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      const events = await readEvents(sandbox);
      expect(countStarts(events, "round_start")).toBe(1);
      expect(countStarts(events, "stage_start", "implementation")).toBe(3);
      expect(countStarts(events, "stage_end", "code-review")).toBe(1);
      expect(countStarts(events, "stage_end", "qa")).toBe(1);
      expect(events.some((event) => event.type === "merge_ready")).toBe(true);
      // A green gate never consumed a round: the pass is round one.
      expect((await readReport(sandbox, ticketId)).rounds).toBe(1);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
