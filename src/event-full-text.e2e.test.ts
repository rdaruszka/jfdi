/**
 * Acceptance for event-display-truncation: producers pass detail, activity and
 * reason text through *whole*; the TUI renderer is the only thing that
 * truncates (via `wrap="truncate"`, unchanged here).
 *
 * The unit suites pin the mapping functions (mapClaudeLine, classifyFailure,
 * firstLine) in isolation, but nothing proved from the *outside* that a long
 * detail line a stub agent emits survives the whole pipeline into
 * `events.jsonl` at full length. These tests do: they drive the built
 * `dist/index.js` in a scratch repo with a stub `claude` that emits activity,
 * tool-detail and escalation text far longer than the five deleted caps
 * (80/160/120/120/100), then assert the persisted event text is byte-identical
 * to what the producer had — no ellipsis, no slice.
 *
 * A regression that re-introduces any producer-side cap would cut one of these
 * long strings and fail here. `JFDI_HOME`/`HOME` stay inside the scratch tree.
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

// All well past every deleted producer-side cap (80/160/120/120/100 chars).
const LONG_TOOL_DETAIL = `pnpm test --filter ${"detail-segment-".repeat(20)}end`;
const LONG_ACTIVITY_LINE = `checking ${"activity-segment-".repeat(20)}end`;
const LONG_QUESTION = `Should auth use OAuth or magic links? ${"decision-context-".repeat(20)}end`;

/**
 * The stub agent. In escalate mode the implementation verdict escalates with a
 * long question; otherwise it emits a long single-line activity text and a
 * long tool-detail command before writing a passing verdict. Every stage after
 * implementation just passes. Neither branch touches the network.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const escalate = process.env.STUB_MODE === "escalate";
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = "stub subject\\n\\nbody";
}
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    if (escalate) {
      verdict = { status: "escalate", question: ${JSON.stringify(LONG_QUESTION)}, recommendation: "Magic links." };
    } else {
      fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
      execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
      execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
      verdict = { status: "done", summary: "implemented" };
    }
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

// Claude stream-json: a long text line, then a long tool-detail line, then the
// verdict-writing body, then the final result.
const STUB_CLAUDE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const isImplementation = /implementation\\.verdict\\.json/.test(prompt) || (prompt.indexOf("verdict.json") === -1);
if (isImplementation && process.env.STUB_MODE !== "escalate") {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: ${JSON.stringify(LONG_ACTIVITY_LINE)} + "\\nsecond line" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: ${JSON.stringify(LONG_TOOL_DETAIL)} } }] } }) + "\\n");
}
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

// The scaffolded config reviews on codex, so a stub must exist even though this
// test only asserts on implementation-stage (claude) narration.
const STUB_CODEX = `#!/usr/bin/env node
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
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-fulltext-"));
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

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("producer-side truncation is gone; event text is whole", () => {
  it(
    "carries the full activity line and full tool detail into events.jsonl",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code).toBe(0);

      const activities = (await readEvents(sandbox))
        .filter((event) => event.type === "session_activity")
        .map((event) => (typeof event.data?.text === "string" ? event.data.text : ""));

      // The first line of the assistant text survives whole (first-line
      // extraction stays; the length slice is gone) — old cap was 120 chars.
      expect(LONG_ACTIVITY_LINE.length).toBeGreaterThan(120);
      expect(activities).toContain(`implementation: ${LONG_ACTIVITY_LINE}`);

      // The tool detail survives whole — old cap was 80 chars, and the old
      // path appended a "..." ellipsis on truncation.
      expect(LONG_TOOL_DETAIL.length).toBeGreaterThan(80);
      expect(activities).toContain(`implementation: Bash ${LONG_TOOL_DETAIL}`);
      expect(activities.some((text) => text.includes("..."))).toBe(false);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "carries the full escalation question onto the blocked event reason",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // Blocked is exit 2; the escalation reason old cap was 120 chars.
      const run = await runCli(sandbox, ["run", "Add a greeting"], { stubMode: "escalate" });
      expect(run.code).toBe(2);

      const blocked = (await readEvents(sandbox)).find((event) => event.type === "blocked");
      expect(LONG_QUESTION.length).toBeGreaterThan(120);
      expect(blocked?.data?.reason).toBe(`escalated: ${LONG_QUESTION}`);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
