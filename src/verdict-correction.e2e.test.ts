/**
 * Acceptance for "spec-invalid verdicts: return to the same agent like a gate
 * failure; block after 2 tries."
 *
 * The unit tests in pipeline.test.ts pin the mechanism against a FakeHarness.
 * These drive the built `dist/index.js` from the outside — in a scratch repo
 * under the OS temp dir, with stub `claude` and `codex` binaries on PATH — and
 * assert on what a user or wrapper script sees: exit codes, the argv each stage
 * CLI was handed (so a real `--resume`/`resume` continuation is observable, not
 * merely asserted), the event stream, and the ticket-note mutations.
 *
 * The three cases mirror the ticket's own test list:
 *   1. wrong-enum verdict → same session re-entered naming the enum → corrected
 *      verdict proceeds, no round consumed;
 *   2. unparseable JSON → the correction message names the parse error and the
 *      verdict file path, no round consumed;
 *   3. persistent garbage → blocked after 2 tries, the error and file path in
 *      the note, no round consumed on the way down.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`. The stubs never touch the network.
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

const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * The body both stubs share: log argv, then write the verdict file the prompt
 * names. `STUB_MODE` picks which stage misbehaves and how. A correction session
 * is recognised by the message the pipeline prepends — its whole point is that
 * the same agent, re-entered, sees a concrete spec violation rather than a
 * fresh task, so the stub keys off exactly that.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const mode = process.env.STUB_MODE || "review-enum";
if (process.env.STUB_ARGV_LOG) {
  fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({ cli: cliName, argv }) + "\\n");
}
let resultText = "done";
const isScribe = prompt.includes("Write the commit message");
if (isScribe) {
  resultText = "stub subject\\n\\nWhat the session did, in the stub's words.";
}
const isCorrection = prompt.startsWith("Output does not meet spec:");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match && !isScribe) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  const write = (obj) => fs.writeFileSync(verdictPath, JSON.stringify(obj));
  const writeRaw = (raw) => fs.writeFileSync(verdictPath, raw);
  if (stage === "implementation") {
    if (!isCorrection) {
      let n = 1;
      while (fs.existsSync(process.cwd() + "/feature" + n + ".txt")) n += 1;
      fs.writeFileSync(process.cwd() + "/feature" + n + ".txt", "the feature\\n");
      execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
      execFileSync("git", ["commit", "-m", "implement " + n], { cwd: process.cwd() });
    }
    if (mode === "impl-garbage") {
      writeRaw("{ this is not valid json");
    } else if (mode === "impl-json-recover") {
      if (isCorrection) write({ status: "done", summary: "recovered" });
      else writeRaw("not json at all");
    } else {
      write({ status: "done", summary: "implemented" });
    }
  } else if (stage === "code-review") {
    if (mode === "review-enum" && !isCorrection) write({ verdict: "approve", feedback: "lgtm" });
    else write({ verdict: "pass" });
  } else if (stage === "qa") {
    write({ verdict: "pass", testsAdded: "e2e" });
  } else {
    write({ resolution: "clean" });
  }
}
`;

/** The stub speaking Claude Code's stream-json protocol: prompt after `-p`. */
const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "stub-claude-session" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

/** The stub speaking Codex's protocol: prompt is the last positional argument. */
const STUB_CODEX = `#!/usr/bin/env node
const cliName = "codex";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-codex-thread" }) + "\\n");
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
  argvLog: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-verdict-"));
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
    STUB_MODE: options.stubMode ?? "review-enum",
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

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

interface RecordedEvent {
  type: string;
  data?: Record<string, unknown>;
}

async function readEvents(sandbox: Sandbox): Promise<RecordedEvent[]> {
  const raw = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

interface Invocation {
  cli: string;
  /** The rendered prompt each provider received, extracted its own way. */
  prompt: string;
  /** Whether this spawn continued an earlier session rather than starting fresh. */
  isResume: boolean;
}

/** Every stub spawn's prompt and continuation state, in the order they ran. */
async function readInvocations(sandbox: Sandbox): Promise<Invocation[]> {
  const raw = await fs.readFile(sandbox.argvLog, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { cli: string; argv: string[] })
    .map(({ cli, argv }) => {
      if (cli === "claude") {
        return {
          cli,
          prompt: argv[argv.indexOf("-p") + 1] ?? "",
          isResume: argv.includes("--resume"),
        };
      }
      // Codex continues an earlier thread with `codex exec resume <id> <prompt>`.
      return { cli, prompt: argv.at(-1) ?? "", isResume: argv.includes("resume") };
    });
}

// A stage session names its verdict path; the scribe is excluded even though a
// blocked handoff's summary (which the scribe's prompt embeds) can quote that
// same path back.
const forStage = (invocations: Invocation[], stage: string): Invocation[] =>
  invocations.filter(
    (invocation) =>
      invocation.prompt.includes(`/${stage}.verdict.json`) &&
      !invocation.prompt.includes("Write the commit message"),
  );

const isCorrection = (invocation: Invocation): boolean =>
  invocation.prompt.startsWith("Output does not meet spec:");

/** The generic no-verdict feedback this ticket replaces — banned from every prompt. */
function expectNoGenericNoVerdictRetry(invocations: Invocation[]): void {
  for (const { prompt } of invocations) {
    expect(prompt).not.toContain("did not produce a valid verdict");
    expect(prompt).not.toContain("ended without writing a valid verdict file");
  }
}

function readTicketNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.project, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
}

async function initProject(sandbox: Sandbox): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("spec-invalid verdict correction (built CLI)", () => {
  it(
    "returns a wrong-enum review verdict to the same reviewer, naming the enum, without consuming a round",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "review-enum" });
      // A corrected verdict proceeds to a normal pass → auto-merge → exit 0.
      expect(run.code).toBe(0);

      // The correction stayed inside round 1: exactly one round_start, and the
      // saved report's round count is 1.
      const events = await readEvents(sandbox);
      expect(events.filter((event) => event.type === "round_start")).toHaveLength(1);
      const ticketId = ticketIdOf(run);
      const report = JSON.parse(
        await fs.readFile(path.join(sandbox.stateDir, "runs", ticketId, "report.json"), "utf8"),
      );
      expect(report.rounds).toBe(1);

      const invocations = await readInvocations(sandbox);
      const reviews = forStage(invocations, "code-review");
      // The original out-of-spec verdict, then one correction — no more.
      expect(reviews).toHaveLength(2);
      expect(isCorrection(reviews[0] as Invocation)).toBe(false);
      expect(reviews[0]?.isResume).toBe(false);

      // The correction re-enters the SAME codex thread (a real `resume` in argv),
      // and its message names the concrete enum violation and the file path —
      // never the generic no-verdict retry.
      const correction = reviews[1] as Invocation;
      expect(correction.isResume).toBe(true);
      expect(correction.prompt).toContain('field "verdict" has value "approve"');
      expect(correction.prompt).toContain('allowed values: "pass", "fail"');
      expect(correction.prompt).toContain("code-review.verdict.json");
      expectNoGenericNoVerdictRetry(invocations);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "returns unparseable implementation JSON to the same author, naming the parse error and path, without consuming a round",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        stubMode: "impl-json-recover",
      });
      expect(run.code).toBe(0);

      const events = await readEvents(sandbox);
      expect(events.filter((event) => event.type === "round_start")).toHaveLength(1);
      const ticketId = ticketIdOf(run);
      const report = JSON.parse(
        await fs.readFile(path.join(sandbox.stateDir, "runs", ticketId, "report.json"), "utf8"),
      );
      expect(report.rounds).toBe(1);

      const invocations = await readInvocations(sandbox);
      const impls = forStage(invocations, "implementation");
      expect(impls).toHaveLength(2);
      expect(isCorrection(impls[0] as Invocation)).toBe(false);

      const correction = impls[1] as Invocation;
      expect(correction.isResume).toBe(true);
      expect(correction.prompt).toContain("Output does not meet spec: JSON parse failed:");
      expect(correction.prompt).toContain("implementation.verdict.json");
      expectNoGenericNoVerdictRetry(invocations);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "blocks after two failed corrections, with the error and file path in the note and no round consumed",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const run = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "impl-garbage" });
      // Blocked is exit 2 — distinct from a plain failure (1).
      expect(run.code).toBe(2);
      const ticketId = ticketIdOf(run);

      const events = await readEvents(sandbox);
      // The block happened on the way down inside round 1: no round was consumed.
      expect(events.filter((event) => event.type === "round_start")).toHaveLength(1);
      const blocked = events.filter((event) => event.type === "blocked");
      expect(blocked).toHaveLength(1);
      const reason = String(blocked[0]?.data?.reason ?? "");
      expect(reason).toContain("agent failed to function properly");
      // It blocked for the spec violation, not for exhausting its rounds.
      expect(reason).not.toContain("retries exhausted");

      // Original output plus exactly two corrections — both re-entering the same
      // author session — and then the block. No third correction.
      const invocations = await readInvocations(sandbox);
      const impls = forStage(invocations, "implementation");
      expect(impls).toHaveLength(3);
      expect(impls.slice(1).map((invocation) => invocation.isResume)).toEqual([true, true]);
      expectNoGenericNoVerdictRetry(invocations);

      // The note carries an actionable block: the stage, the count, the concrete
      // parse error, and the verdict file path — and never a rounds-exhausted note.
      const note = await readTicketNote(sandbox, ticketId);
      expect(note).toContain("implementation agent failed to function properly");
      expect(note).toContain("after 2 verdict correction attempts");
      expect(note).toContain("JSON parse failed");
      expect(note).toContain("implementation.verdict.json");
      expect(note).not.toContain("run exhausted");

      // Nothing reached the target branch.
      expect(await git(sandbox.project, "log", "--oneline", "main")).not.toContain("implement");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
