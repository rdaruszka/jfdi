/**
 * Acceptance for the `SessionUsage` cost/token channel after the
 * harness-contract-surface cut.
 *
 * The ticket deleted `SessionUsage.reasoningTokens` — a field the codex harness
 * wrote and nothing summed. The acceptance criterion is that every *remaining*
 * field on the contract still has a production reader; for `SessionUsage`, that
 * reader is the usage aggregation the pipeline folds into `state.json` and
 * `jfdi status --json` prints (`totalCostUsd`, `totalTokens`). A cut that
 * nicked the surviving fields, or an aggregation that had quietly depended on
 * the deleted one, would still compile — the risk is behavioral, not typed.
 *
 * The sibling `harness-session-continuation.e2e.test.ts` pins the *other*
 * channel the ticket touched (the session id, formerly a public event). This
 * one drives a full run whose Claude stub reports real dollars and tokens on
 * its result line, then reads them back out of `status --json` — proving the
 * usage fields flow harness → pipeline → state → CLI, end to end, after the cut.
 *
 * Every stage is pointed at the (cost-reporting) Claude harness so the grand
 * total carries a dollar figure: `state.json` reports `costUsd: null` the moment
 * any one session is unpriced (the deliberate "no honest figure" signal), and
 * the default config's Codex reviewer is unpriced — that null is designed, not a
 * regression, so the test removes it from the picture to assert on real dollars.
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

/** Dollars and tokens the Claude stub reports on every result line. */
const STUB_COST_USD = 0.05;
const STUB_INPUT_TOKENS = 100;
const STUB_OUTPUT_TOKENS = 50;

/**
 * Shared body: write the verdict the prompt names. Implementation commits a
 * feature file so there is a diff to hand off; code review passes on round 1 so
 * the run lands in a single round.
 */
const STUB_BODY = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
let resultText = "done";
if (prompt.includes("Write the commit message")) {
  resultText = "stub subject\\n\\nWhat the session did.";
}
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: [], observations: [], testsAdded: "unit tests" };
  } else if (stage === "code-review") {
    verdict = { verdict: "pass", testsAdded: "e2e tests" };
  } else {
    verdict = { verdict: "pass", testsAdded: "e2e tests" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

/**
 * Claude stub (implementation, QA, scribe): reports dollars and tokens on its
 * result line exactly as Claude Code does, so the pipeline's usage aggregation
 * has real figures to fold into state.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const cliName = "claude";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: resultText,
  total_cost_usd: ${STUB_COST_USD},
  usage: { input_tokens: ${STUB_INPUT_TOKENS}, output_tokens: ${STUB_OUTPUT_TOKENS}, cache_read_input_tokens: 0 },
}) + "\\n");
`;

/** Codex stub (code review): announces a thread and passes. */
const STUB_CODEX = `#!/usr/bin/env node
const cliName = "codex";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }) + "\\n");
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  binDir: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-usage-surface-"));
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

  return { root, project, home, jfdiHome: path.join(home, ".jfdi"), binDir };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
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

interface TicketState {
  /** Null when any session was unpriced — see usageTotals. */
  totalCostUsd: number | null;
  totalTokens: number;
  totalAgentMs: number;
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("harness usage surface, end to end", () => {
  it(
    "flows SessionUsage cost and tokens from the harness through to status --json",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // Point every stage at Claude so all sessions report a price and the grand
      // total is a real dollar figure rather than the null a mixed-provider run
      // yields (the default reviewer is unpriced Codex).
      const configPath = path.join(sandbox.project, ".jfdi", "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        stages: Record<string, { harness: string; model?: string; effort?: string }>;
      };
      config.stages["code-review"] = {
        harness: "claude",
        model: "claude-opus-4-8",
        effort: "high",
      };
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);

      const status = await runCli(sandbox, ["status", "--json"]);
      expect(status.code, `${status.stdout}${status.stderr}`).toBe(0);
      const state = JSON.parse(status.stdout) as { tickets: Record<string, TicketState> };
      const tickets = Object.values(state.tickets);
      expect(tickets.length).toBeGreaterThan(0);

      // Every session reported $0.05 and 150 tokens; the aggregation reads
      // exactly the SessionUsage fields the cut left intact (costUsd,
      // inputTokens, outputTokens) and sums them into the ticket totals. A cut
      // that damaged those fields — or an aggregation that had leaned on the
      // deleted reasoningTokens — would surface null or zero here.
      const ticket = tickets.find((entry) => entry.totalCostUsd !== null);
      expect(ticket, `no ticket carried a dollar figure: ${status.stdout}`).toBeDefined();
      if (ticket === undefined) throw new Error("unreachable");
      // At least one Claude session's dollars and tokens survived the round trip.
      expect(ticket.totalCostUsd).toBeGreaterThanOrEqual(STUB_COST_USD);
      expect(ticket.totalTokens).toBeGreaterThanOrEqual(STUB_INPUT_TOKENS + STUB_OUTPUT_TOKENS);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
