import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrompts, formatGateCommands, loadPrompt, renderPrompt } from "./prompts.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-prompts-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("renderPrompt", () => {
  it("substitutes placeholders and blanks unknown ones", () => {
    expect(renderPrompt("do {{THING}} at {{WHERE}}", { THING: "work" })).toBe("do work at ");
  });
});

describe("ensurePrompts / loadPrompt", () => {
  it("seeds all ten prompt files", async () => {
    await ensurePrompts(dir);
    const files = await fs.readdir(path.join(dir, "prompts"));
    expect(files.sort()).toEqual([
      "code-review-continue.md",
      "code-review.md",
      "commit-message.md",
      "convo.md",
      "implementation-continue.md",
      "implementation.md",
      "init.md",
      "integration.md",
      "qa-continue.md",
      "qa.md",
    ]);
  });

  it("does not overwrite user-tuned prompts", async () => {
    await ensurePrompts(dir);
    const file = path.join(dir, "prompts/qa.md");
    await fs.writeFile(file, "my custom QA prompt {{VERDICT_PATH}}");
    await ensurePrompts(dir);
    expect(await fs.readFile(file, "utf8")).toBe("my custom QA prompt {{VERDICT_PATH}}");
    expect(await loadPrompt(dir, "qa")).toBe("my custom QA prompt {{VERDICT_PATH}}");
  });

  it("seeds the default on load when the file is absent, and the file is authoritative", async () => {
    const prompt = await loadPrompt(dir, "implementation");
    expect(prompt).toContain("Implement the ticket below completely");
    expect(prompt).toContain("{{VERDICT_PATH}}");
    expect(prompt).toContain("decide, log, proceed");
    // The prompt that ran is now on disk — no silent in-code fallback.
    const onDisk = await fs.readFile(path.join(dir, "prompts/implementation.md"), "utf8");
    expect(onDisk).toBe(prompt);
  });
});

describe("formatGateCommands", () => {
  it("renders the command list", () => {
    expect(formatGateCommands([{ name: "test", cmd: "pnpm test" }])).toContain("pnpm test");
  });
  it("notes an empty gate", () => {
    expect(formatGateCommands([])).toContain("no gate commands");
  });
});
