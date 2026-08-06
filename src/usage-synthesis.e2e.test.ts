/**
 * Regression for the `runHeldSession` usage invariant.
 *
 * The ticket narrowed `runHeldSession` to return usage as a required field and
 * deleted the downstream fallbacks (`?? zeroUsage()` in the pipeline, the
 * conditional usage spread in integration) that guarded a state the pipeline
 * makes impossible: every session's usage is synthesized by `withDuration` from
 * the pipeline's own wall-clock, even when the provider reports none. Those
 * fallbacks were dead because the condition was always true — so the risk this
 * pins is not the deleted branches (behaviour-identical by construction) but the
 * *invariant* that now carries the type: a provider that omits usage entirely
 * still yields a run whose agent time is the real measured duration, whose cost
 * is the honest `null`, and whose tokens are zero — never a crash, never a
 * dropped figure.
 *
 * The sibling `harness-usage-surface.e2e.test.ts` drives the *reported*-usage
 * case (Claude stub emits dollars and tokens). This one drives its complement:
 * stubs whose result lines carry no `total_cost_usd` and no `usage` object, the
 * shape a provider that crashed early or never priced the session produces. If
 * `withDuration` stopped synthesizing — or a zero-usage fallback crept back in —
 * `totalAgentMs` would read 0 here instead of the measured duration.
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
 * Shared body: write the verdict the prompt names. Implementation commits a
 * feature file so there is a diff to hand off; both reviews pass on round 1 so
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
 * Claude stub whose result line reports NO `total_cost_usd` and NO `usage`
 * object — the exact shape whose downstream fallbacks the ticket deleted. The
 * pipeline must synthesize usage from its own clock regardless.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

/** Codex stub (default code-review): announces a thread and passes, no usage. */
const STUB_CODEX = `#!/usr/bin/env node
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
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-usage-synthesis-"));
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
  /** Null the moment any session was unpriced — every session here is. */
  totalCostUsd: number | null;
  totalTokens: number;
  /** Pipeline-measured agent wall-clock, summed across the run's sessions. */
  totalAgentMs: number;
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("usage synthesis when the provider reports none, end to end", () => {
  it(
    "a run whose sessions omit usage still passes, with synthesized agent time, null cost, zero tokens",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // The full pipeline runs against providers that never report usage — the
      // state the deleted fallbacks pretended to guard. The invariant is that
      // this is not a degraded run: it reaches "ready to merge" like any other.
      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);

      const status = await runCli(sandbox, ["status", "--json"]);
      expect(status.code, `${status.stdout}${status.stderr}`).toBe(0);
      const state = JSON.parse(status.stdout) as { tickets: Record<string, TicketState> };
      const tickets = Object.values(state.tickets);
      expect(tickets.length).toBe(1);
      const ticket = tickets[0];
      if (ticket === undefined) throw new Error("unreachable: asserted one ticket above");

      // Cost is the honest null (no provider priced any session) and tokens are
      // zero — the synthesized SessionUsage's own values, not a fabricated
      // figure.
      expect(ticket.totalCostUsd).toBeNull();
      expect(ticket.totalTokens).toBe(0);
      // The teeth: duration is the pipeline's own measure, present on every
      // session even when the provider reports nothing. A zero here would mean
      // synthesis was lost — the exact fallback-shaped regression this pins.
      expect(ticket.totalAgentMs).toBeGreaterThan(0);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
