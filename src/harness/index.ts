import type { JfdiConfig } from "../config.js";
import { ClaudeHarness } from "./claude.js";
import { CodexHarness } from "./codex.js";
import type { Harness } from "./types.js";

export { ClaudeHarness } from "./claude.js";
export { CodexHarness } from "./codex.js";
export { FakeHarness } from "./fake.js";
export * from "./types.js";

export function createHarness(config: JfdiConfig): Harness {
  switch (config.harness) {
    case "claude":
      return new ClaudeHarness();
    case "codex":
      return new CodexHarness();
  }
}
