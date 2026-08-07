import * as path from "node:path";
import { JFDI_DIR, loadConfig } from "../config.js";
import { repoRoot } from "../git.js";
import { CODING_GUIDELINES } from "../guidelines.js";
import { createHarness } from "../harness/index.js";
import { JFDI_OPERATIONS } from "../jfdi-operations.js";
import { loadPrompt, renderPrompt } from "../prompts.js";
import { scaffoldJfdi } from "../scaffold.js";

/**
 * `jfdi init` — scaffold .jfdi/ (config, board, tickets dir, prompts, sandbox
 * contract), then hand off to an agent session that inspects the repo and gives
 * the mechanical gate teeth. `--bare` skips the agent step.
 */
export async function initCommand(options: { isBare?: boolean } = {}): Promise<number> {
  const root = await repoRoot(process.cwd());
  const jfdiDir = path.join(root, JFDI_DIR);
  await scaffoldJfdi(root, jfdiDir);
  console.log(`scaffolded ${JFDI_DIR}/ (config, board, tickets, prompts, sandbox contract)`);

  const config = await loadConfig(root);
  if (options.isBare) {
    console.log("next: fill in the gate commands in .jfdi/config.json and .jfdi/sandbox.md");
    return 0;
  }

  console.log("launching an agent session to set up the mechanical gate…\n");
  const template = await loadPrompt(jfdiDir, "init");
  const prompt = renderPrompt(template, { CODING_GUIDELINES, JFDI_OPERATIONS });
  // The implementation stage's agent, like `jfdi convo` — see convo.ts.
  const exitCode = await createHarness(
    "implementation",
    config.stages.implementation,
    config.permissions.mode,
  ).spawnInteractive(prompt, { cwd: root });
  if (exitCode !== 0)
    console.error("scaffold is in place — fill in .jfdi/config.json's gate by hand");
  return exitCode;
}
