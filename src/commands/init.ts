import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultConfig,
  JFDI_DIRECTORY,
  type JfdiConfig,
  type LegacyConfigNotice,
  loadConfig,
  type PermissionMode,
  printLegacyConfigNotice,
  type SessionConfig,
} from "../config.js";
import { runGate } from "../gate.js";
import { projectRoot } from "../git.js";
import { CODING_GUIDELINES } from "../guidelines.js";
import { createHarness, EFFORT_LEVELS_BY_HARNESS } from "../harness/index.js";
import type { HarnessName } from "../harness/types.js";
import { JFDI_OPERATIONS } from "../jfdi-operations.js";
import { INIT_SYSTEM_PROMPT, INIT_USER_PROMPT, renderPrompt } from "../prompts.js";
import { scaffoldJfdi } from "../scaffold.js";

const DEFAULT_INIT_HARNESS: HarnessName = "claude";
const DEFAULT_INIT_MODEL = "claude-fable-5";
const CONFIG_PATH = path.join(JFDI_DIRECTORY, "config.json");

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

async function verifyGate(
  resolvedProjectRoot: string,
  onLegacyKeys: LegacyConfigNotice,
): Promise<boolean> {
  let config: JfdiConfig;
  try {
    config = await loadConfig(resolvedProjectRoot, { onLegacyKeys });
  } catch (error) {
    console.error(
      `gate could not load ${CONFIG_PATH}: ${(error as Error).message}; ` +
        "rerun `jfdi init` to finish setup",
    );
    return false;
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-init-gate-"));
  try {
    const result = await runGate(
      config.gate,
      resolvedProjectRoot,
      path.join(temporaryDirectory, "gate.log"),
    );
    if (result.ok) {
      console.log("gate verified");
      return true;
    }
    const failedStep = result.results.at(-1);
    assert(failedStep !== undefined, "a failed init gate must identify its failing step");
    console.error(`gate failed at "${failedStep.name}"; rerun \`jfdi init\` to finish setup`);
    return false;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * `jfdi init` — scaffold .jfdi/ (config, board, tickets dir, ticket format,
 * sandbox contract, and generic prompts — see scaffoldJfdi), then hand off to a
 * conversational agent session that explores the project and builds the
 * setup with the human. The session runs isolated from the project's own
 * agent instructions and carries its worldview as an appended system prompt,
 * so it looks at the repo with fresh eyes. `--bare` skips the agent step.
 */
export async function initCommand(options: InitOptions = {}): Promise<number> {
  const resolvedProjectRoot = await projectRoot(process.cwd());
  const jfdiDirectory = path.join(resolvedProjectRoot, JFDI_DIRECTORY);
  const { retiredPromptsPath } = await scaffoldJfdi(resolvedProjectRoot, jfdiDirectory);
  console.log(
    `scaffolded ${JFDI_DIRECTORY}/ (config, board, tickets, ticket format, sandbox contract)`,
  );
  if (retiredPromptsPath !== null) {
    console.log(
      `retired existing prompts to ${path.relative(resolvedProjectRoot, retiredPromptsPath)} — ` +
        "the setup agent never reads them; the pipeline reseeds defaults on first use",
    );
  }

  let permissionMode: PermissionMode = defaultConfig().permissions.mode;
  let configWarning: string | null = null;
  let hasPrintedLegacyNotice = false;
  const onLegacyKeys: LegacyConfigNotice = (legacyKeys, file) => {
    if (hasPrintedLegacyNotice) return;
    hasPrintedLegacyNotice = true;
    printLegacyConfigNotice(legacyKeys, file);
  };
  try {
    permissionMode = (await loadConfig(resolvedProjectRoot, { onLegacyKeys })).permissions.mode;
  } catch (error) {
    const reason = (error as Error).message;
    configWarning =
      `Warning: failed to load ${CONFIG_PATH}: "${reason}". ` +
      `Using default permissions.mode "${permissionMode}" for setup; ` +
      "treat the config as broken and repair it during setup.";
    console.warn(configWarning);
  }
  if (options.isBare) {
    console.log(
      "next: fill in the gate commands and sandbox contract, then link " +
        ".jfdi/ticket-format.md from the project's agent instructions",
    );
    return 0;
  }

  console.log("launching a conversational setup session…\n");
  const systemPrompt = renderPrompt(INIT_SYSTEM_PROMPT, { CODING_GUIDELINES, JFDI_OPERATIONS });
  const exitCode = await createHarness(
    "implementation",
    initSessionConfig(options),
    permissionMode,
  ).spawnInteractive(
    configWarning === null ? INIT_USER_PROMPT : `${configWarning}\n\n${INIT_USER_PROMPT}`,
    {
      cwd: resolvedProjectRoot,
      systemPrompt,
      shouldIgnoreProjectContext: true,
    },
  );
  if (exitCode !== 0) console.error(`setup session exited with code ${exitCode}`);
  const isGateVerified = await verifyGate(resolvedProjectRoot, onLegacyKeys);
  if (!isGateVerified && exitCode === 0) return 1;
  return exitCode;
}
