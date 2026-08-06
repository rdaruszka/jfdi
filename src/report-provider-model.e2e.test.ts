/**
 * Acceptance for "report the provider-confirmed model that did the work",
 * driven through the built CLI against real harness stubs — not the FakeHarness
 * the unit suite injects a `SessionUsage.model` through.
 *
 * The ticket's surface is the per-stage Model column the ready-to-merge and
 * merged comments carry. This test runs a full pipeline whose Claude stub emits
 * a *provider-reported* model on its `result` line (the shape Claude Code uses),
 * distinct from the configured model, then reads the rendered stage table back
 * out of the ticket note. It pins two things the real artifact must honour:
 *
 *   1. Every stage row names a model, honestly labeled by its source — so the
 *      configured value is never conflated with a provider-confirmed one.
 *   2. What actually reaches the table when only the *real* Claude harness runs:
 *      the distinct provider model, labeled `(provider-confirmed)`.
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

/** The model every stage is configured to run (config.json `stages[*].model`). */
const CONFIGURED_MODEL = "opus-configured-4-8";
/**
 * The model the Claude stub reports the provider *actually* ran — deliberately
 * different from CONFIGURED_MODEL so a config/provider mismatch would be visible
 * if the harness surfaced it.
 */
const PROVIDER_MODEL = "claude-opus-4-8-provider-ran";

/** Shared verdict-writing body (matches the existing usage-surface e2e stub). */
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
  } else {
    verdict = { verdict: "pass", testsAdded: "e2e tests" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
`;

/**
 * Claude stub for every stage. Reports dollars, tokens, AND a provider model on
 * its result line under `modelUsage`, keyed by the model id Claude Code ran.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
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
  modelUsage: { "${PROVIDER_MODEL}": {} },
  total_cost_usd: 0.05,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
}) + "\\n");
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
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-provider-model-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "claude"), STUB_CLAUDE, { mode: 0o755 });
  // Codex is never invoked (all stages point at Claude) but must exist on PATH.
  await fs.writeFile(path.join(binDir, "codex"), STUB_CLAUDE, { mode: 0o755 });

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

/** The one ticket note `jfdi run "<text>"` writes, read from the scratch repo. */
async function readTicketNote(sandbox: Sandbox): Promise<string> {
  const dir = path.join(sandbox.project, ".jfdi", "tickets");
  const entries = await fs.readdir(dir);
  const note = entries.find((name) => name.endsWith(".md"));
  if (note === undefined) throw new Error(`no ticket note under ${dir}: ${entries.join(", ")}`);
  return fs.readFile(path.join(dir, note), "utf8");
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("provider-confirmed model reporting, end to end", () => {
  it(
    "names a model per stage in the ready-to-merge comment's table, labeled by source",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

      // Point every stage at the Claude stub with a known configured model.
      const configPath = path.join(sandbox.project, ".jfdi", "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        stages: Record<string, { harness: string; model?: string; effort?: string }>;
      };
      for (const stage of Object.keys(config.stages)) {
        config.stages[stage] = { harness: "claude", model: CONFIGURED_MODEL, effort: "high" };
      }
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const run = await runCli(sandbox, ["run", "Add a greeting"]);
      expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);

      const note = await readTicketNote(sandbox);

      // The stage table gained a Model column, and it names a model per stage.
      expect(note).toContain("| Stage | Model | Sessions | Time | Cost |");

      // Every stage row carries a source-labeled model — the two provenances are
      // never conflated (a bare model name with no "(provider-confirmed)" or
      // "(configured)" tag would mean the column can't tell them apart).
      const stageRows = note
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .filter((line) => /^\| (Implementation|Code Review|QA|Scribe) \|/.test(line));
      expect(stageRows.length).toBeGreaterThan(0);
      for (const row of stageRows) {
        expect(row, `stage row lacks a source-labeled model: ${row}`).toMatch(
          /\((provider-confirmed|configured)\)/,
        );
      }

      // The provider-confirmed value wins over the deliberately different
      // configured model, making the mismatch visible in the report itself.
      expect(note).toContain(`${PROVIDER_MODEL} (provider-confirmed)`);
      expect(note).not.toContain(`${CONFIGURED_MODEL} (configured)`);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
