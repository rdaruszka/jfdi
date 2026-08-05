/**
 * Acceptance for the ticket note's defined anatomy and the slice of it that
 * reaches a stage prompt.
 *
 * These drive the built CLI (`dist/index.js`) in a scratch repo under the OS
 * temp dir, with stub `claude`/`codex` binaries on PATH that capture the prompt
 * they were handed. That is the only way to see what an agent actually reads:
 * the slice is assembled from a note on disk, rendered into a template, and
 * handed to a subprocess, and a unit test on `ticketSpec` cannot prove the
 * whole chain carries it.
 *
 * Assertions are written against uniquely-named markers planted in the note,
 * matched with plain string search rather than the product's own parser, so a
 * change in how JFDI reads a note cannot make these agree with it by
 * construction.
 *
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const BUILD_TIMEOUT_MS = 180_000;
const PIPELINE_TIMEOUT_MS = 120_000;

/**
 * The agent both stubbed CLIs play. It never talks to the network: it replays a
 * few stream-json lines, copies the prompt it was given into `CAPTURE_DIR`, and
 * writes the verdict file its prompt names. The implementation stage commits,
 * so there is a real commit for the later stages to review and gate.
 *
 * `STUB_DECISIONS` is the JSON array the implementation verdict carries, which
 * is how a test plants decisions for the pipeline to log as comments.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
// Claude passes the prompt after -p; Codex passes it last. One stub answers to
// both names, so a sandbox needs no second script.
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  fs.mkdirSync(process.env.CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(process.env.CAPTURE_DIR + "/" + stage + ".prompt.txt", prompt);
  let verdict;
  if (stage === "implementation") {
    fs.writeFileSync(process.cwd() + "/feature.txt", "the feature\\n");
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-m", "implement"], { cwd: process.cwd() });
    verdict = { status: "done", summary: "implemented", decisions: JSON.parse(process.env.STUB_DECISIONS || "[]") };
  } else if (stage === "integration") {
    verdict = { resolution: "clean" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  stateDir: string;
  binDir: string;
  captureDir: string;
  ticketsDir: string;
}

const sandboxes: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-anatomy-e2e-"));
  const root = await fs.realpath(created);
  sandboxes.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const captureDir = path.join(root, "capture");
  for (const dir of [project, home, binDir, captureDir]) await fs.mkdir(dir, { recursive: true });
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(binDir, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");

  const jfdiHome = path.join(home, ".jfdi");
  const sandbox: Sandbox = {
    root,
    project,
    home,
    jfdiHome,
    stateDir: path.join(jfdiHome, "projects", project.split(path.sep).join("-")),
    binDir,
    captureDir,
    ticketsDir: path.join(project, ".jfdi", "tickets"),
  };
  expect((await runCli(sandbox, ["init", "--bare"])).code).toBe(0);
  return sandbox;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: { decisions?: string[] } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    CAPTURE_DIR: sandbox.captureDir,
    STUB_DECISIONS: JSON.stringify(options.decisions ?? []),
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function capturedPrompt(sandbox: Sandbox, stage: string): Promise<string> {
  return fs.readFile(path.join(sandbox.captureDir, `${stage}.prompt.txt`), "utf8");
}

function readNote(sandbox: Sandbox, id: string): Promise<string> {
  return fs.readFile(path.join(sandbox.ticketsDir, `${id}.md`), "utf8");
}

/** Which of the planted markers a prompt carries — asserted as a whole set. */
function markersIn(prompt: string, markers: string[]): string[] {
  return markers.filter((marker) => prompt.includes(marker));
}

async function eventsOfType(
  sandbox: Sandbox,
  type: string,
): Promise<Array<Record<string, string>>> {
  const stream = await fs.readFile(path.join(sandbox.stateDir, "events.jsonl"), "utf8");
  return stream
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, string> })
    .filter((event) => event.type === type)
    .map((event) => event.data);
}

const PROBE_ID = "anatomy-probe";

/**
 * A note wearing every part of the anatomy at once, plus the two shapes that
 * predate it (`## Decisions`, `## Report`) and a human's own `## Acceptance
 * criteria`. Each part carries a marker no other part uses, so one assertion
 * can name exactly which parts crossed into a prompt.
 */
const PROBE_NOTE = `---
blocks:
  - "[[resolvable-ticket]]"
  - "[[ghost-ticket]]"
blocked-by: "[[../outside-scope]]"
priority: high
tags: [alpha, beta]
---

# Anatomy probe ticket

DESCRIPTION_MARKER the body agents implement from.

## Acceptance criteria

- HUMAN_SECTION_MARKER must reach the agent

## Decisions

- LEGACY_DECISION_MARKER old-style decision

## Report

### 2026-01-01 — done

LEGACY_REPORT_MARKER

## Questions

- OPEN_QUESTION_MARKER?

## Comments

### 2026-01-01T00:00:00.000Z — implementation round 1

TRANSITION_MARKER pipeline narration

### 2026-01-02T00:00:00.000Z — Decision (implementation, round 1)

PRIOR_DECISION_MARKER earlier decision
`;

const ALL_MARKERS = [
  "DESCRIPTION_MARKER",
  "HUMAN_SECTION_MARKER",
  "LEGACY_DECISION_MARKER",
  "LEGACY_REPORT_MARKER",
  "OPEN_QUESTION_MARKER",
  "TRANSITION_MARKER",
  "PRIOR_DECISION_MARKER",
];

/**
 * The parts of the note a stage prompt is allowed to carry: the title's
 * description, the human's own sub-sections, the open questions and the
 * decision entries. The pipeline's transition narration and the two legacy
 * blocks are the pipeline talking to humans, and stay out.
 */
const SLICE_MARKERS = [
  "DESCRIPTION_MARKER",
  "HUMAN_SECTION_MARKER",
  "OPEN_QUESTION_MARKER",
  "PRIOR_DECISION_MARKER",
];

async function seedProbe(sandbox: Sandbox): Promise<void> {
  await fs.writeFile(path.join(sandbox.ticketsDir, "resolvable-ticket.md"), "# Resolvable\n");
  // A note one level up from ticketsDir: the `[[../outside-scope]]` link names
  // a real file, and must still resolve to nothing.
  await fs.writeFile(path.join(sandbox.project, ".jfdi", "outside-scope.md"), "# Outside\n");
  await fs.writeFile(path.join(sandbox.ticketsDir, `${PROBE_ID}.md`), PROBE_NOTE);
}

beforeAll(async () => {
  // Always rebuild: a stale dist/ would let these pass against old behavior.
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot });
}, BUILD_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("the slice of a ticket note that reaches a stage prompt", () => {
  it(
    "carries title, description, questions and decision entries — and no other section",
    async () => {
      const sandbox = await makeSandbox();
      await seedProbe(sandbox);

      // The probe carries an unresolved `blocked-by`, which gates dispatch; this
      // test is about the note slice, not blocking, so it forces past the gate.
      expect((await runCli(sandbox, ["run", "--force", `[[${PROBE_ID}]]`])).code).toBe(0);

      // Every stage reads the same slice: an unscoped spec would balloon the
      // later prompts with the pipeline's own chatter.
      for (const stage of ["implementation", "code-review", "qa"]) {
        expect(markersIn(await capturedPrompt(sandbox, stage), ALL_MARKERS)).toEqual(SLICE_MARKERS);
      }
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "keeps a boardless card's own line as the entire spec",
    async () => {
      const sandbox = await makeSandbox();

      expect((await runCli(sandbox, ["run", "Add a widget INLINE_SPEC_MARKER"])).code).toBe(0);

      const prompt = await capturedPrompt(sandbox, "implementation");
      expect(prompt).toContain("Add a widget INLINE_SPEC_MARKER");
      // The card line is the whole spec: the note the run mints for it carries
      // no sections of its own to leak back in.
      expect(prompt).not.toContain("## Decisions logged so far");
      expect(prompt).not.toContain("## Questions");
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("a pipeline append to a ticket note", () => {
  it(
    "logs each decision as its own Comments entry and leaves every other byte alone",
    async () => {
      const sandbox = await makeSandbox();
      await seedProbe(sandbox);
      const before = await readNote(sandbox, PROBE_ID);

      // `--force` past the probe's unresolved `blocked-by`: this test is about
      // how decisions are appended, not about dispatch gating.
      expect(
        (
          await runCli(sandbox, ["run", "--force", `[[${PROBE_ID}]]`], {
            decisions: ["FIRST_DECISION assumed sqlite", "SECOND_DECISION skipped the repro"],
          })
        ).code,
      ).toBe(0);

      const after = await readNote(sandbox, PROBE_ID);
      // Frontmatter (including the keys JFDI does not know), the human's own
      // section and the legacy blocks survive verbatim — the append is not a
      // rewrite, and nothing migrates a pre-anatomy note.
      for (const region of [
        before.slice(0, before.indexOf("\n# Anatomy probe ticket")),
        "## Acceptance criteria\n\n- HUMAN_SECTION_MARKER must reach the agent\n",
        "## Decisions\n\n- LEGACY_DECISION_MARKER old-style decision\n",
        "## Questions\n\n- OPEN_QUESTION_MARKER?\n",
      ]) {
        expect(after).toContain(region);
      }
      // The pre-existing entries keep their place at the head of the trail…
      expect(after).toContain("TRANSITION_MARKER pipeline narration");
      expect(after).toContain("PRIOR_DECISION_MARKER earlier decision");
      // …and each new decision arrives as one entry under its own heading,
      // stamped with the stage and round that produced it.
      const headings = [...after.matchAll(/^### (\S+) — Decision \((\S+), round (\d+)\)$/gm)].map(
        (match) => ({ timestamp: match[1] ?? "", stage: match[2] ?? "", round: match[3] ?? "" }),
      );
      expect(headings.slice(1)).toEqual([
        { timestamp: headings[1]?.timestamp ?? "", stage: "implementation", round: "1" },
        { timestamp: headings[2]?.timestamp ?? "", stage: "implementation", round: "1" },
      ]);
      for (const heading of headings.slice(1)) {
        expect(new Date(heading.timestamp).toISOString()).toBe(heading.timestamp);
      }
      expect(after).toContain("FIRST_DECISION assumed sqlite");
      expect(after).toContain("SECOND_DECISION skipped the repro");
      // The legacy `## Decisions` block is never appended to again.
      expect(after).not.toContain("FIRST_DECISION assumed sqlite\n\n## Report");
      expect(after.indexOf("## Decisions")).toBe(before.indexOf("## Decisions"));
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "creates the Comments section on a note that has none",
    async () => {
      const sandbox = await makeSandbox();
      // A bare pre-anatomy note: an H1 and a body, nothing else.
      await fs.writeFile(path.join(sandbox.ticketsDir, "bare.md"), "# Bare\n\nLEGACY_BODY here.\n");

      const run = await runCli(sandbox, ["run", "[[bare]]"], { decisions: ["ONLY_DECISION made"] });

      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      const after = await readNote(sandbox, "bare");
      expect(after).toContain("# Bare\n\nLEGACY_BODY here.\n");
      expect(after).toContain("\n## Comments\n");
      expect(after).toMatch(
        /### \S+ — Decision \(implementation, round 1\)\n\n> ONLY_DECISION made/,
      );
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    "lands on the real file when the note is a symlink into a vault",
    async () => {
      const sandbox = await makeSandbox();
      const vault = path.join(sandbox.root, "vault");
      await fs.mkdir(vault);
      const realNote = path.join(vault, "vault-probe.md");
      await fs.writeFile(realNote, "# Vault ticket\n\nVAULT_BODY.\n");
      await fs.symlink(realNote, path.join(sandbox.ticketsDir, "vault-probe.md"));

      expect(
        (await runCli(sandbox, ["run", "[[vault-probe]]"], { decisions: ["VAULT_DECISION made"] }))
          .code,
      ).toBe(0);

      // Renaming onto the link itself would replace it with a private copy and
      // split the note from the file the human edits in Obsidian.
      const link = await fs.lstat(path.join(sandbox.ticketsDir, "vault-probe.md"));
      expect(link.isSymbolicLink()).toBe(true);
      expect(await fs.readFile(realNote, "utf8")).toContain("VAULT_DECISION made");
      // No temp file left behind next to the target.
      expect(await fs.readdir(vault)).toEqual(["vault-probe.md"]);
    },
    PIPELINE_TIMEOUT_MS,
  );
});

describe("frontmatter links between tickets", () => {
  it(
    "reports the ones that name no note in ticketsDir, and follows none outside it",
    async () => {
      const sandbox = await makeSandbox();
      await seedProbe(sandbox);

      // The probe's own `blocked-by` is unresolved and gates dispatch; forcing
      // past it lets the pipeline run and report the links, which is the point.
      expect((await runCli(sandbox, ["run", "--force", `[[${PROBE_ID}]]`])).code).toBe(0);

      // `resolvable-ticket` is in ticketsDir, so it is not reported; the typo
      // and the one pointing out of the folder both are — never dropped in
      // silence, and never searched for elsewhere.
      expect(await eventsOfType(sandbox, "unresolved_link")).toEqual([
        { kind: "blocks", target: "ghost-ticket" },
        { kind: "blocked-by", target: "../outside-scope" },
      ]);
      // The file the escaping link names is real, and stayed untouched.
      expect(
        await fs.readFile(path.join(sandbox.project, ".jfdi", "outside-scope.md"), "utf8"),
      ).toBe("# Outside\n");
    },
    PIPELINE_TIMEOUT_MS,
  );
});
