import * as path from "node:path";
import { JFDI_DIR, loadConfig } from "../config.js";
import { repoRoot } from "../git.js";
import { createHarness } from "../harness/index.js";
import { loadPrompt } from "../prompts.js";

/**
 * `jfdi convo` — an interactive harness session scoped to the JFDI layer itself:
 * gates, sandbox contract, board config, and agent prompts — not product code.
 */
export async function convoCommand(): Promise<number> {
  const root = await repoRoot(process.cwd());
  const config = await loadConfig(root);
  const jfdiDir = path.join(root, JFDI_DIR);
  const prompt = await loadPrompt(jfdiDir, "convo");
  // With no global harness left, an interactive session takes the
  // implementation stage's — the closest analogue to "the agent that writes
  // code here" — model and effort included, under the global permission mode.
  return createHarness(
    "implementation",
    config.stages.implementation,
    config.permissions.mode,
  ).spawnInteractive(prompt, { cwd: root, isSystemPrompt: true });
}
