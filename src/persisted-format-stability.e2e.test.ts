/**
 * End-to-end guard for the internal-naming sweep's out-of-scope invariant:
 * "`events.jsonl`, report.json, and history.json written by the new build are
 * key-for-key identical to the old build's." The sweep renamed local
 * variables, parameters and fields that feed `JSON.stringify` (`stateDir` →
 * `stateDirectory`, `runDir` → `runDirectory`, `repoRoot` → `projectRoot`, …);
 * none of those names may leak into a persisted key, because there is no event
 * versioning story and a reader of an existing `~/.jfdi/projects/<key>/` must
 * still parse files a renamed build writes.
 *
 * A property-name-only diff is invisible to a passing gate — the code compiles
 * and every unit test still constructs the same in-memory objects. Only reading
 * the bytes a real run writes catches it. So this drives the built CLI
 * (`dist/index.js`) end to end in a scratch repo with stub agents, then pins the
 * complete recursive key structure of each persisted file. The pinned sets were
 * captured from the pre-sweep (`main`) build and confirmed byte-for-byte equal
 * to this branch's build; any future change that renames a persisted key must
 * edit these constants deliberately — which is the "its own ticket" gate the
 * sweep's scope note calls for.
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

/**
 * The agent both stubbed CLIs play. Implementation commits a file so the
 * pipeline has a real commit to review, gate and merge. When `FAIL_CODE_REVIEW`
 * is set it fails Code Review every round, so the run exhausts that rejection budget and
 * leaves a *populated* history.json (a clean run writes an empty list, which
 * would not exercise the FeedbackItem keys).
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented" };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else if (stage === "code-review" && process.env.FAIL_CODE_REVIEW) {
    verdict = { verdict: "fail", feedback: "naming still wrong, fix it" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

/** Complete recursive key structure the persisted files must keep, key-for-key. */
const EXPECTED_EVENT_KEYS = [
  ".data",
  ".data.branch",
  ".data.costUsd",
  ".data.durationMs",
  ".data.effort",
  ".data.harness",
  ".data.model",
  ".data.modelSource",
  ".data.ok",
  ".data.round",
  ".data.runAgentMs",
  ".data.runCostUsd",
  ".data.runTokens",
  ".data.stage",
  ".data.text",
  ".data.title",
  ".data.tokens",
  ".data.verdict",
  ".origin",
  ".ticketId",
  ".ts",
  ".type",
];

const EXPECTED_REPORT_KEYS = [
  ".commit",
  ".decisions",
  ".elapsedMs",
  ".observations",
  ".rounds",
  ".summary",
  ".testsAdded",
  ".usageRows",
  ".usageRows[].cachedInputTokens",
  ".usageRows[].durationMs",
  ".usageRows[].estimatedCostSessions",
  ".usageRows[].inputTokens",
  ".usageRows[].knownCostUsd",
  ".usageRows[].label",
  ".usageRows[].models",
  ".usageRows[].models[].name",
  ".usageRows[].models[].source",
  ".usageRows[].outputTokens",
  ".usageRows[].sessions",
  ".usageRows[].unknownCostSessions",
];

/** state.json keys with the concrete ticket id normalised to `<ticket>`. */
const EXPECTED_STATE_KEYS = [
  ".integrationQueue",
  ".tickets",
  ".tickets.<ticket>",
  ".tickets.<ticket>.branch",
  ".tickets.<ticket>.id",
  ".tickets.<ticket>.lastActivity",
  ".tickets.<ticket>.lastEventTs",
  ".tickets.<ticket>.round",
  ".tickets.<ticket>.stage",
  ".tickets.<ticket>.status",
  ".tickets.<ticket>.title",
  ".tickets.<ticket>.totalAgentMs",
  ".tickets.<ticket>.totalCostUsd",
  ".tickets.<ticket>.totalTokens",
  ".updatedAt",
];

const EXPECTED_HISTORY_KEYS = ["[].feedback", "[].round", "[].run", "[].source"];

/** Every key path in an object/array tree; values ignored, array elements unioned. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((element) => keyPaths(element, `${prefix}[]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      `${prefix}.${key}`,
      ...keyPaths(child, `${prefix}.${key}`),
    ]);
  }
  return [];
}

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort();

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  stateDirectory: string;
  executableDirectory: string;
}

const sandboxes: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-persist-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), STUB_AGENT, { mode: 0o755 });
  }
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");
  const jfdiHome = path.join(home, ".jfdi");
  return {
    root,
    projectRoot: project,
    home,
    jfdiHome,
    stateDirectory: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
    executableDirectory,
  };
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    ...extraEnv,
  };
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env,
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "" };
  }
}

function ticketIdOf(stdout: string): string {
  const match = /ticket: (\S+)/.exec(stdout);
  if (!match?.[1]) throw new Error(`no ticket id in output: ${stdout}`);
  return match[1];
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("persisted files keep their exact key structure across the naming sweep", () => {
  it("writes events.jsonl, report.json and state.json with the pinned keys", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
    const run = await runCli(sandbox, ["run", "Add a greeting"]);
    expect(run.code).toBe(0);
    const ticketId = ticketIdOf(run.stdout);

    const eventsRaw = await fs.readFile(path.join(sandbox.stateDirectory, "events.jsonl"), "utf8");
    const eventKeys = uniqueSorted(
      eventsRaw
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => keyPaths(JSON.parse(line))),
    );
    expect(eventKeys).toEqual(EXPECTED_EVENT_KEYS);

    const report: unknown = JSON.parse(
      await fs.readFile(path.join(sandbox.stateDirectory, "runs", ticketId, "report.json"), "utf8"),
    );
    expect(uniqueSorted(keyPaths(report))).toEqual(EXPECTED_REPORT_KEYS);

    const state: unknown = JSON.parse(
      await fs.readFile(path.join(sandbox.stateDirectory, "state.json"), "utf8"),
    );
    const normalisedStateKeys = uniqueSorted(
      keyPaths(state).map((key) => key.split(ticketId).join("<ticket>")),
    );
    expect(normalisedStateKeys).toEqual(EXPECTED_STATE_KEYS);
  }, 120_000);

  it("writes a populated history.json with the pinned FeedbackItem keys", async () => {
    const sandbox = await makeSandbox();
    expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
    // Code Review fails every round → its rejection budget exhausts → feedback persists.
    const run = await runCli(sandbox, ["run", "Add a greeting"], { FAIL_CODE_REVIEW: "1" });
    const ticketId = ticketIdOf(run.stdout);

    const history: unknown = JSON.parse(
      await fs.readFile(
        path.join(sandbox.stateDirectory, "runs", ticketId, "run-1", "history.json"),
        "utf8",
      ),
    );
    expect(Array.isArray(history)).toBe(true);
    expect((history as unknown[]).length).toBeGreaterThan(0);
    expect(uniqueSorted(keyPaths(history))).toEqual(EXPECTED_HISTORY_KEYS);
  }, 120_000);
});
