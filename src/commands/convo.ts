import { spawn } from "node:child_process";
import * as path from "node:path";
import { JFDI_DIR, loadConfig } from "../config.js";
import { repoRoot } from "../git.js";
import { loadPrompt } from "../prompts.js";

/** Shell convention for "command not found / could not execute". */
const EXIT_LAUNCH_FAILED = 127;

/**
 * `jfdi convo` — an interactive harness session scoped to the JFDI layer itself:
 * gates, sandbox contract, board config, and agent prompts — not product code.
 */
export async function convoCommand(): Promise<number> {
  const root = await repoRoot(process.cwd());
  const config = await loadConfig(root);
  if (config.harness !== "claude")
    throw new Error(`convo requires an interactive harness; "${config.harness}" is not supported`);
  const jfdiDir = path.join(root, JFDI_DIR);
  const prompt = await loadPrompt(jfdiDir, "convo");
  const child = spawn("claude", ["--append-system-prompt", prompt], {
    cwd: root,
    stdio: "inherit",
  });
  return new Promise<number>((resolve) => {
    child.on("error", (err) => {
      console.error(`failed to launch claude: ${err.message}`);
      resolve(EXIT_LAUNCH_FAILED);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}
