/**
 * Acceptance for QA fixing its own gate-breaking tests in-stage, driven end to
 * end through the built CLI against a scratch repo — never the source.
 *
 * The unit suite in `pipeline.test.ts` pins this behavior against `FakeHarness`.
 * These tests make the same claims about what a real `git` history, a real
 * ticket note on disk, and a real `events.jsonl` say after the built product
 * runs a full pipeline with real `claude`/`codex` stubs on PATH and a real
 * gate command that goes red over the file QA commits. The claims the ticket
 * makes are claims about those artifacts, so only the artifacts can settle them.
 *
 * The gate is `test -f impl.txt && ! grep -q BROKEN qa-test.txt`: green while
 * `qa-test.txt` is absent (Implementation's gate) and while it holds `fixed`,
 * red while it holds `BROKEN`. QA commits `BROKEN` first, so the pipeline's
 * post-QA gate goes red over QA's own test — exactly the situation the ticket
 * routes back into QA's session instead of consuming a round.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`, and the stubs never call a paid provider.
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
 * The agent both stubs play. Behaviour keys off the tree and the prompt, not a
 * call count, because each session is its own process:
 *   - Implementation writes `impl.txt` once (the pipeline commits it).
 *   - Code Review passes.
 *   - QA's first fresh session (no `qa-test.txt` yet) commits `BROKEN`, which
 *     makes the pipeline's post-QA gate red.
 *   - QA continued with the gate-fix brief ("being continued") writes `fixed`;
 *     in STUB_MODE=escape it also writes an unreviewed `product-change.txt`,
 *     the out-of-allowlist change the pipeline must reject as a gate fix.
 *   - A later round's fresh QA session (tree already `fixed`) adds nothing.
 */
const STUB_BODY = `
const fs = require("node:fs");
const cwd = process.cwd();
const mode = process.env.STUB_MODE || "normal";
function logStage(name) {
  if (process.env.STUB_STAGE_LOG) fs.appendFileSync(process.env.STUB_STAGE_LOG, name + "\\n");
}
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = "stub scribe subject\\n\\nWhat the session did.";
} else {
  const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
  if (match) {
    const verdictPath = match[1];
    const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
    let verdict = null;
    if (stage === "implementation") {
      logStage("implementation");
      if (!fs.existsSync(cwd + "/impl.txt")) fs.writeFileSync(cwd + "/impl.txt", "x\\n");
      verdict = { status: "done", summary: "implemented", decisions: [], observations: [] };
    } else if (stage === "code-review") {
      logStage("code-review");
      verdict = { verdict: "pass", observations: [] };
    } else if (stage === "qa") {
      logStage("qa");
      const qaPath = cwd + "/qa-test.txt";
      if (prompt.includes("being continued")) {
        fs.writeFileSync(qaPath, "fixed\\n");
        if (mode === "escape") fs.writeFileSync(cwd + "/product-change.txt", "unreviewed\\n");
        verdict = { verdict: "pass", testsAdded: "fixed the tests", decisions: [], observations: [] };
      } else if (!fs.existsSync(qaPath)) {
        fs.writeFileSync(qaPath, "BROKEN\\n");
        verdict = { verdict: "pass", testsAdded: "acceptance tests", decisions: [], observations: [] };
      } else {
        verdict = { verdict: "pass", testsAdded: "acceptance tests", decisions: [], observations: [] };
      }
    }
    if (verdict) {
      fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
      fs.writeFileSync(verdictPath, JSON.stringify(verdict));
    }
  }
}
`;

/** Claude plays Implementation, QA, and the scribe. A constant session id on
 * the init line gives QA a session the pipeline can continue for its gate fix. */
const STUB_CLAUDE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
if (process.env.STUB_ARGV_LOG && prompt.includes("being continued")) {
  require("node:fs").appendFileSync(
    process.env.STUB_ARGV_LOG,
    JSON.stringify({ resume: argv.includes("--resume") }) + "\\n",
  );
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

/** Codex plays Code Review only. */
const STUB_CODEX = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }) + "\\n");
`;

const GATE = [{ name: "check", command: "test -f impl.txt && ! grep -q BROKEN qa-test.txt" }];

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
  stageLog: string;
  argvLog: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-qa-gate-fix-"));
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
    stageLog: path.join(root, "stages.log"),
    argvLog: path.join(root, "argv.log"),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[], mode = "normal"): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_MODE: mode,
    STUB_STAGE_LOG: sandbox.stageLog,
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

/** Rewrite the scaffolded config so the gate goes red over QA's committed test. */
async function setGate(sandbox: Sandbox): Promise<void> {
  const configPath = path.join(sandbox.projectRoot, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.gate = GATE;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

async function initProject(sandbox: Sandbox): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  await setGate(sandbox);
}

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

async function stageCounts(sandbox: Sandbox): Promise<Record<string, number>> {
  const lines = (await fs.readFile(sandbox.stageLog, "utf8")).split("\n").filter(Boolean);
  const counts: Record<string, number> = {};
  for (const line of lines) counts[line] = (counts[line] ?? 0) + 1;
  return counts;
}

async function roundStartCount(sandbox: Sandbox, ticketId: string): Promise<number> {
  // Key the state dir exactly as the tool does: the project root's absolute
  // path with every separator turned into a dash (leading dash kept).
  const projectKey = path.resolve(sandbox.projectRoot).split(path.sep).join("-");
  const eventsPath = path.join(sandbox.jfdiHome, "projects", projectKey, "events.jsonl");
  const events = (await fs.readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
  return events
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "round_start" && event.ticketId === ticketId).length;
}

function readNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.projectRoot, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
}

/** The QA phase comment: from its `— QA` header to the next `### ` or the end. */
function qaCommentBlocks(note: string): string[] {
  const blocks: string[] = [];
  const headers = [...note.matchAll(/^### .* — QA.*$/gm)];
  for (const header of headers) {
    const start = header.index ?? 0;
    const rest = note.slice(start + header[0].length);
    const next = rest.search(/^### /m);
    blocks.push(header[0] + (next === -1 ? rest : rest.slice(0, next)));
  }
  return blocks;
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("QA fixes its own gate-breaking tests in-stage", () => {
  it(
    "continues QA to green over its own test, keeping both sign-offs and the round",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = await runCli(sandbox, ["run", "QA writes a test that breaks the gate"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);
      const branch = `jfdi/${ticketId}`;

      // The round loop ran exactly once: QA's gate fix did not cost a round.
      expect(await roundStartCount(sandbox, ticketId)).toBe(1);

      // Implementation and Code Review each ran exactly once — neither re-ran to
      // service QA's gate fix — while QA ran twice (fresh + one continuation).
      const counts = await stageCounts(sandbox);
      expect(counts.implementation).toBe(1);
      expect(counts["code-review"]).toBe(1);
      expect(counts.qa).toBe(2);

      // The gate fix ran as a continuation of QA's own session (--resume), the
      // same mechanism Implementation's gate fix uses — not a fresh spawn.
      const gateFixInvocations = (await fs.readFile(sandbox.argvLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(gateFixInvocations).toHaveLength(1);
      expect(gateFixInvocations[0]?.resume).toBe(true);

      // Two pipeline commits touch QA's test: the red `BROKEN` and the fix.
      const qaCommits = (
        await git(sandbox.projectRoot, "log", "--format=%H", `main..${branch}`, "--", "qa-test.txt")
      )
        .split("\n")
        .filter(Boolean);
      expect(qaCommits).toHaveLength(2);
      expect(await git(sandbox.projectRoot, "show", `${branch}:qa-test.txt`)).toBe("fixed");

      // The tip commit is QA's, still bound to round 1 — no fix round was spent.
      expect(
        await git(
          sandbox.projectRoot,
          "log",
          "-1",
          "--format=%(trailers:key=JFDI-Round,valueonly)",
          branch,
        ),
      ).toBe("1/3");

      // Exactly one QA comment for the round, folding both sessions' messages:
      // the initial red status, the gate-fix session marker, both gate-fix
      // commit subjects, and the green resolution.
      const note = await readNote(sandbox, ticketId);
      const qaComments = qaCommentBlocks(note);
      expect(qaComments).toHaveLength(1);
      const qaComment = qaComments[0] ?? "";
      expect(qaComment).toContain("JFDI QA PASSED — sign-off on commit");
      expect(qaComment).toContain("gate failed at `check` over QA's tests");
      expect(qaComment).toContain("--- Gate-fix session 1 ---");
      expect(qaComment).toContain("green after 1 gate fix");
      for (const commit of qaCommits) {
        const subject = (await git(sandbox.projectRoot, "log", "-1", "--format=%s", commit)).trim();
        expect(qaComment).toContain(subject);
      }

      // Neither reviewer's phase comment repeated: exactly one of each.
      expect(note.match(/^### .* — Code Review/gm) ?? []).toHaveLength(1);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "rejects a QA gate fix that reaches outside QA's own commits and repeats both reviews",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = await runCli(sandbox, ["run", "QA widens its fix into product code"], "escape");
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);
      const branch = `jfdi/${ticketId}`;

      // The out-of-allowlist gate fix was rejected, so the round was consumed:
      // a second round_start fired and both reviewers ran again.
      expect(await roundStartCount(sandbox, ticketId)).toBe(2);
      const counts = await stageCounts(sandbox);
      expect(counts.implementation).toBe(2);
      expect(counts["code-review"]).toBe(2);

      // The unreviewed file the gate fix reached for is on the branch — and the
      // round-2 Code Review that reviewed it did run (asserted above).
      expect(await git(sandbox.projectRoot, "cat-file", "-t", `${branch}:product-change.txt`)).toBe(
        "blob",
      );

      // The QA comment names the offending path as the reason both reviews repeat.
      const note = await readNote(sandbox, ticketId);
      expect(note).toContain("outside QA's initial handoff: product-change.txt");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
