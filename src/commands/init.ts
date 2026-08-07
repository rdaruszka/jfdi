import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JFDI_DIR, loadConfig, type SessionConfig } from "../config.js";
import { runGate } from "../gate.js";
import { repoRoot } from "../git.js";
import { CODING_GUIDELINES } from "../guidelines.js";
import { createHarness, EFFORT_LEVELS_BY_HARNESS } from "../harness/index.js";
import type { HarnessName } from "../harness/types.js";
import { JFDI_OPERATIONS } from "../jfdi-operations.js";
import { INIT_SYSTEM_PROMPT, INIT_USER_PROMPT, renderPrompt } from "../prompts.js";
import { scaffoldJfdi } from "../scaffold.js";

const DEFAULT_INIT_HARNESS: HarnessName = "claude";
const DEFAULT_INIT_MODEL = "claude-fable-5";

export interface InitOptions {
  isBare?: boolean;
  harness?: HarnessName;
  model?: string;
  effort?: string;
}

function initSessionConfig(options: InitOptions): SessionConfig {
  const harness = options.harness ?? DEFAULT_INIT_HARNESS;
  const effort = options.effort;
  if (effort !== undefined && !EFFORT_LEVELS_BY_HARNESS[harness].includes(effort)) {
    throw new Error(
      `--effort must be one of ${EFFORT_LEVELS_BY_HARNESS[harness].join(", ")} for ${harness}, got "${effort}"`,
    );
  }
  return {
    harness,
    model: options.model ?? DEFAULT_INIT_MODEL,
    ...(effort === undefined ? {} : { effort }),
  };
}

async function verifyGate(root: string): Promise<boolean> {
  const config = await loadConfig(root);
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-init-gate-"));
  try {
    const result = await runGate(config.gate, root, path.join(temporaryDir, "gate.log"));
    if (result.ok) {
      console.log("gate verified");
      return true;
    }
    const failedStep = result.results.at(-1);
    assert(failedStep !== undefined, "a failed init gate must identify its failing step");
    console.error(`gate failed at "${failedStep.name}"; rerun \`jfdi init\` to finish setup`);
    return false;
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

/**
 * `jfdi init` — scaffold .jfdi/ (config, board, tickets dir, sandbox
 * contract; never prompts — see scaffoldJfdi), then hand off to a
 * conversational agent session that explores the project and builds the
 * setup with the human. The session runs isolated from the project's own
 * agent instructions and carries its worldview as an appended system prompt,
 * so it looks at the repo with fresh eyes. `--bare` skips the agent step.
 */
export async function initCommand(options: InitOptions = {}): Promise<number> {
  const root = await repoRoot(process.cwd());
  const jfdiDir = path.join(root, JFDI_DIR);
  const { retiredPromptsPath } = await scaffoldJfdi(root, jfdiDir);
  console.log(`scaffolded ${JFDI_DIR}/ (config, board, tickets, sandbox contract)`);
  if (retiredPromptsPath !== null) {
    console.log(
      `retired existing prompts to ${path.relative(root, retiredPromptsPath)} — ` +
        "the setup agent never reads them; the pipeline reseeds defaults on first use",
    );
  }

  const config = await loadConfig(root);
  if (options.isBare) {
    console.log("next: fill in the gate commands in .jfdi/config.json and .jfdi/sandbox.md");
    return 0;
  }

  console.log("launching a conversational setup session…\n");
  const systemPrompt = renderPrompt(INIT_SYSTEM_PROMPT, { CODING_GUIDELINES, JFDI_OPERATIONS });
  const exitCode = await createHarness(
    "implementation",
    initSessionConfig(options),
    config.permissions.mode,
  ).spawnInteractive(INIT_USER_PROMPT, {
    cwd: root,
    systemPrompt,
    shouldIgnoreProjectContext: true,
  });
  if (exitCode !== 0) console.error(`setup session exited with code ${exitCode}`);
  const isGateVerified = await verifyGate(root);
  if (!isGateVerified && exitCode === 0) return 1;
  return exitCode;
}
