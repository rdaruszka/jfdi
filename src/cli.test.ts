import { describe, expect, it, vi } from "vitest";
import { main, parseInitOptions } from "./cli.js";

describe("parseInitOptions", () => {
  it("parses the conversational init session selection", () => {
    expect(
      parseInitOptions(["--harness", "codex", "--model", "gpt-5.6-sol", "--effort", "high"]),
    ).toEqual({ harness: "codex", model: "gpt-5.6-sol", effort: "high" });
  });

  it("keeps bare as a scaffold-only option", () => {
    expect(parseInitOptions(["--bare"])).toEqual({ isBare: true });
  });

  it("rejects unsupported harnesses and missing option values", () => {
    expect(() => parseInitOptions(["--harness", "other"])).toThrow(
      '--harness must be "claude" or "codex"',
    );
    expect(() => parseInitOptions(["--model"])).toThrow("--model requires a value");
  });
});

describe("help", () => {
  it("lists the config migration command", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await main(["help"])).toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("jfdi update-config"));
    output.mockRestore();
  });
});
