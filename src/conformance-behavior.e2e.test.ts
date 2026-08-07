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
 * a scratch repo under the OS temp dir with stub `claude` and `codex` binaries
 * on PATH — both, because the scaffolded config reviews on a different provider
 * than it implements on — and assert on what a user or a wrapper script can
 * see: exit codes, the event stream, state.json, the scaffolded files, the
 * argv each stage's CLI was handed, and the board/ticket-note mutations.
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
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * The agent both stubs play: read the prompt, write the verdict file it names,
 * and record the argv, so a test can prove which CLI ran a stage and with which
 * flags. `STUB_MODE` selects which verdicts, so one body drives the pass,
 * review-fail and blocked paths. Neither stub ever talks to the network.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const mode = process.env.STUB_MODE || "pass";
if (process.env.STUB_ARGV_LOG) {
  fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({ cli: cliName, argv }) + "\\n");
}
// The scribe answers in its result text, not in a verdict file.
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = "stub-scribed subject\\n\\nWhat the session did, in the stub's words.";
}
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  // The verdict path lives in the worktree and no longer encodes the round;
  // number this session by what earlier sessions left in the tree instead.
  let roundNumber = 1;
  while (fs.existsSync(process.cwd() + "/feature" + roundNumber + ".txt")) roundNumber += 1;
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature" + roundNumber + ".txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement round " + roundNumber], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: ["chose A"], observations: ["stray TODO in foo.ts"], testsAdded: "unit tests" };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else if (stage === "code-review" && mode === "review-fail-observed") {
    verdict = { verdict: "fail", feedback: "needs work", observations: ["reviewer-flagged: unchecked auth on the legacy endpoint"] };
  } else if (stage === "code-review" && mode === "review-fail") {
    verdict = { verdict: "fail", feedback: "needs work" };
  } else {
    verdict = { verdict: "pass", observations: ["nit: long function"], testsAdded: "e2e tests" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

/** The stub speaking Claude Code's stream-json protocol: prompt after `-p`. */
const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

/**
 * The stub speaking Codex's protocol: prompt is the last positional argument,
 * the thread id must be announced (its absence is classified as an outage), and
 * success is inferred from a final agent message plus a clean exit.
 */
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
  project: string;
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
  /** Every stub invocation's CLI name and argv, one JSON line each. */
  argvLog: string;
}

/** The scaffolded mix, so a case can vary one entry without restating four. */
const STAGES = defaultConfig().stages;

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
  await fs.writeFile(path.join(binDir, "codex"), STUB_CODEX, { mode: 0o755 });

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
    argvLog: path.join(root, "argv.jsonl"),
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
    STUB_ARGV_LOG: sandbox.argvLog,
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

/** The ticket note as it stands on disk, from outside the process. */
function readTicketNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.project, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
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
        "claude-settings.json",
        "config.json",
        "hooks",
        "prompts",
        "sandbox.md",
        "tickets",
      ]);
      expect((await fs.readdir(path.join(jfdiDir, "prompts"))).sort()).toEqual([
        "code-review-continue.md",
        "code-review.md",
        "commit-message.md",
        "implementation-continue.md",
        "implementation.md",
        "init.md",
        "integration.md",
        "qa-continue.md",
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
          "integration",
          "max_concurrent",
          "permissions",
          "pipeline",
          "stages",
          "ticketsDir",
        ].sort(),
      );
      expect(config.integration.target_branch).toBe("main");
      expect(config.permissions).toEqual({ mode: "auto" });
      expect(config.pipeline.max_rounds).toBe(3);
      // The scaffolded mix: a cross-provider review, everything else on Claude.
      expect(config.stages).toEqual({
        implementation: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
        "code-review": { harness: "codex", model: "gpt-5.6-sol", effort: "high" },
        qa: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
        integration: { harness: "claude", model: "claude-opus-4-8", effort: "medium" },
        "commit-message": { harness: "claude", model: "claude-sonnet-5" },
      });

      // Re-running init must not rewrite or duplicate anything.
      const before = await fs.readFile(path.join(jfdiDir, "config.json"), "utf8");
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
      expect(await fs.readFile(path.join(jfdiDir, "config.json"), "utf8")).toBe(before);
      expect((await fs.readdir(jfdiDir)).sort()).toEqual(entries.sort());
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "spawns each stage of a freshly scaffolded project with that stage's flags",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      expect((await runCli(sandbox, ["run", "Add a greeting"])).code).toBe(0);

      // What each stage's CLI was actually handed, in the order they ran.
      const invocations = (await fs.readFile(sandbox.argvLog, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { cli: string; argv: string[] })
        .map(({ cli, argv }) => {
          const valueAfter = (flag: string) => {
            const at = argv.indexOf(flag);
            return at === -1 ? undefined : argv[at + 1];
          };
          return {
            cli,
            // The scribe writes no verdict, so it is named by its own prompt.
            stage: argv.join(" ").includes("Write the commit message")
              ? "commit-message"
              : /(\w[\w-]*)\.verdict\.json/.exec(argv.join(" "))?.[1],
            model: valueAfter("--model"),
            // Claude spells effort as a flag; Codex as a `-c` config override.
            effort:
              valueAfter("--effort") ??
              argv.find((arg) => arg.startsWith("model_reasoning_effort="))?.split("=")[1],
          };
        });

      // The scaffolded mix, spelled each provider's own way: Claude takes
      // --effort, Codex takes it as a -c config override.
      expect(invocations).toEqual([
        { cli: "claude", stage: "implementation", model: "claude-opus-4-8", effort: "high" },
        // The scribe runs on its own entry — a cheap model, no effort flag.
        { cli: "claude", stage: "commit-message", model: "claude-sonnet-5", effort: undefined },
        { cli: "codex", stage: "code-review", model: "gpt-5.6-sol", effort: "high" },
        { cli: "claude", stage: "qa", model: "claude-opus-4-8", effort: "high" },
      ]);
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
      // The branch carries the pipeline's own commit, written by the scribe —
      // and not the one the agent made for itself despite the prompt.
      const landed = await git(sandbox.project, "log", "--oneline", "main");
      expect(landed).toContain("stub-scribed subject");
      expect(landed).not.toContain("implement round 1");
      expect(await git(sandbox.project, "branch", "--list", `jfdi/${ticketId}`)).toBe("");

      // The other surface tells the same story on its own: every transition of
      // the run, ending at the merge, in the note's Comments trail.
      const trail = (await readTicketNote(sandbox, ticketId)).split("### ").slice(1);
      const headings = trail.map((entry) => entry.split("\n")[0] ?? "");
      expect(headings.map((heading) => heading.replace(/^\S+ — /, ""))).toEqual([
        "JFDI started",
        "Implementation round 1 complete",
        "Code Review round 1 complete",
        "QA round 1 complete",
        "Integration complete",
      ]);
      const note = await readTicketNote(sandbox, ticketId);
      expect(note).toContain("> Run started — 3 rounds max.");
      // The commit's message, verbatim, on the note as well.
      expect(note).toContain(`> ${ticketId}: stub-scribed subject`);
      expect(note).toContain("> JFDI Implementation complete — gate green");
      expect(note).toContain("> JFDI-Round: 1/3");
      expect(note).toMatch(
        /> JFDI Code Review PASSED — sign-off on commit `[0-9a-f]{7}`, moving to QA/,
      );
      expect(note).toMatch(/> JFDI Integration merged — landed on `main` as `[0-9a-f]{7}`/);

      // A second approval is a clean failure, not a double merge.
      const again = await runCli(sandbox, ["merge", ticketId]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("nothing to merge");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "asks agents to write verdicts inside the worktree, then collects them into the state directory",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);

      // Every session's prompt names a verdict path inside the worktree — the
      // only location both providers' sandboxed permission modes let an agent
      // write. A state-directory path here is the regression that blocked
      // every auto-mode run: the sandbox rejects the write, the pipeline sees
      // invalid-verdict, and the card dies at max_rounds.
      const prompts = (await fs.readFile(sandbox.argvLog, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { argv: string[] });
      const verdictPaths = prompts.flatMap(({ argv }) =>
        argv.flatMap((argument) => argument.match(/\/\S+\.verdict\.json/g) ?? []),
      );
      expect(verdictPaths.length).toBeGreaterThan(0);
      for (const verdictPath of verdictPaths) {
        expect(verdictPath).toContain(`/.jfdi/worktrees/${ticketId}/`);
        expect(verdictPath).not.toContain("/runs/");
      }

      // Collected: each stage's verdict lands in the round directory as before…
      const roundDir = path.join(sandbox.stateDir, "runs", ticketId, "run-1", "round-1");
      for (const stage of ["implementation", "code-review", "qa"]) {
        await fs.access(path.join(roundDir, `${stage}.verdict.json`));
      }

      // …and never in a commit: the landed tree holds no verdict file.
      expect(await runCli(sandbox, ["merge", ticketId]).then((result) => result.code)).toBe(0);
      const landedFiles = await git(sandbox.project, "ls-tree", "-r", "--name-only", "main");
      expect(landedFiles).not.toContain(".verdict.json");
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
      // The pipeline records the blocked transition, then its caller flushes
      // this run's deduplicated observations. Observation events are
      // state-neutral, so the ticket remains blocked after this tail.
      expect(shapes.slice(-2)).toEqual(["blocked", "observation"]);

      const blocked = events.find((event) => event.type === "blocked");
      expect(blocked?.data?.reason).toBe("retries exhausted after 3 rounds");
      const board = await fs.readFile(path.join(sandbox.project, ".jfdi", "board.md"), "utf8");
      expect(board).toContain(`stray TODO in foo.ts *(from ${ticketIdOf(run)})*`);

      // Nothing reached the target branch.
      expect(await git(sandbox.project, "log", "--oneline", "main")).not.toContain("implement");

      // The note carries each failed round's handback — the reviewer's exact
      // words — and the exhaustion that sent the card to Blocked.
      const note = await readTicketNote(sandbox, ticketIdOf(run));
      expect(
        note.match(/> JFDI Code Review FAILED — returning to Implementation for round 2/g),
      ).toHaveLength(1);
      expect(note).toContain("> JFDI Code Review FAILED — moving to Blocked for human review");
      expect(note).toContain("> needs work");
      expect(note).toContain("All 3 rounds failed. Round history:");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "surfaces an observation carried by a failing code-review verdict, even when the run blocks",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // Every round's code review fails (blocking the run at max_rounds) and
      // carries its own observation in the same verdict. The observation
      // channel's contract says every proposal reaches a human via the inbox,
      // so the reviewer's flag must land there despite the failing outcome —
      // the drop this ticket fixes.
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        stubMode: "review-fail-observed",
      });
      expect(run.code).toBe(2);

      const board = await fs.readFile(path.join(sandbox.project, ".jfdi", "board.md"), "utf8");
      const ticketId = ticketIdOf(run);
      // The failing reviewer's own flag reached the inbox…
      expect(board).toContain(
        `reviewer-flagged: unchecked auth on the legacy endpoint *(from ${ticketId})*`,
      );
      // …and it is proposed once, not once per failed round, despite being
      // re-reported across all three rounds (within-run deduplication).
      const inbox = board.slice(board.indexOf("## Inbox"));
      expect(inbox.match(/reviewer-flagged: unchecked auth/g)).toHaveLength(1);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "prints observations in the run summary when boardless, on both the pass and blocked exits, deduplicated",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // A boardless run: delete the scaffolded board and drop into on-approval
      // so nothing needs an inbox to succeed. There is no board to receive
      // proposals, so the only place a parsed observation can still surface is
      // the run summary the operator reads on stdout — the boardless drop this
      // ticket fixes ("observations land nowhere at all").
      const jfdiDir = path.join(sandbox.project, ".jfdi");
      await fs.rm(path.join(jfdiDir, "board.md"));
      const configPath = path.join(jfdiDir, "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      config.integration = { ...config.integration, mode: "on-approval" };
      await fs.writeFile(configPath, JSON.stringify(config));

      // Pass path: the implementation's observation reaches the summary even
      // though every stage passed and there is no board.
      const passed = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(passed.code).toBe(0);
      await expect(fs.access(path.join(jfdiDir, "board.md"))).rejects.toThrow();
      expect(passed.stdout).toContain("Observations:");
      expect(passed.stdout).toContain("stray TODO in foo.ts");

      // Blocked path: the run exits non-zero after exhausting its rounds, yet
      // the observation reported in every one of those rounds still surfaces —
      // exactly once, proving the run-scoped deduplication holds even when the
      // run never passes.
      const blocked = await runCli(sandbox, ["run", "Add a farewell"], {
        stubMode: "review-fail",
      });
      expect(blocked.code).toBe(2);
      expect(blocked.stdout).toContain("Observations:");
      expect(blocked.stdout.match(/stray TODO in foo\.ts/g)).toHaveLength(1);
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
          JSON.stringify({ pipeline: { max_rounds: "three" }, stages: STAGES }),
          "max_rounds must be a positive integer",
        ],
        [
          JSON.stringify({ pipeline: { max_rounds: -1 }, stages: STAGES }),
          "max_rounds must be a positive integer",
        ],
        // `stages` is required, and the retired global key is a hard stop —
        // the breaking config change, pinned from outside the process.
        ["{}", 'missing the required "stages" section'],
        [JSON.stringify({ harness: "claude", stages: STAGES }), "no longer supported"],
        [
          JSON.stringify({ stages: { ...STAGES, qa: undefined } }),
          "stages is missing an entry for qa",
        ],
        [
          JSON.stringify({ stages: { ...STAGES, qa: { harness: "claude", effort: "hgih" } } }),
          "which the claude harness does not accept",
        ],
      ];
      for (const [body, expected] of rejected) {
        await fs.writeFile(configPath, body);
        const status = await runCli(sandbox, ["status"]);
        expect(status.code, `config: ${body}`).toBe(1);
        expect(status.stderr, `config: ${body}`).toContain(expected);
        // A diagnostic, not a leaked stack trace.
        expect(status.stderr).not.toContain("    at ");
      }

      // Everything but `stages` still defaults: the section alone parses clean.
      await fs.writeFile(configPath, JSON.stringify({ stages: STAGES }));
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
    "blocks a shape-invalid report.json with its repair recipe",
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
      const corruptContent = JSON.stringify({ summary: "s", commit: realCommit });
      await fs.writeFile(reportPath, corruptContent);

      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(2);
      expect(merge.stderr).toContain(reportPath);
      expect(merge.stderr).toContain("decisions");
      expect(merge.stderr).toContain("fix or restore");
      expect(merge.stderr).toContain("delete the file");
      expect(await fs.readFile(reportPath, "utf8")).toBe(corruptContent);
      const landed = await git(sandbox.project, "log", "--oneline", "main");
      expect(landed).not.toContain("stub-scribed subject");
      expect(await git(sandbox.project, "branch", "--list", `jfdi/${ticketId}`)).toContain(
        `jfdi/${ticketId}`,
      );
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "refuses `jfdi run` on a corrupt report — no dispatch, evidence intact, pass restorable",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const first = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(first.code).toBe(0);
      const ticketId = ticketIdOf(first);
      // The successful run is our baseline for "an agent CLI was spawned": every
      // further refusal must add nothing to this log.
      const spawnCount = async (): Promise<number> =>
        (await fs.readFile(sandbox.argvLog, "utf8")).split("\n").filter((line) => line.trim())
          .length;
      const spawnsAfterPass = await spawnCount();
      expect(spawnsAfterPass).toBeGreaterThan(0);

      const reportPath = path.join(sandbox.stateDir, "runs", ticketId, "report.json");
      const validReport = await fs.readFile(reportPath, "utf8");
      // A truncated write is the parse-failure shape; the shape-invalid case is
      // pinned by the merge test above. Re-running must not re-dispatch over it.
      const corruptContent = '{"summary":';
      await fs.writeFile(reportPath, corruptContent);

      const rerun = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(rerun.code).toBe(2);
      expect(rerun.stderr).toContain(reportPath);
      expect(rerun.stderr).toContain("could not parse JSON");
      expect(rerun.stderr).toContain("fix or restore");
      expect(rerun.stderr).toContain("delete the file");
      // The refusal spawned no agent session, and left the corrupt file and the
      // signed-off branch exactly as they were — the evidence and the tripwire.
      expect(await spawnCount()).toBe(spawnsAfterPass);
      expect(await fs.readFile(reportPath, "utf8")).toBe(corruptContent);
      expect(await git(sandbox.project, "branch", "--list", `jfdi/${ticketId}`)).toContain(
        `jfdi/${ticketId}`,
      );
      expect(await readTicketNote(sandbox, ticketId)).toContain("fix or restore");

      // Restore the report (fix/restore branch of the recipe): the existing pass
      // lands with no fresh pipeline, proving the refusal cost no signed-off work.
      await fs.writeFile(reportPath, validReport);
      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code).toBe(0);
      expect(merge.stdout).toContain("Merged into main.");
      expect(await spawnCount()).toBe(spawnsAfterPass);
      expect(await git(sandbox.project, "log", "--oneline", "main")).toContain(
        "stub-scribed subject",
      );
    },
    PIPELINE_TIMEOUT_MS,
  );
});
