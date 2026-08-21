import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TICKET_FORMAT } from "./ticket-format.js";

const DOCUMENT_URL = new URL("../docs/ticket-format.md", import.meta.url);

describe("TICKET_FORMAT", () => {
  it("matches docs/ticket-format.md exactly (the doc is authoritative)", async () => {
    const document = await fs.readFile(fileURLToPath(DOCUMENT_URL), "utf8");
    expect(
      TICKET_FORMAT,
      "src/ticket-format.ts has drifted from docs/ticket-format.md — run `pnpm sync:guidelines`",
    ).toBe(document);
  });
});
