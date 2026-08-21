/**
 * Acceptance for the pipeline's handoff commits, read back the way the ticket
 * says a human and a script will read them.
 *
 * The unit suite asserts on the message *string* `assembleCommitMessage`
 * returns. That is not the same claim the ticket makes. The ticket says the
 * metadata is "git-native … parseable via
 * `git log --format='%(trailers:key=JFDI-Round)'`", and that the pipeline —
 * not an agent — puts a commit on the branch at every session end. Both of
 * those are claims about what `git` does with a real commit in a real
 * repository, so these tests drive the built CLI in a scratch repo and then
 * ask git, never the source.
 *
 * They also exercise hostile or unguided scribe answers — control characters,
 * an overlong first line, an answer that is nothing but the metadata the
 * pipeline owns — because a message only has to survive `git commit` once to
 * be permanent, and a NUL byte makes `git commit -m` fail outright.
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
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const projectRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(projectRoot, "dist", "index.js");

const PIPELINE_TIMEOUT_MS = 120_000;

/** Control characters an agent can emit that must never reach a commit. */
const ESCAPE = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);
const BELL = String.fromCharCode(0x07);

/**
 * The agent both stubs play. `STUB_MODE` picks the scenario; the scribe's
 * answer comes from `STUB_SCRIBE_FILE` when one is set, so a case can hand it
 * bytes no environment variable could carry (a NUL terminates one).
 *
 * Every implementation session commits on its own despite the prompt — that is
 * the behavior the pipeline has to override, so the stub always exercises it.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const mode = process.env.STUB_MODE || "pass";
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = process.env.STUB_SCRIBE_FILE
    ? fs.readFileSync(process.env.STUB_SCRIBE_FILE, "utf8")
    : "Rewrite the greeting as a template";
  if (process.env.STUB_SCRIBE_PROMPT_DUMP) {
    fs.writeFileSync(process.env.STUB_SCRIBE_PROMPT_DUMP, prompt);
  }
} else {
  const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
  if (match) {
    const verdictPath = match[1];
    const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
    // The verdict path lives in the worktree and no longer encodes the round;
    // number this session by what earlier sessions left in the tree instead.
    let round = 1;
    while (fs.existsSync(process.cwd() + "/feature" + round + ".txt")) round += 1;
    let verdict = null;
    if (stage === "implementation") {
      fs.writeFileSync(process.cwd() + "/feature" + round + ".txt", "the feature\\n");
      execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
      execFileSync("git", ["commit", "-m", "AGENT SELF COMMIT " + round], { cwd: process.cwd() });
      // A session that dies before its verdict: work on disk, nothing to read.
      if (mode === "impl-dies") return "the session died mid-edit";
      // A session that fails outright (is_error). Its own result text becomes
      // the status line's outcome, so a case can hand it whitespace and line
      // breaks the pipeline must carry as produced, not collapse.
      if (mode === "impl-fails") {
        isError = true;
        return process.env.STUB_DEATH_TEXT || "the session failed mid-edit";
      }
      verdict = { status: "done", summary: "wrote the greeting template", decisions: [], observations: [] };
    } else if (stage === "integration") {
      verdict = { resolution: "clean" };
    } else if (stage === "code-review") {
      verdict = { verdict: "pass", observations: [] };
    } else if (stage === "qa") {
      if (mode === "qa-writes-tests") {
        fs.writeFileSync(process.cwd() + "/acceptance.test.txt", "acceptance\\n");
      }
      verdict = { verdict: "pass", testsAdded: "greeting acceptance test", observations: [] };
    }
    if (verdict) {
      fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
      fs.writeFileSync(verdictPath, JSON.stringify(verdict));
    }
  }
}
`;

const STUB_CLAUDE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
let isError = false;
const text = (function () {${STUB_BODY}
return resultText;
})();
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: isError, result: text }) + "\\n");
`;

const STUB_CODEX = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
let isError = false;
const text = (function () {${STUB_BODY}
return resultText;
})();
if (isError) process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: text } }) + "\\n");
else process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-handoff-"));
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

  return { root, projectRoot, home, jfdiHome: path.join(home, ".jfdi"), executableDirectory };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  stubMode?: string;
  scribeFile?: string;
  scribePromptDump?: string;
  deathText?: string;
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
    STUB_MODE: options.stubMode ?? "pass",
    NO_COLOR: "1",
  };
  if (options.scribeFile !== undefined) env.STUB_SCRIBE_FILE = options.scribeFile;
  if (options.scribePromptDump !== undefined)
    env.STUB_SCRIBE_PROMPT_DUMP = options.scribePromptDump;
  if (options.deathText !== undefined) env.STUB_DEATH_TEXT = options.deathText;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: plain(stdout), stderr: plain(stderr) };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: plain(failure.stdout ?? ""),
      stderr: plain(failure.stderr ?? ""),
    };
  }
}

/** Every ANSI style sequence the CLI writes: escape, `[`, parameters, `m`. */
const ANSI_STYLE_RE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

/**
 * The CLI styles its own activity lines, so a phrase like "resuming 4 commits"
 * arrives split by escape sequences. Strip them, and assert on what a human
 * reads rather than on where the colour happened to start.
 */
function plain(text: string): string {
  return text.replace(ANSI_STYLE_RE, "");
}

async function initProject(sandbox: Sandbox): Promise<void> {
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
}

function ticketIdOf(result: CliResult): string {
  const match = /ticket: (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${result.stdout}${result.stderr}`);
  return match[1];
}

/** Write the scribe's answer to a file, so bytes an env var cannot carry get through. */
async function scribeAnswer(sandbox: Sandbox, name: string, text: string): Promise<string> {
  const file = path.join(sandbox.root, `scribe-${name}.txt`);
  await fs.writeFile(file, text);
  return file;
}

/** What `git` itself makes of a commit's trailers — not what the source hoped. */
function trailerValue(projectRoot: string, revision: string, key: string): Promise<string> {
  return git(projectRoot, "log", "-1", `--format=%(trailers:key=${key},valueonly)`, revision);
}

function readNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.projectRoot, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("handoff commit messages, as git reads them", () => {
  it(
    "exposes JFDI-Round to git's own trailer parser, alongside the status line",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);
      const branch = `jfdi/${ticketIdOf(run)}`;

      // The ticket's whole reason for using trailers: a script reads the round
      // off a commit with git, and [[cost-reporting]] adds JFDI-Duration and
      // JFDI-Cost to the same block. Asserting on the message text instead
      // would pass even when git sees no trailer block at all.
      expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round")).toBe("1/4");

      // …and the human-facing half of the same block is still there.
      const message = await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch);
      expect(message).toContain("JFDI Implementation complete — gate green, moving to Code Review");
      expect(message).toContain("JFDI-Round: 1/4");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "commits QA's acceptance tests itself, under QA's own status line",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "qa-writes-tests" });
      expect(run.code).toBe(0);
      const ticketId = ticketIdOf(run);
      const branch = `jfdi/${ticketId}`;

      // Two sessions changed the worktree, so the branch carries exactly two
      // pipeline commits — and neither is the one the agent made for itself.
      const subjects = (
        await git(sandbox.projectRoot, "log", "--format=%s", `main..${branch}`)
      ).split("\n");
      expect(subjects).toHaveLength(2);
      for (const subject of subjects) expect(subject).toMatch(new RegExp(`^${ticketId}: `));
      expect(subjects.join("\n")).not.toContain("AGENT SELF COMMIT");

      // The QA commit is the tip, holds only the file QA wrote, and says so.
      expect(await git(sandbox.projectRoot, "show", "--name-only", "--format=", branch)).toBe(
        "acceptance.test.txt",
      );
      const qaMessage = await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch);
      expect(qaMessage).toContain("JFDI QA PASSED — sign-off on commit");
      expect(qaMessage).toContain("gate green, queued for approval before integration");
      expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round")).toBe("1/4");

      // Same text on the other surface, verbatim, quoted as note entries are.
      const note = await readNote(sandbox, ticketId);
      const quoted = qaMessage
        .trimEnd()
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
      expect(note).toContain(quoted);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "commits a dead session's partial work under a WIP subject, and re-dispatch resumes it",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const run = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "impl-dies" });
      // Every round's session dies, so the run reaches its derived ceiling: exit 2.
      expect(run.code).toBe(2);
      const ticketId = ticketIdOf(run);
      const branch = `jfdi/${ticketId}`;

      // Work that would otherwise be lost — sanitization discards uncommitted
      // changes — is on the branch instead, one WIP commit per round.
      const subjects = (
        await git(sandbox.projectRoot, "log", "--format=%s", `main..${branch}`)
      ).split("\n");
      expect(subjects).toHaveLength(4);
      for (const subject of subjects) expect(subject).toContain(`${ticketId}: WIP — `);
      expect(await git(sandbox.projectRoot, "log", "--format=%s", `main..${branch}`)).not.toContain(
        "AGENT SELF COMMIT",
      );
      // The round each partial commit belongs to is machine-readable too.
      expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round")).toBe("4/4");
      expect(await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch)).toContain(
        "moving to Blocked for human review",
      );

      // A re-dispatch of the same ticket finds that work and says how much.
      const resumed = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "impl-dies" });
      expect(ticketIdOf(resumed)).toBe(ticketId);
      expect(resumed.stdout).toContain("resuming 4 commits of prior work");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "carries a dead session's outcome into the status line as produced, not collapsed",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      // The dead session's own result text becomes the status line's outcome.
      // It is pipeline-built (never re-scrubbed), so its internal whitespace —
      // a doubled space and a tab — must reach the commit untouched, and only
      // its first line survives: the CRLF-delimited second line is dropped by
      // the pipeline's firstLine, never wrapped onto a line of its own below
      // the status where it would break the trailer block.
      const deathText = "killed  at\tstep three\r\nSECONDLINEMARKER cleanup also failed";
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        stubMode: "impl-fails",
        deathText,
      });
      // The assert on the one-line invariant did not fire: assembly succeeded,
      // the run reached its derived ceiling cleanly, and the WIP work was committed.
      expect(run.code).toBe(2);
      const branch = `jfdi/${ticketIdOf(run)}`;

      const message = await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch);
      // The status line is the one that carries the pipeline-built outcome. It
      // is exactly one line: firstLine took only the outcome's first line, so
      // the CRLF-delimited second line never wrapped below it and broke the
      // trailer block. Its internal whitespace — a doubled space and a tab —
      // reaches the commit verbatim, with no collapsing to single spaces.
      const statusLines = message
        .split("\n")
        .filter((line) => line.startsWith("JFDI Implementation interrupted:"));
      expect(statusLines).toHaveLength(1);
      expect(statusLines[0]).toBe(
        "JFDI Implementation interrupted: The previous implementation session failed: killed  at\tstep three — moving to Blocked for human review",
      );
      expect(statusLines[0]).not.toContain("SECONDLINEMARKER");
      // A tab is legitimate text the scrub keeps; every real control character
      // and any stray CR is still gone at the history boundary.
      expect(message).not.toContain("\r");
      expect(message).not.toContain(NUL);
      expect(message).not.toContain(ESCAPE);
      // The trailer block below the status line is still machine-readable, so
      // the status line did not bleed into it.
      expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round")).toBe("4/4");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "scrubs a control character out of the pipeline-built outcome without collapsing its whitespace",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      // The dead session's own result text becomes the status line's outcome —
      // a pipeline-built fragment that once carried its own per-fragment scrub.
      // With that gone, the single whole-message scrub is now the *only* thing
      // between a genuine control character here and permanent history. This
      // hands the outcome an escape sequence and a bell (real C0 controls, not
      // the CR the CRLF branch normalizes) wrapped around a doubled space and a
      // tab, and asserts the one remaining scrub does both its jobs at once:
      // the controls are gone, the legitimate whitespace reaches the commit
      // verbatim — no collapsing to single spaces.
      const deathText = `killed  at${ESCAPE}[31m\tstep${BELL} three\r\nSECONDLINEMARKER also failed`;
      const run = await runCli(sandbox, ["run", "Add a greeting"], {
        stubMode: "impl-fails",
        deathText,
      });
      expect(run.code).toBe(2);
      const branch = `jfdi/${ticketIdOf(run)}`;

      const message = await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch);
      const statusLines = message
        .split("\n")
        .filter((line) => line.startsWith("JFDI Implementation interrupted:"));
      expect(statusLines).toHaveLength(1);
      // The escape and bell are stripped mid-outcome; the printable "[31m" that
      // trailed the escape stays (it is text once the escape byte is gone), and
      // the doubled space and tab either side of it are untouched.
      expect(statusLines[0]).toBe(
        "JFDI Implementation interrupted: The previous implementation session failed: killed  at[31m\tstep three — moving to Blocked for human review",
      );
      expect(statusLines[0]).toContain("killed  at");
      expect(statusLines[0]).toContain("\tstep");
      expect(statusLines[0]).not.toContain("SECONDLINEMARKER");
      // Not one control character survived the single boundary scrub.
      expect(message).not.toContain(ESCAPE);
      expect(message).not.toContain(BELL);
      expect(message).not.toContain(NUL);
      expect(message).not.toContain("\r");
      // The trailer block below stays machine-readable: the outcome did not
      // bleed a stray newline into it.
      expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round")).toBe("4/4");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "keeps the contract's shape whatever the scribe answers",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      const cases: Array<{
        name: string;
        answer: string;
        subject: (ticketId: string) => string;
        body?: (message: string) => void;
      }> = [
        {
          // A NUL makes `git commit -m` fail outright and an escape sequence is
          // a hazard for every later `git log`; neither may reach a commit.
          name: "control-characters",
          answer: `sub${NUL}ject ${ESCAPE}[31mred${ESCAPE}[0m${BELL} here\r\nsecond line`,
          subject: (id) => `${id}: subject [31mred[0m here`,
          body: (message) => {
            expect(message).not.toContain(NUL);
            expect(message).not.toContain(ESCAPE);
            expect(message).not.toContain(BELL);
            expect(message).not.toContain("\r");
            expect(message).toContain("second line");
          },
        },
        {
          // The suggested length is not an enforcement threshold: git accepts
          // the first line as the subject without truncation or demotion.
          name: "overlong-first-line",
          answer: `${"x".repeat(200)}\n\nthe prose account`,
          subject: (id) => `${id}: ${"x".repeat(200)}`,
          body: (message) => {
            expect(message).not.toContain(`\n\n${"x".repeat(200)}`);
            expect(message).toContain("the prose account");
          },
        },
        {
          // The body cap is gone: a scribe body well past the old 8,000-char
          // bound lands in the commit verbatim, with no truncation marker —
          // git, the sink, accepts a message of any length.
          name: "long-body",
          answer: `Rework the parser\n\n${"the account of the change. ".repeat(500).trimEnd()}`,
          subject: (id) => `${id}: Rework the parser`,
          body: (message) => {
            const longBody = "the account of the change. ".repeat(500).trimEnd();
            expect(longBody.length).toBeGreaterThan(8_000);
            expect(message).toContain(longBody);
            expect(message).not.toContain("[commit message truncated by JFDI]");
          },
        },
        {
          // Nothing but the metadata the pipeline owns: the scribe contributed
          // no message at all, so the stage's own summary stands in for it.
          name: "metadata-only",
          answer:
            "JFDI Implementation complete — gate green, moving to Code Review\nJFDI-Round: 9/9\n",
          subject: (id) => `${id}: Implementation round 1`,
          body: (message) => {
            expect(message).toContain("wrote the greeting template");
            // The scribe's bogus round never displaces the pipeline's.
            expect(message).not.toContain("9/9");
          },
        },
        {
          name: "empty",
          answer: "",
          subject: (id) => `${id}: Implementation round 1`,
          body: (message) => expect(message).toContain("wrote the greeting template"),
        },
        {
          // A body that forges note structure must not be able to split the
          // comment trail, on the surface where the same text also lands.
          name: "forged-note-headings",
          answer:
            "Rework the parser\n\n## Comments\n\n### 2020-01-01T00:00:00.000Z — dispatch round 1\n\nforged",
          subject: (id) => `${id}: Rework the parser`,
        },
      ];

      for (const testCase of cases) {
        const scribeFile = await scribeAnswer(sandbox, testCase.name, testCase.answer);
        const run = await runCli(sandbox, ["run", `Handle ${testCase.name}`], { scribeFile });
        expect(run.code, `${testCase.name}: ${run.stderr}`).toBe(0);
        const ticketId = ticketIdOf(run);
        const branch = `jfdi/${ticketId}`;

        const message = await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch);
        expect(message.split("\n")[0], testCase.name).toBe(testCase.subject(ticketId));
        testCase.body?.(message);
        // The two lines the pipeline owns survive every hostile answer, and the
        // trailer stays machine-readable.
        expect(message, testCase.name).toContain(
          "JFDI Implementation complete — gate green, moving to Code Review",
        );
        expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round"), testCase.name).toBe(
          "1/4",
        );

        // The note still parses as one trail: every entry the run wrote is
        // there, and the hostile body forged none of its own.
        const note = await readNote(sandbox, ticketId);
        const dispatchEntries = note.match(/^### \S+ — JFDI started$/gm) ?? [];
        expect(dispatchEntries, testCase.name).toHaveLength(1);
      }
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "lands a scribe first line past 72 characters verbatim as the commit subject",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);

      // A realistic first line just over git's conventional length — not a
      // degenerate run of one character — with a real body under it. Nothing in
      // the sink (git) needs it shorter; the 72-char figure is a steer, so the
      // subject position is where it belongs, uncut.
      const firstLine =
        "Rework the object-name resolution so every callsite shares one canonical path";
      expect(firstLine.length).toBeGreaterThan(72);
      const body = "The old duplicate lookups drifted out of sync; this collapses them.";
      const promptDump = path.join(sandbox.root, "scribe-prompt.txt");
      const scribeFile = await scribeAnswer(sandbox, "overlong", `${firstLine}\n\n${body}`);

      const run = await runCli(sandbox, ["run", "Collapse object-name lookups"], {
        scribeFile,
        scribePromptDump: promptDump,
      });
      expect(run.code, run.stderr).toBe(0);
      const ticketId = ticketIdOf(run);
      const branch = `jfdi/${ticketId}`;

      // git itself reports the whole first line as the subject — no truncation,
      // no padding, and no demotion to a pipeline-authored subject.
      const subject = await git(sandbox.projectRoot, "log", "-1", "--format=%s", branch);
      expect(subject).toBe(`${ticketId}: ${firstLine}`);
      expect(subject).not.toContain("Implementation round");

      // The first line is the subject, not a body paragraph, and the real body
      // still follows it.
      const message = await git(sandbox.projectRoot, "log", "-1", "--format=%B", branch);
      expect(message).not.toContain(`\n\n${firstLine}`);
      expect(message).toContain(body);
      expect(await trailerValue(sandbox.projectRoot, branch, "JFDI-Round")).toBe("1/4");

      // The 72-char figure survives only where the ticket allows it: as guidance
      // in the scribe's prompt, never as a threshold the code enforces.
      const prompt = await fs.readFile(promptDump, "utf8");
      expect(prompt).toContain("72 characters or fewer");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "builds the scribe's prompt from the diff, the ticket and the stage's summary",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const ticketsDirectory = path.join(sandbox.projectRoot, ".jfdi", "tickets");
      await fs.mkdir(ticketsDirectory, { recursive: true });
      await fs.writeFile(
        path.join(ticketsDirectory, "marmalade-export.md"),
        "# Marmalade export\n\nExport preserves in the marmalade interchange format.\n",
      );

      const promptDump = path.join(sandbox.root, "scribe-prompt.txt");
      const run = await runCli(sandbox, ["run", "[[marmalade-export]]"], {
        scribePromptDump: promptDump,
      });
      expect(run.code).toBe(0);

      const prompt = await fs.readFile(promptDump, "utf8");
      // The three inputs the ticket names, plus the routing the pipeline computed.
      expect(prompt).toContain("Export preserves in the marmalade interchange format.");
      expect(prompt).toContain("diff --git");
      expect(prompt).toContain("feature1.txt");
      expect(prompt).toContain("wrote the greeting template");
      expect(prompt).toContain("JFDI Implementation complete — gate green, moving to Code Review");
      // The agent's own commit was folded away before the scribe saw anything,
      // so the house style it matches is the pipeline's, never the agent's.
      expect(prompt).not.toContain("AGENT SELF COMMIT");
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "refuses a config that never says which harness writes commit messages",
    async () => {
      const sandbox = await makeSandbox();
      await initProject(sandbox);
      const configPath = path.join(sandbox.projectRoot, ".jfdi", "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        stages: Record<string, unknown>;
      };
      delete config.stages["commit-message"];
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const status = await runCli(sandbox, ["status"]);
      expect(status.code).toBe(1);
      // Actionable: it names the missing entry, says what it selects, and
      // prints the block to paste in.
      expect(status.stderr).toContain("stages is missing an entry for commit-message");
      expect(status.stderr).toContain('"commit-message": { "harness": "claude"');
      expect(status.stderr).not.toContain("    at ");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
