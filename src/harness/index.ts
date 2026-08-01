import type { JfdiConfig } from "../config.js";
import { ClaudeHarness } from "./claude.js";
import type { Harness } from "./types.js";

export { ClaudeHarness } from "./claude.js";
export { FakeHarness } from "./fake.js";
export * from "./types.js";

export function createHarness(config: JfdiConfig): Harness {
  switch (config.harness) {
    case "claude":
      return new ClaudeHarness(config.harnessArgs);
    default:
      throw new Error(
        `unknown harness "${config.harness}" — "claude" is the only built-in harness`,
      );
  }
}
