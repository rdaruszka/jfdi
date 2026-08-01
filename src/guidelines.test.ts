import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODING_GUIDELINES } from "./guidelines.js";

const DOC_URL = new URL("../docs/coding-guidelines.md", import.meta.url);

describe("CODING_GUIDELINES", () => {
  it("matches docs/coding-guidelines.md exactly (the doc is authoritative)", async () => {
    const doc = await fs.readFile(fileURLToPath(DOC_URL), "utf8");
    expect(
      CODING_GUIDELINES,
      "src/guidelines.ts has drifted from docs/coding-guidelines.md — run `pnpm sync:guidelines`",
    ).toBe(doc);
  });
});
