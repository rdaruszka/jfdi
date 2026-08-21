/**
 * Acceptance for one-comment-per-phase: a run's `## Comments` trail carries
 * exactly one comment per phase, each comment IS the phase's handoff commit
 * message verbatim, and a round with in-round gate fixes still yields a single
 * implementation comment.
 *
 * These drive the built CLI (`dist/index.js`) in a scratch repo under the OS
 * temp dir, with stub `claude`/`codex` binaries on PATH — the only way to see
 * the trail the way `git log` and a human both read it after a real run. The
 * stub makes both review-relevant sessions commit (Implementation always; QA
 * when it writes a test), so the byte-for-byte "the commit message and its
 * ticket comment are the same text" invariant is exercised on a stage that
 * actually commits, not just asserted on the message in isolation.
 *
 * Assertions read the note with a private un-blockquote helper and plain string
 * search, never the product's own parser, so a change in how JFDI reads a note
 * back cannot make these agree with it by construction. `JFDI_HOME`/`HOME`
 * always point inside the scratch tree.
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
 * The agent both stubbed CLIs play. Implementation always commits and carries
 * decisions; QA commits a test file (so it has its own handoff commit) and
 * carries a decision; Code Review passes without committing. The scribe session
 * (the one prompt naming no verdict file) has its printed result text become the
 * commit subject and body, so a test can assert on a real subject.
 *
 * `GATE_FLAKY=1` makes Implementation append a unique line every session, so
 * each session changes the tree and produces its own commit — the shape a
 * gate-fix round leaves behind.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
const commit = () => {
  execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
  execFileSync("git", ["commit", "-m", "agent-self-commit"], { cwd: process.cwd() });
};
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    if (process.env.GATE_FLAKY === "1") {
      const seen = fs.existsSync(process.cwd() + "/impl.txt")
        ? fs.readFileSync(process.cwd() + "/impl.txt", "utf8").split("\\n").length
        : 0;
      fs.appendFileSync(process.cwd() + "/impl.txt", "line " + seen + "\\n");
    } else {
      fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    }
    commit();
    verdict = { status: "done", summary: "implemented the widget", decisions: ["IMPL_DECISION assumed sqlite"] };
  } else if (stage === "qa") {
    fs.writeFileSync(process.cwd() + "/feature.test.txt", "regression\\n");
    commit();
    verdict = { verdict: "pass", testsAdded: "added a regression test", decisions: ["QA_DECISION exercised the omit path"] };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else {
    verdict = { verdict: "pass", decisions: ["REVIEW_DECISION confirmed the invariant"] };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "STUB_SUBJECT one comment per phase\\n\\nA descriptive body from the scribe." }) + "\\n");
`;

/**
 * A gate that fails its first invocation in a scratch repo and passes after,
 * forcing exactly one in-round gate fix. Its counter file is gitignored so it
 * never enters a handoff diff.
 */
const FLAKY_GATE = `#!/usr/bin/env bash
count_file="$PWD/.gate-count"
seen=$(cat "$count_file" 2>/dev/null || echo 0)
echo $((seen + 1)) > "$count_file"
if [ "$seen" -eq 0 ]; then echo "gate failing on purpose"; exit 1; fi
echo "gate ok"; exit 0
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
  ticketsDirectory: string;
}

const sandboxes: string[] = [];

async function makeSandbox(options: { flakyGate?: boolean } = {}): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-one-comment-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  for (const directory of [projectRoot, home, executableDirectory])
    await fs.mkdir(directory, { recursive: true });
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), STUB_AGENT, { mode: 0o755 });
  }
  if (options.flakyGate) {
    await fs.writeFile(path.join(executableDirectory, "flaky-gate"), FLAKY_GATE, { mode: 0o755 });
  }

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  const sandbox: Sandbox = {
    root,
    projectRoot,
    home,
    jfdiHome,
    executableDirectory,
    ticketsDirectory: path.join(projectRoot, ".jfdi", "tickets"),
  };
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  // Auto integration so one `run` produces the whole trail, Integration
  // included; a gitignored counter keeps the flaky gate's state out of diffs.
  await patchConfig(sandbox, (config) => {
    config.integration = { ...config.integration, mode: "auto" };
    if (options.flakyGate) config.gate = [{ name: "flaky", command: "flaky-gate" }];
  });
  if (options.flakyGate) {
    await fs.appendFile(path.join(projectRoot, ".jfdi", ".gitignore"), "\n.gate-count\n");
  }
  return sandbox;
}

interface MutableConfig {
  integration: { targetBranch: string; mode: string };
  gate: Array<{ name: string; command: string }>;
  [key: string]: unknown;
}

async function patchConfig(
  sandbox: Sandbox,
  mutate: (config: MutableConfig) => void,
): Promise<void> {
  const configPath = path.join(sandbox.projectRoot, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as MutableConfig;
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
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
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function readNote(sandbox: Sandbox, id: string): Promise<string> {
  return fs.readFile(path.join(sandbox.ticketsDirectory, `${id}.md`), "utf8");
}

/** The one ticket the run mints from a boardless card. */
function ticketIdOf(result: CliResult): string {
  const match = result.stdout.match(/\[([a-z0-9-]+)\]/);
  if (!match?.[1]) throw new Error(`no ticket id in run output:\n${result.stdout}`);
  return match[1];
}

/** Strip exactly one blockquote level — the inverse of what the note writer added. */
function unquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("> ") ? line.slice(2) : line === ">" ? "" : line))
    .join("\n")
    .trim();
}

interface Entry {
  label: string;
  body: string;
}

/** Split a note's `## Comments` trail into `{ label, body }` entries, oldest first. */
function commentEntries(note: string): Entry[] {
  const marker = "\n## Comments";
  const index = note.indexOf(marker);
  if (index === -1) return [];
  return note
    .slice(index)
    .split(/\n### /)
    .slice(1)
    .map((chunk) => {
      const newline = chunk.indexOf("\n");
      const heading = chunk.slice(0, newline).trim();
      return {
        label: heading.replace(/^\S+ — /, ""),
        body: unquote(chunk.slice(newline + 1).trim()),
      };
    });
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("a clean auto-mode run's comment trail", () => {
  it(
    "lands exactly five phase comments, each identical to its handoff commit message",
    async () => {
      const sandbox = await makeSandbox();
      const run = await runCli(sandbox, ["run", "Add a widget"]);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);
      const note = await readNote(sandbox, ticketId);
      const entries = commentEntries(note);

      // Exactly the five phase headers, in order — a sixth would be the
      // duplicate QA emission the bug portion of the ticket removes, and no
      // standalone decision/status comment may appear between them.
      expect(entries.map((entry) => entry.label)).toEqual([
        "JFDI started",
        "Implementation round 1 complete",
        "Code Review round 1 complete",
        "QA round 1 complete",
        "Integration complete",
      ]);
      expect(note).not.toMatch(/### \S+ — Decision \(/);

      const started = entries[0];
      const implementation = entries[1];
      const codeReview = entries[2];
      const qa = entries[3];

      // The started comment states the run's parameters, with the auto merge
      // sentence — not the on-approval one.
      expect(started?.body).toBe(
        `Run started — 4 rounds max. Code Review may reject 2×, QA 1×. Working branch \`jfdi/${ticketId}\`, will merge to \`main\`.`,
      );

      // Every stage comment — the no-commit Code Review included — carries all
      // three trailers.
      for (const stage of [implementation, codeReview, qa]) {
        expect(stage?.body).toContain("JFDI-Round: 1/4");
        expect(stage?.body).toContain("JFDI-Duration:");
        expect(stage?.body).toContain("JFDI-Cost:");
      }

      // The commit each stage handed off IS its ticket comment, byte for byte —
      // decisions and status line included — so `git log` and the trail carry
      // the identical record. Implementation and QA both commit here.
      // Auto mode cleans the branch up after the merge, so the stage commits are
      // read from `main` — reachable as the merge's second parent.
      const stageSubjects = await git(
        sandbox.projectRoot,
        "log",
        "main",
        "--format=%H %s",
        "--grep=STUB_SUBJECT",
      );
      const shas = stageSubjects
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.split(" ")[0] ?? "");
      const messages = await Promise.all(
        shas.map((sha) => git(sandbox.projectRoot, "show", "-s", "--format=%B", sha)),
      );
      const trimmed = messages.map((message) => message.trimEnd());
      expect(trimmed).toContain(implementation?.body);
      expect(trimmed).toContain(qa?.body);

      // The implementation comment carries its verbatim decision, folded into a
      // Decisions block rather than emitted as its own comment.
      expect(implementation?.body).toContain("Decisions:\n- IMPL_DECISION assumed sqlite");
      // Code Review committed nothing, so it skips the subject and opens on its
      // own decision — but is still one full comment.
      expect(codeReview?.body.startsWith("Decisions:")).toBe(true);
      expect(codeReview?.body).toContain("REVIEW_DECISION confirmed the invariant");
      expect(codeReview?.body).toMatch(
        /JFDI Code Review PASSED — sign-off on commit `[0-9a-f]{7}`, moving to QA/,
      );
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("a round that needed an in-round gate fix", () => {
  it(
    "still lands one implementation comment, folding every commit of the round",
    async () => {
      const sandbox = await makeSandbox({ flakyGate: true });
      const env = { GATE_FLAKY: "1" };
      const run = await runCliWithEnv(sandbox, ["run", "Add a widget"], env);
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);
      const note = await readNote(sandbox, ticketId);
      const entries = commentEntries(note);

      // Still exactly one implementation comment for the round…
      const implementations = entries.filter((entry) =>
        entry.label.startsWith("Implementation round 1"),
      );
      expect(implementations).toHaveLength(1);
      const implementation = implementations[0];

      // …and it grew to hold the gate-fix session's committed message under a
      // clear delimiter, so both commits of the round are accounted for in the
      // trail without a second comment.
      expect(implementation?.body).toContain("--- Gate-fix session 1 ---");
      expect(implementation?.body).toContain(
        "JFDI Implementation complete — gate failed at `flaky`, continuing with gate fix 1 of 3",
      );
      expect(implementation?.body).toContain(
        "JFDI Implementation complete — gate green (flaky ✓), moving to Code Review",
      );

      // The branch really does carry two implementation commits — the record is
      // complete, not merely narrated. Counted by the file the Implementation
      // stub touches, so QA's own commit (same scribe subject) is not mistaken
      // for one of them.
      const implementationCommits = (
        await git(sandbox.projectRoot, "log", "main", "--format=%H", "--", "impl.txt")
      )
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(implementationCommits.length).toBe(2);
    },
    PIPELINE_TIMEOUT_MS,
  );
});

async function runCliWithEnv(
  sandbox: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
