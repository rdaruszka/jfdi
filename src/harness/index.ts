import type { JfdiConfig, StageConfig } from "../config.js";
import { CLAUDE_EFFORT_LEVELS, ClaudeHarness } from "./claude.js";
import { CODEX_EFFORT_LEVELS, CodexHarness } from "./codex.js";
import type { Harness, HarnessName, SessionKind } from "./types.js";

export { CLAUDE_EFFORT_LEVELS, ClaudeHarness } from "./claude.js";
export { CODEX_EFFORT_LEVELS, CodexHarness } from "./codex.js";
export { FakeHarness } from "./fake.js";
export * from "./types.js";

/**
 * The effort vocabulary each implementation's CLI accepts, gathered from the
 * tables that sit beside the flag mapping they feed. `parseConfig` checks every
 * configured `(harness, effort)` pair against this, so a typo is a startup
 * error rather than a mid-run session failure.
 */
export const EFFORT_LEVELS_BY_HARNESS: Record<HarnessName, readonly string[]> = {
  claude: CLAUDE_EFFORT_LEVELS,
  codex: CODEX_EFFORT_LEVELS,
};

/** Build the harness one `stages` entry asks for. */
export function createHarness(stage: SessionKind, stageConfig: StageConfig): Harness {
  const selection = { stage, model: stageConfig.model, effort: stageConfig.effort };
  switch (stageConfig.harness) {
    case "claude":
      return new ClaudeHarness(selection);
    case "codex":
      return new CodexHarness(selection);
  }
}

/** One harness per `stages` entry, held for the life of the process. */
export type StageHarnesses = Record<SessionKind, Harness>;

/**
 * The whole of per-stage selection: each stage's harness is fixed at context
 * construction, which is also what makes continuations safe — a session id is
 * only meaningful to the harness that minted it, and a stage always re-enters
 * its own.
 */
export function createStageHarnesses(config: JfdiConfig): StageHarnesses {
  return {
    implementation: createHarness("implementation", config.stages.implementation),
    "code-review": createHarness("code-review", config.stages["code-review"]),
    qa: createHarness("qa", config.stages.qa),
    integration: createHarness("integration", config.stages.integration),
    "commit-message": createHarness("commit-message", config.stages["commit-message"]),
  };
}
