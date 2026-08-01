import { describe, expect, it } from "vitest";
import { formatEntry, isIsoDate, parseAmount, UsageError } from "./entry.js";

describe("parseAmount", () => {
  it("parses positive decimal amounts", () => {
    expect(parseAmount("12.50")).toBe(12.5);
    expect(parseAmount("3")).toBe(3);
  });

  it("rejects non-numbers, zero, and negatives", () => {
    for (const raw of ["abc", "", "0", "-5", "NaN", "Infinity"]) {
      expect(() => parseAmount(raw), raw).toThrow(UsageError);
    }
  });
});

describe("isIsoDate", () => {
  it("accepts YYYY-MM-DD only", () => {
    expect(isIsoDate("2026-08-01")).toBe(true);
    expect(isIsoDate("2026-8-1")).toBe(false);
    expect(isIsoDate("yesterday")).toBe(false);
  });
});

describe("formatEntry", () => {
  it("renders id, date, padded amount, category, description", () => {
    const line = formatEntry({
      id: 3,
      date: "2026-08-01",
      amount: 12.5,
      category: "groceries",
      description: "oat milk",
    });
    expect(line).toBe("#3  2026-08-01      12.50  groceries  oat milk");
  });

  it("omits the trailing gap when there is no description", () => {
    const line = formatEntry({
      id: 1,
      date: "2026-08-01",
      amount: 7,
      category: "coffee",
      description: "",
    });
    expect(line).toBe("#1  2026-08-01       7.00  coffee");
  });
});
