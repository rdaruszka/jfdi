/**
 * Acceptance for the session-id channel after the harness-contract-surface cut.
 *
 * The ticket deleted the `"session"` variant of `HarnessEvent` — the public
 * stream event both harnesses used to push their provider session id onto.
 * Each harness now captures that id by parsing the raw stream line itself
 * (`session_id` for Claude, `thread.started`'s `thread_id` for Codex) and
 * delivers it only on `HarnessResult.sessionId`, the channel the pipeline reads
 * to continue a stage's session in a later round.
 *
 * `per-stage-selection.e2e.test.ts` already pins that a round-2 continuation
 * *happens* (a `--resume`/`resume` argv appears). What nothing pinned is the
 * *value*: that the id threaded into round N's continuation is the exact id the
 * harness captured from round N-1's stream. A capture that silently grabbed the
 * wrong line, a stale id, or a placeholder would still produce a continuation
 * argv and pass the boolean check. This test drives the built CLI through three
 * rounds with per-round distinct session ids and asserts each continuation
 * carries the prior round's announced id — end to end, both providers.
 *
 * The Claude stub announces its id on the `system/init` line *only*, never the
 * result line, so this also pins that init-line-only capture survives the
 * deletion (the old `session` event fired on both lines; the direct parse must
 * still catch an id that appears on init alone).
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
 * Shared body: log the argv, write the verdict the prompt names, and — for the
 * implementation stage — commit a per-round feature file so later sessions can
 * read the round off the tree. Code review fails rounds 1 and 2 and passes
 * round 3, so the run takes all three rounds (continuing each stage's session
 * across them) and still ends merge-ready.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (process.env.STUB_ARGV_LOG) {
  fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({ cli: cliName, argv }) + "\\n");
}
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = "stub-scribed subject\\n\\nWhat the session did.";
}
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let featureCount = 1;
  while (fs.existsSync(process.cwd() + "/feature" + featureCount + ".txt")) featureCount += 1;
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature" + featureCount + ".txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement round " + featureCount], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: [], observations: [], testsAdded: "unit tests" };
  } else if (stage === "code-review") {
    // Review runs after this round's implementation wrote its feature file, so
    // the feature count is one ahead of the review round.
    const reviewRound = featureCount - 1;
    verdict = reviewRound < 3
      ? { verdict: "fail", feedback: "needs work in round " + reviewRound }
      : { verdict: "pass", testsAdded: "e2e tests" };
  } else {
    verdict = { verdict: "pass", testsAdded: "e2e tests" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

/**
 * Claude stub: prompt follows `-p`. The session id rides the `system/init` line
 * only — never the result line — and is keyed to this round so a continuation
 * that reuses the wrong round's id is caught.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const boot = require("node:fs");
let round = 1;
while (boot.existsSync(process.cwd() + "/feature" + round + ".txt")) round += 1;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "impl-sess-r" + round }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

/**
 * Codex stub: prompt is the last positional. The thread id rides
 * `thread.started`, keyed to the review round (one behind the feature count).
 */
const STUB_CODEX = `#!/usr/bin/env node
const cliName = "codex";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
const boot = require("node:fs");
let featureCount = 1;
while (boot.existsSync(process.cwd() + "/feature" + featureCount + ".txt")) featureCount += 1;
const reviewRound = Math.max(1, featureCount - 1);
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "review-thread-r" + reviewRound }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }) + "\\n");
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
  argvLog: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-session-continuation-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  await fs.writeFile(path.join(executableDirectory, "claude"), STUB_CLAUDE, { mode: 0o755 });
  await fs.writeFile(path.join(executableDirectory, "codex"), STUB_CODEX, { mode: 0o755 });

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");

  return {
    root,
    projectRoot,
    home,
    jfdiHome: path.join(home, ".jfdi"),
    executableDirectory,
    argvLog: path.join(root, "argv.jsonl"),
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
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_ARGV_LOG: sandbox.argvLog,
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

interface Invocation {
  cli: string;
  stage: string | undefined;
  /** The id passed for continuation, or undefined for a fresh session. */
  continuedId: string | undefined;
}

/** Every stub invocation, tagged with its stage and any continuation id. */
async function invocations(sandbox: Sandbox): Promise<Invocation[]> {
  const raw = await fs.readFile(sandbox.argvLog, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { cli: string; argv: string[] })
    .map(({ cli, argv }) => {
      const joined = argv.join(" ");
      const stage = joined.includes("Write the commit message")
        ? "commit-message"
        : /(\w[\w-]*)\.verdict\.json/.exec(joined)?.[1];
      // Claude carries the continued id after `--resume`; Codex as the
      // positional just before the prompt in `exec resume <flags> <id> <prompt>`.
      let continuedId: string | undefined;
      if (cli === "claude") {
        const at = argv.indexOf("--resume");
        continuedId = at === -1 ? undefined : argv[at + 1];
      } else if (argv[0] === "exec" && argv[1] === "resume") {
        continuedId = argv[argv.length - 2];
      }
      return { cli, stage, continuedId };
    });
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("harness session-id continuation, end to end", () => {
  it(
    "threads each round's captured session id into the next round's continuation",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // Three rounds: review fails 1 and 2, passes 3, so every stage's session
      // is continued twice and the run still ends merge-ready.
      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);

      const all = await invocations(sandbox);
      const implementationCalls = all.filter((call) => call.stage === "implementation");
      const reviewCalls = all.filter((call) => call.stage === "code-review");

      // All three rounds ran for each continued stage.
      expect(implementationCalls.map((call) => call.cli)).toEqual(["claude", "claude", "claude"]);
      expect(reviewCalls.map((call) => call.cli)).toEqual(["codex", "codex", "codex"]);

      // Round 1 is always fresh; rounds 2 and 3 continue the *prior* round's
      // captured id — the exact value the harness parsed off the prior stream,
      // not this round's and not a placeholder. Claude's id was announced on
      // the init line alone, so this also proves init-line-only capture.
      expect(implementationCalls.map((call) => call.continuedId)).toEqual([
        undefined,
        "impl-sess-r1",
        "impl-sess-r2",
      ]);
      expect(reviewCalls.map((call) => call.continuedId)).toEqual([
        undefined,
        "review-thread-r1",
        "review-thread-r2",
      ]);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
