import type { JfdiConfig, PermissionMode, SessionConfig } from "../config.js";
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

/** Build the harness one `stages` entry asks for under the global permission mode. */
export function createHarness(
  sessionKind: SessionKind,
  entry: SessionConfig,
  permissionMode: PermissionMode,
): Harness {
  const selection = { sessionKind, model: entry.model, effort: entry.effort };
  switch (entry.harness) {
    case "claude":
      return new ClaudeHarness(selection, permissionMode);
    case "codex":
      return new CodexHarness(selection, permissionMode);
  }
}

/** One harness per `stages` entry, held for the life of the process. */
export type SessionHarnesses = Record<SessionKind, Harness>;

/**
 * The whole of per-entry selection: each session kind's harness is fixed at
 * context construction, which is also what makes continuations safe — a session
 * id is only meaningful to the harness that minted it, and a stage always
 * re-enters its own.
 */
export function createSessionHarnesses(config: JfdiConfig): SessionHarnesses {
  const permissionMode = config.permissions.mode;
  return {
    implementation: createHarness("implementation", config.stages.implementation, permissionMode),
    "code-review": createHarness("code-review", config.stages["code-review"], permissionMode),
    qa: createHarness("qa", config.stages.qa, permissionMode),
    integration: createHarness("integration", config.stages.integration, permissionMode),
    "commit-message": createHarness(
      "commit-message",
      config.stages["commit-message"],
      permissionMode,
    ),
  };
}
