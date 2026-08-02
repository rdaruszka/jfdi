/**
 * Acceptance for the coding-standards conformance sweep.
 *
 * The sweep's defining constraint is *zero behavior change*: it renames,
 * restructures and adds trust-boundary assertions, but the product must do
 * exactly what it did before. Unit tests cover the pieces; nothing pinned the
 * observable contract of the built CLI, so a future sweep could rename its way
 * into a different event vocabulary, exit code or on-disk format and the suite
 * would stay green.
 *
 * These tests pin that contract from the outside: they drive `dist/index.js` in
 * a scratch repo under the OS temp dir with a stub `claude` on PATH, and assert
 * on what a user or a wrapper script can see — exit codes, the event stream,
 * state.json, the scaffolded files, and the board/ticket-note mutations.
 *
 * They also pin the three places where the sweep's assertions *deliberately*
 * changed behavior on malformed input, so the hardening cannot be silently
 * reverted or silently widened.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
 */
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
const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * A `claude` that never talks to the network. It replays stream-json lines and
 * writes the verdict file its prompt names; `STUB_MODE` selects which verdicts
 * so one stub drives the pass, review-fail and blocked paths.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const mode = process.env.STUB_MODE || "pass";
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  const roundMatch = /round-(\\d+)/.exec(verdictPath);
  const roundNumber = roundMatch ? Number(roundMatch[1]) : 1;
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature" + roundNumber + ".txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement round " + roundNumber], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: ["chose A"], observations: ["stray TODO in foo.ts"], testsAdded: "unit tests" };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else if (stage === "code-review" && mode === "review-fail") {
    verdict = { verdict: "fail", feedback: "needs work" };
  } else {
    verdict = { verdict: "pass", observations: ["nit: long function"], testsAdded: "e2e tests" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-conformance-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "claude"), STUB_CLAUDE, { mode: 0o755 });

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
    binDir,
    stateDir: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
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
  options: { stubMode?: string } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_MODE: options.stubMode ?? "pass",
    NO_COLOR: "1",
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env,
      maxBuffer: 64 * 1024 * 1024,
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

interface RecordedEvent {
  type: string;
  ticketId?: string;
  data?: Record<string, unknown>;
}

async function readEvents(sandbox: Sandbox): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/** The event vocabulary a renderer sees, minus the chatty session narration. */
function eventShapes(events: RecordedEvent[]): string[] {
  return events
    .filter((event) => event.type !== "session_activity")
    .map((event) => {
      const stage = typeof event.data?.stage === "string" ? `:${event.data.stage}` : "";
      const verdict = typeof event.data?.verdict === "string" ? `→${event.data.verdict}` : "";
      return `${event.type}${stage}${verdict}`;
    });
}

async function initProject(sandbox: Sandbox): Promise<void> {
  const init = await runCli(sandbox, ["init", "--bare"]);
  expect(init.code).toBe(0);
}

/** Overwrite events.jsonl and read back the snapshot the CLI derives from it. */
async function replayEvents(sandbox: Sandbox, lines: string[]): Promise<Record<string, unknown>> {
  await fs.mkdir(sandbox.stateDir, { recursive: true });
  await fs.writeFile(path.join(sandbox.stateDir, "events.jsonl"), `${lines.join("\n")}\n`);
  await fs.rm(path.join(sandbox.stateDir, "state.json"), { force: true });
  const status = await runCli(sandbox, ["status", "--json"]);
  expect(status.code).toBe(0);
  return JSON.parse(status.stdout) as Record<string, unknown>;
}

const FIXED_TS = "2020-01-01T00:00:00.000Z";

function eventLine(type: string, ticketId: string | null, data?: unknown): string {
  return JSON.stringify({
    type,
    ...(ticketId ? { ticketId } : {}),
    ts: FIXED_TS,
    ...(data === undefined ? {} : { data }),
  });
}

beforeAll(async () => {
  // Always rebuild: a stale dist/ would let these pass against old behavior.
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot });
}, BUILD_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("CLI surface", () => {
  it(
    "keeps the usage text and the exit code for every argument error",
    async () => {
      const sandbox = await makeSandbox();

      for (const args of [[], ["--help"], ["-h"], ["help"]]) {
        const result = await runCli(sandbox, args);
        expect(result.code, `args: ${JSON.stringify(args)}`).toBe(0);
        expect(result.stdout).toContain("jfdi — Just F'ing Do It");
        expect(result.stdout).toContain("jfdi run <ticket>");
      }

      // Every usage error is exit 1 and prints to stderr, never stdout.
      const usageErrors: Array<[string[], string]> = [
        [["bogus-command"], 'unknown command "bogus-command"'],
        [["run"], "jfdi run <ticket>"],
        [["run", "   "], "jfdi run <ticket>"],
        [["logs"], "jfdi logs <ticket-id>"],
        [["merge"], "jfdi merge <ticket-id>"],
      ];
      for (const [args, expected] of usageErrors) {
        const result = await runCli(sandbox, args);
        expect(result.code, `args: ${JSON.stringify(args)}`).toBe(1);
        expect(result.stderr).toContain(expected);
      }

      // A ticket with no branch is a plain failure, not a crash.
      const merge = await runCli(sandbox, ["merge", "no-such-ticket"]);
      expect(merge.code).toBe(1);
      expect(merge.stderr).toContain("nothing to merge");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "scaffolds exactly the same .jfdi/ layout, and does it idempotently",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const jfdiDir = path.join(sandbox.project, ".jfdi");
      const entries = await fs.readdir(jfdiDir);
      expect(entries.sort()).toEqual([
        ".gitignore",
        "board.md",
        "config.json",
        "prompts",
        "sandbox.md",
        "tickets",
      ]);
      expect((await fs.readdir(path.join(jfdiDir, "prompts"))).sort()).toEqual([
        "code-review.md",
        "convo.md",
        "implementation.md",
        "init.md",
        "integration.md",
        "qa.md",
      ]);

      // The board skeleton is the Obsidian-Kanban format the coordinator parses.
      const board = await fs.readFile(path.join(jfdiDir, "board.md"), "utf8");
      expect(board).toContain("kanban-plugin: board");
      for (const column of ["Ready", "In Progress", "Done", "Blocked", "Ready to Merge", "Inbox"]) {
        expect(board, `column: ${column}`).toContain(`## ${column}`);
      }

      // Config keys are the contract config.ts validates against.
      const config = JSON.parse(await fs.readFile(path.join(jfdiDir, "config.json"), "utf8"));
      expect(Object.keys(config).sort()).toEqual(
        [
          "board",
          "gate",
          "harness",
          "harnessArgs",
          "integration",
          "max_concurrent",
          "pipeline",
          "ticketsDir",
        ].sort(),
      );
      expect(config.integration.target_branch).toBe("main");
      expect(config.pipeline.max_rounds).toBe(3);

      // Re-running init must not rewrite or duplicate anything.
      const before = await fs.readFile(path.join(jfdiDir, "config.json"), "utf8");
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      expect(await fs.readFile(path.join(jfdiDir, "config.json"), "utf8")).toBe(before);
      expect((await fs.readdir(jfdiDir)).sort()).toEqual(entries.sort());
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("pipeline behavior", () => {
  it(
    "emits the full event vocabulary and merges on the happy path",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      // The exact stage order the spec fixes: implementation → gate → review → QA,
      // with Code Review gating QA and both sign-offs inside one round.
      expect(eventShapes(await readEvents(sandbox))).toEqual([
        "dispatch",
        "round_start",
        "stage_start:implementation",
        "stage_end:implementation→done",
        "gate_start",
        "gate_result",
        "stage_start:code-review",
        "stage_end:code-review→pass",
        "stage_start:qa",
        "stage_end:qa→pass",
        "observation",
        "observation",
        "merge_ready",
      ]);

      // Stage observations become inbox proposal cards — never fixed inline.
      const board = await fs.readFile(path.join(sandbox.project, ".jfdi", "board.md"), "utf8");
      expect(board).toContain(`stray TODO in foo.ts *(from ${ticketId})*`);
      expect(board).toContain(`nit: long function *(from ${ticketId})*`);

      // The saved report keeps the shape merge reads back.
      const report = JSON.parse(
        await fs.readFile(path.join(sandbox.stateDir, "runs", ticketId, "report.json"), "utf8"),
      );
      expect(report.summary).toBe("implemented");
      expect(report.rounds).toBe(1);
      expect(report.decisions).toEqual(["chose A"]);
      expect(report.commit).toMatch(/^[0-9a-f]{40}$/);

      const status = JSON.parse((await runCli(sandbox, ["status", "--json"])).stdout);
      expect(status.tickets[ticketId].status).toBe("merge-ready");

      // Approval merges into the configured target branch and cleans the branch up.
      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(0);
      expect(merge.stdout).toContain("Merged into main.");
      expect(await git(sandbox.project, "log", "--oneline", "main")).toContain("implement round 1");
      expect(await git(sandbox.project, "branch", "--list", `jfdi/${ticketId}`)).toBe("");

      // A second approval is a clean failure, not a double merge.
      const again = await runCli(sandbox, ["merge", ticketId]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("nothing to merge");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "exhausts max_rounds on a persistent review failure and exits blocked",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "review-fail" });
      // Blocked is exit 2 — distinct from a failure (1) so a wrapper can tell them apart.
      expect(run.code).toBe(2);

      const events = await readEvents(sandbox);
      const shapes = eventShapes(events);
      // Three rounds, each re-entering at the gate, and QA never runs: Code
      // Review gates it.
      expect(shapes.filter((shape) => shape === "round_start")).toHaveLength(3);
      expect(shapes.filter((shape) => shape === "gate_start")).toHaveLength(3);
      expect(shapes.filter((shape) => shape.startsWith("stage_start:qa"))).toHaveLength(0);
      expect(shapes.at(-1)).toBe("blocked");

      const blocked = events.find((event) => event.type === "blocked");
      expect(blocked?.data?.reason).toBe("retries exhausted after 3 rounds");

      // Nothing reached the target branch.
      expect(await git(sandbox.project, "log", "--oneline", "main")).not.toContain("implement");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "writes through a symlinked board and tickets dir without replacing the links",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Reproduce the vault setup: board and tickets are symlinks out of the repo.
      const jfdiDir = path.join(sandbox.project, ".jfdi");
      const vault = path.join(sandbox.root, "vault");
      await fs.mkdir(path.join(vault, "tickets"), { recursive: true });
      const boardLink = path.join(jfdiDir, "board.md");
      const realBoard = path.join(vault, "board.md");
      await fs.rename(boardLink, realBoard);
      await fs.symlink(realBoard, boardLink);
      const ticketsLink = path.join(jfdiDir, "tickets");
      await fs.rm(ticketsLink, { recursive: true, force: true });
      await fs.symlink(path.join(vault, "tickets"), ticketsLink);

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      // Renaming onto the link would have replaced it with a private copy and
      // split the board from the file the human edits.
      expect((await fs.lstat(boardLink)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(boardLink)).toBe(realBoard);
      expect((await fs.lstat(ticketsLink)).isSymbolicLink()).toBe(true);

      // The writes landed on the link's target, not beside the link.
      expect(await fs.readFile(realBoard, "utf8")).toContain(
        `stray TODO in foo.ts *(from ${ticketId})*`,
      );
      expect(await fs.readdir(path.join(vault, "tickets"))).toContain(`${ticketId}.md`);

      // The temp file the atomic write renames from is never left behind.
      for (const dir of [vault, jfdiDir]) {
        expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
      }
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("trust boundaries", () => {
  it(
    "rejects a malformed config with a diagnostic instead of a stack trace",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const configPath = path.join(sandbox.project, ".jfdi", "config.json");
      const goodConfig = await fs.readFile(configPath, "utf8");

      const rejected: Array<[string, string]> = [
        ["{{{", "invalid JSON"],
        ["", "invalid JSON"],
        ["null", "config root must be an object"],
        ["[]", "config root must be an object"],
        ['"hello"', "config root must be an object"],
        [
          JSON.stringify({ pipeline: { max_rounds: "three" } }),
          "max_rounds must be a positive integer",
        ],
        [JSON.stringify({ pipeline: { max_rounds: -1 } }), "max_rounds must be a positive integer"],
      ];
      for (const [body, expected] of rejected) {
        await fs.writeFile(configPath, body);
        const status = await runCli(sandbox, ["status"]);
        expect(status.code, `config: ${body}`).toBe(1);
        expect(status.stderr, `config: ${body}`).toContain(expected);
        // A diagnostic, not a leaked stack trace.
        expect(status.stderr).not.toContain("    at ");
      }

      // An empty object is still valid — every key has a default.
      await fs.writeFile(configPath, "{}");
      expect((await runCli(sandbox, ["status"])).code).toBe(0);
      await fs.writeFile(configPath, goodConfig);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "replays a hostile event stream without leaking untyped values into the snapshot",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Wrong-typed data fields must not reach state.json: a renderer reads it as
      // CoordinatorState and would otherwise see a number where a string is typed.
      const snapshot = await replayEvents(sandbox, [
        eventLine("dispatch", "t1", { title: 42, branch: null }),
        eventLine("round_start", "t1", { round: "3" }),
        eventLine("stage_start", "t1", { stage: "bogus-stage" }),
      ]);
      const tickets = snapshot.tickets as Record<string, Record<string, unknown>>;
      expect(typeof tickets.t1.title).toBe("string");
      expect(typeof tickets.t1.round).toBe("number");
      expect(typeof tickets.t1.branch).toBe("string");
      // "bogus-stage" is not a stage name, so the stage is left unset.
      expect(tickets.t1.stage).toBeNull();

      // Prototype keys are not stage names either — a plain `in`/cast check would
      // have accepted them and overwritten a legitimate stage.
      const prototypeSnapshot = await replayEvents(sandbox, [
        eventLine("dispatch", "t5", { title: "T5", branch: "jfdi/t5" }),
        eventLine("stage_start", "t5", { stage: "qa" }),
        eventLine("stage_start", "t5", { stage: "constructor" }),
        eventLine("stage_start", "t5", { stage: "toString" }),
      ]);
      expect((prototypeSnapshot.tickets as Record<string, Record<string, unknown>>).t5.stage).toBe(
        "qa",
      );

      // Absent data, unknown event types, array payloads and a missing ticketId
      // are all survivable: status renders whatever the stream holds.
      for (const lines of [
        [
          eventLine("dispatch", "t9"),
          eventLine("round_start", "t9"),
          eventLine("stage_start", "t9"),
        ],
        [
          eventLine("dispatch", "t9", { title: "T9" }),
          eventLine("totally_made_up", "t9", { x: 1 }),
        ],
        [eventLine("dispatch", "t9", [1, 2, 3])],
        [eventLine("merge_queued", null)],
      ]) {
        const result = await replayEvents(sandbox, lines);
        expect(result.tickets, `lines: ${lines[0]}`).toBeDefined();
      }

      // A line that is JSON but not an event is refused by name, loudly — the
      // snapshot is never rebuilt from a stream we cannot vouch for.
      await fs.writeFile(
        path.join(sandbox.stateDir, "events.jsonl"),
        `${JSON.stringify({ nothing: "like an event" })}\n`,
      );
      await fs.rm(path.join(sandbox.stateDir, "state.json"), { force: true });
      const refused = await runCli(sandbox, ["status", "--json"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("is not a JFDI event");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "treats a shape-invalid report.json as absent rather than merging off it",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      const reportPath = path.join(sandbox.stateDir, "runs", ticketId, "report.json");
      const realCommit = JSON.parse(await fs.readFile(reportPath, "utf8")).commit;
      // Parses as JSON, but `decisions`/`observations` are missing — the shape a
      // hand edit or an older JFDI leaves behind.
      await fs.writeFile(reportPath, JSON.stringify({ summary: "s", commit: realCommit }));

      // The merge itself still completes: a bad report must not strand a branch
      // half-merged the way an unchecked dereference did.
      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(0);
      expect(merge.stdout).toContain("Merged into main.");
      expect(await git(sandbox.project, "log", "--oneline", "main")).toContain("implement round 1");
      expect(await git(sandbox.project, "branch", "--list", `jfdi/${ticketId}`)).toBe("");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
