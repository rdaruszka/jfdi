import { spawn } from "node:child_process";
import * as path from "node:path";
import { JFDI_DIR, loadConfig } from "../config.js";
import { repoRoot } from "../git.js";
import { CODING_GUIDELINES } from "../guidelines.js";
import { loadPrompt, renderPrompt } from "../prompts.js";
import { scaffoldJfdi } from "../scaffold.js";

/**
 * `jfdi init` — scaffold .jfdi/ (config, board, tickets dir, prompts, sandbox
 * contract), then hand off to an agent session that inspects the repo and gives
 * the mechanical gate teeth. `--bare` skips the agent step.
 */
export async function initCommand(options: { bare?: boolean } = {}): Promise<number> {
  const root = await repoRoot(process.cwd());
  const jfdiDir = path.join(root, JFDI_DIR);
  await scaffoldJfdi(root, jfdiDir);
  console.log(`scaffolded ${JFDI_DIR}/ (config, board, tickets, prompts, sandbox contract)`);

  const config = await loadConfig(root);
  if (options.bare || config.harness !== "claude") {
    console.log("next: fill in the gate commands in .jfdi/config.json and .jfdi/sandbox.md");
    return 0;
  }

  console.log("launching an agent session to set up the mechanical gate…\n");
  const template = await loadPrompt(jfdiDir, "init");
  const prompt = renderPrompt(template, { CODING_GUIDELINES });
  const child = spawn("claude", [prompt], { cwd: root, stdio: "inherit" });
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`failed to launch claude: ${error.message}`);
      console.error("scaffold is in place — fill in .jfdi/config.json's gate by hand");
      resolve(0);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}
