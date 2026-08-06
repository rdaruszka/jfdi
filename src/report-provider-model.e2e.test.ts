/**
 * Acceptance for "report the provider-confirmed model that did the work",
 * driven through the built CLI against real harness stubs — not the FakeHarness
 * the unit suite injects a `SessionUsage.model` through.
 *
 * The ticket's surface is the per-stage Model column the Integration comment
 * carries. This test runs a full pipeline whose Claude stub emits
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

/**
 * Mixed-provenance stub: reports `modelUsage` on every stage EXCEPT code review,
 * which reports none. Exercises, through the real artifact, a single run whose
 * table carries both a provider-confirmed row and a configured-fallback row —
 * proving the two sources coexist without being conflated.
 */
const STUB_CLAUDE_MIXED = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
const stageMatch = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
const stageName = stageMatch ? stageMatch[1].split("/").pop().replace(".verdict.json", "") : "";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
${STUB_BODY}
const resultLine = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: resultText,
  total_cost_usd: 0.05,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
};
if (stageName !== "code-review") resultLine.modelUsage = { "${PROVIDER_MODEL}": {} };
process.stdout.write(JSON.stringify(resultLine) + "\\n");
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  binDir: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(stub: string = STUB_CLAUDE): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-provider-model-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "claude"), stub, { mode: 0o755 });
  // Codex is never invoked (all stages point at Claude) but must exist on PATH.
  await fs.writeFile(path.join(binDir, "codex"), stub, { mode: 0o755 });

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

/** The id of the one ticket `jfdi run` minted, from its note's file name. */
async function ticketIdOf(sandbox: Sandbox): Promise<string> {
  const dir = path.join(sandbox.project, ".jfdi", "tickets");
  const entries = await fs.readdir(dir);
  const note = entries.find((name) => name.endsWith(".md"));
  if (note === undefined) throw new Error(`no ticket note under ${dir}: ${entries.join(", ")}`);
  return note.replace(/\.md$/, "");
}

/**
 * Every `stage_end` event the run emitted, read from the project's `events.jsonl`
 * under JFDI_HOME. The project-key subdirectory is derived, so find it rather
 * than reconstruct it.
 */
async function readStageEnds(
  sandbox: Sandbox,
): Promise<Array<{ stage?: string; model?: string; modelSource?: string }>> {
  const projectsDir = path.join(sandbox.jfdiHome, "projects");
  const keys = await fs.readdir(projectsDir);
  if (keys.length !== 1) throw new Error(`expected one project key, got: ${keys.join(", ")}`);
  const raw = await fs.readFile(path.join(projectsDir, keys[0], "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; data?: Record<string, unknown> })
    .filter((event) => event.type === "stage_end")
    .map((event) => ({
      stage: event.data?.stage as string | undefined,
      model: event.data?.model as string | undefined,
      modelSource: event.data?.modelSource as string | undefined,
    }));
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("provider-confirmed model reporting, end to end", () => {
  it(
    "names a model per stage in the Integration comment's table, labeled by source",
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
      const merge = await runCli(sandbox, ["merge", await ticketIdOf(sandbox)]);
      expect(merge.code, `${merge.stdout}${merge.stderr}`).toBe(0);

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

  it(
    "shows provider-confirmed and configured rows side by side when only some stages report a model",
    async () => {
      const sandbox = await makeSandbox(STUB_CLAUDE_MIXED);
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

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
      const merge = await runCli(sandbox, ["merge", await ticketIdOf(sandbox)]);
      expect(merge.code, `${merge.stdout}${merge.stderr}`).toBe(0);

      const note = await readTicketNote(sandbox);

      // Implementation reported a model → provider-confirmed; code review reported
      // none → the honest configured fallback. Both provenances appear in one
      // table without either masking the other.
      const rowFor = (label: string) =>
        note
          .split("\n")
          .map((line) => line.replace(/^>\s?/, ""))
          .find((line) => line.startsWith(`| ${label} |`));
      expect(rowFor("Implementation")).toContain(`${PROVIDER_MODEL} (provider-confirmed)`);
      expect(rowFor("Code Review")).toContain(`${CONFIGURED_MODEL} (configured)`);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "carries the provider-confirmed model into the merged comment and stage_end events",
    async () => {
      const sandbox = await makeSandbox();
      expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);

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

      // stage_end events name the provider-confirmed model, never the configured
      // one, so `jfdi logs` and the TUI stream both learn what actually ran.
      const stageEnds = await readStageEnds(sandbox);
      expect(stageEnds.length).toBeGreaterThan(0);
      for (const stageEnd of stageEnds) {
        expect(stageEnd, `stage_end missing provider model: ${JSON.stringify(stageEnd)}`).toEqual({
          stage: stageEnd.stage,
          model: PROVIDER_MODEL,
          modelSource: "provider",
        });
      }

      // The merged comment (integration path, not just ready-to-merge) also names
      // the provider-confirmed model per stage.
      const ticketId = await ticketIdOf(sandbox);
      const merge = await runCli(sandbox, ["merge", ticketId]);
      expect(merge.code, `${merge.stdout}${merge.stderr}`).toBe(0);

      const note = await readTicketNote(sandbox);
      const mergedMarker = "JFDI Integration merged";
      const mergedIndex = note.indexOf(mergedMarker);
      expect(mergedIndex, "no merged transition comment in the note").toBeGreaterThanOrEqual(0);
      const mergedComment = note.slice(mergedIndex);
      expect(mergedComment).toContain("| Stage | Model | Sessions | Time | Cost |");
      expect(mergedComment).toContain(`${PROVIDER_MODEL} (provider-confirmed)`);
      expect(mergedComment).not.toContain(`${CONFIGURED_MODEL} (configured)`);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
