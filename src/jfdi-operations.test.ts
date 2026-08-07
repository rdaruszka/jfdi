import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JFDI_OPERATIONS } from "./jfdi-operations.js";

const DOC_URL = new URL("../docs/jfdi-operations.md", import.meta.url);

describe("JFDI_OPERATIONS", () => {
  it("matches docs/jfdi-operations.md exactly (the doc is authoritative)", async () => {
    const doc = await fs.readFile(fileURLToPath(DOC_URL), "utf8");
    expect(
      JFDI_OPERATIONS,
      "src/jfdi-operations.ts has drifted from docs/jfdi-operations.md — run `pnpm sync:guidelines`",
    ).toBe(doc);
  });
});
