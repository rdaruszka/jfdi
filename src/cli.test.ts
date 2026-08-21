import { describe, expect, it, vi } from "vitest";
import { main, parseInitOptions, parseStartOptions } from "./cli.js";

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

describe("parseStartOptions", () => {
  it("selects one front end for this invocation", () => {
    expect(parseStartOptions(["--front-end", "web"])).toEqual({ frontEnd: "web" });
    expect(parseStartOptions(["--front-end", "terminal"])).toEqual({ frontEnd: "terminal" });
  });

  it("rejects unknown, missing, and invalid options", () => {
    expect(() => parseStartOptions(["--front-end"])).toThrow("--front-end requires a value");
    expect(() => parseStartOptions(["--front-end", "desktop"])).toThrow(
      '--front-end must be "terminal" or "web", got "desktop"',
    );
    expect(() => parseStartOptions(["--port", "8080"])).toThrow('unknown start option "--port"');
  });
});

describe("help", () => {
  it("lists the config migration command", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await main(["help"])).toBe(0);

    expect(output).toHaveBeenCalledWith(expect.stringContaining("jfdi update-config"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining("--front-end <name>"));
    output.mockRestore();
  });
});
