import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TICKET_FORMAT } from "./ticket-format.js";

const DOC_URL = new URL("../docs/ticket-format.md", import.meta.url);

describe("TICKET_FORMAT", () => {
  it("matches docs/ticket-format.md exactly (the doc is authoritative)", async () => {
    const document = await fs.readFile(DOC_URL, "utf8");
    expect(TICKET_FORMAT).toBe(
      document,
      "src/ticket-format.ts has drifted from docs/ticket-format.md — run `pnpm sync:guidelines`",
    );
  });
});
