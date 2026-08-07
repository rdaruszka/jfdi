import { describe, expect, it } from "vitest";
import { spawnFailureText } from "./spawn-failure.js";

describe("spawnFailureText", () => {
  it("points an interactive init failure back to the harness flag", () => {
    const message = spawnFailureText(
      "codex",
      { sessionKind: "implementation" },
      "ENOENT",
      "init-flags",
    );
    expect(message).toContain("jfdi init with --harness");
    expect(message).not.toContain("stages.implementation.harness");
  });
});
