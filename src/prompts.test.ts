import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensurePrompts,
  formatGateCommands,
  INIT_PROMPT,
  loadPrompt,
  renderPrompt,
} from "./prompts.js";

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
  it("seeds all eight on-disk prompt files", async () => {
    await ensurePrompts(dir);
    const files = await fs.readdir(path.join(dir, "prompts"));
    expect(files.sort()).toEqual([
      "code-review-continue.md",
      "code-review.md",
      "commit-message.md",
      "implementation-continue.md",
      "implementation.md",
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

  it("leaves legacy init prompt files untouched", async () => {
    const promptsDirectory = path.join(dir, "prompts");
    await fs.mkdir(promptsDirectory);
    await fs.writeFile(path.join(promptsDirectory, "init.md"), "legacy init");
    await fs.writeFile(path.join(promptsDirectory, "convo.md"), "legacy convo");

    await ensurePrompts(dir);

    expect(await fs.readFile(path.join(promptsDirectory, "init.md"), "utf8")).toBe("legacy init");
    expect(await fs.readFile(path.join(promptsDirectory, "convo.md"), "utf8")).toBe("legacy convo");
  });

  it("places the operations brief before the coding guidelines in the internal init prompt", () => {
    const operationsIndex = INIT_PROMPT.indexOf("{{JFDI_OPERATIONS}}");
    const guidelinesIndex = INIT_PROMPT.indexOf("{{CODING_GUIDELINES}}");
    expect(operationsIndex).toBeGreaterThan(-1);
    expect(guidelinesIndex).toBeGreaterThan(operationsIndex);
  });

  it("makes init conversational and forbids writes before plan approval", () => {
    expect(INIT_PROMPT).toContain("Survey without writing");
    expect(INIT_PROMPT).toContain("Interview one question at a time");
    expect(INIT_PROMPT).toContain("anything else they want to cover");
    expect(INIT_PROMPT).toContain("Get explicit approval");
    expect(INIT_PROMPT).toContain("write anything until they do");
    expect(INIT_PROMPT).toContain("project's AGENTS.md");
    expect(INIT_PROMPT).toContain(".jfdi/scripts/");
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
