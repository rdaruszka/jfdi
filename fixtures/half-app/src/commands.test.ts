import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCommand } from "./commands/add.js";
import { listCommand } from "./commands/list.js";
import { totalCommand } from "./commands/total.js";
import { UsageError } from "./entry.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "penny-test-"));
  process.env.PENNY_FILE = path.join(dir, "penny.json");
});

afterEach(async () => {
  delete process.env.PENNY_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("add", () => {
  it("appends an entry and reports it", async () => {
    const out = await addCommand(["12.50", "groceries", "oat", "milk", "--date", "2026-07-03"]);
    expect(out).toBe("Added #1  2026-07-03      12.50  groceries  oat milk");
  });

  it("assigns sequential ids", async () => {
    await addCommand(["1", "a", "--date", "2026-07-01"]);
    const out = await addCommand(["2", "b", "--date", "2026-07-02"]);
    expect(out).toContain("#2");
  });

  it("rejects missing arguments and bad dates", async () => {
    await expect(addCommand(["12.50"])).rejects.toThrow(UsageError);
    await expect(addCommand(["12.50", "cat", "--date", "July 3"])).rejects.toThrow(UsageError);
  });
});

describe("list", () => {
  it("prints No entries. for an empty ledger", async () => {
    expect(await listCommand([])).toBe("No entries.");
  });

  it("prints one line per entry in insertion order", async () => {
    await addCommand(["12.50", "groceries", "--date", "2026-07-03"]);
    await addCommand(["4.25", "coffee", "flat white", "--date", "2026-07-04"]);
    const out = await listCommand([]);
    expect(out.split("\n")).toEqual([
      "#1  2026-07-03      12.50  groceries",
      "#2  2026-07-04       4.25  coffee  flat white",
    ]);
  });

  it("rejects stray arguments", async () => {
    await expect(listCommand(["extra"])).rejects.toThrow(UsageError);
  });
});

describe("total", () => {
  it("sums all entries", async () => {
    await addCommand(["12.50", "groceries", "--date", "2026-07-03"]);
    await addCommand(["7.50", "coffee", "--date", "2026-07-04"]);
    expect(await totalCommand([])).toBe("Total: 20");
  });

  it("totals zero for an empty ledger", async () => {
    expect(await totalCommand([])).toBe("Total: 0");
  });
});
