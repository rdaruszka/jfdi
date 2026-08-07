import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { CODING_GUIDELINES } from "./guidelines.js";
import { JFDI_OPERATIONS } from "./jfdi-operations.js";

/**
 * Behavioral proof that `jfdi init` compiles the operations brief into the init
 * prompt and injects it ahead of the coding guidelines. It drives the built CLI
 * end to end: real scaffold, internal init template rendering, real init.ts wiring.
 * A stub `claude` captures the fully rendered prompt — the last CLI argv element
 * on the interactive Claude launch (see harness/claude.ts spawnInteractive).
 */
const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const sandboxRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxRoots
      .splice(0)
      .map((sandboxRoot) => fs.rm(sandboxRoot, { recursive: true, force: true })),
  );
});

async function runInitAndCapturePrompt(staleInitPrompt?: string): Promise<string> {
  const createdSandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-init-operations-"));
  sandboxRoots.push(createdSandboxRoot);
  const sandboxRoot = await fs.realpath(createdSandboxRoot);
  const project = path.join(sandboxRoot, "project");
  const binDir = path.join(sandboxRoot, "bin");
  const jfdiHome = path.join(sandboxRoot, "home");
  const tracePath = path.join(sandboxRoot, "trace.json");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(binDir);
  await fs.mkdir(jfdiHome);
  if (staleInitPrompt !== undefined) {
    await fs.mkdir(path.join(project, ".jfdi/prompts"), { recursive: true });
    await fs.writeFile(path.join(project, ".jfdi/prompts/init.md"), staleInitPrompt);
  }

  // The default scaffold routes the interactive launch through Claude; stub both
  // so the inner session never reaches a real agent CLI, dumping argv instead.
  const stub = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.TRACE_PATH, JSON.stringify({ args: process.argv.slice(2) }));
`;
  await Promise.all(
    ["claude", "codex"].map((executable) =>
      fs.writeFile(path.join(binDir, executable), stub, { mode: 0o755 }),
    ),
  );

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");

  await execFileAsync(process.execPath, [cliPath, "init"], {
    cwd: project,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TRACE_PATH: tracePath,
      JFDI_HOME: jfdiHome,
    },
  });

  const trace = JSON.parse(await fs.readFile(tracePath, "utf8")) as { args: string[] };
  const renderedPrompt = trace.args.at(-1);
  if (renderedPrompt === undefined) throw new Error("init launched no agent prompt");
  return renderedPrompt;
}

describe("jfdi init compiles the operations brief into the init prompt", () => {
  it("injects the full operations brief, substituted, ahead of the coding guidelines", async () => {
    const prompt = await runInitAndCapturePrompt();

    // The {{JFDI_OPERATIONS}} placeholder is fully substituted — not dropped,
    // not left literal.
    expect(prompt).not.toContain("{{JFDI_OPERATIONS}}");

    // The verbatim compiled operations constant reaches the agent...
    expect(prompt).toContain(JFDI_OPERATIONS);
    // ...as does the coding guidelines constant it already carried.
    expect(prompt).toContain(CODING_GUIDELINES);

    // Placement: the machine before the rules it instantiates.
    expect(prompt.indexOf(JFDI_OPERATIONS)).toBeLessThan(prompt.indexOf(CODING_GUIDELINES));
    expect(prompt.indexOf("# How JFDI runs your project")).toBeLessThan(
      prompt.indexOf("# Coding Guidelines"),
    );
  });

  it("ignores a stale on-disk init prompt", async () => {
    const staleInitPrompt = "You are bootstrapping a JFDI skeleton";
    const prompt = await runInitAndCapturePrompt(staleInitPrompt);

    expect(prompt).toContain("configuring **JFDI**");
    expect(prompt).toContain("through a conversation with the human");
    expect(prompt).not.toContain(staleInitPrompt);
  });
});
