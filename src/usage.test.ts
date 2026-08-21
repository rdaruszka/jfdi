import { describe, expect, it } from "vitest";
import { codexCostUsd } from "./harness/codex-pricing.js";
import type { SessionUsage } from "./harness/types.js";
import {
  formatCostUsd,
  formatDurationMs,
  formatRunningTotals,
  formatTokens,
  renderUsageTable,
  UsageLedger,
} from "./usage.js";

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    durationMs: 0,
    costUsd: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

describe("codexCostUsd", () => {
  it("prices each tier from the table, charging the cached rate on cached input", () => {
    // terra: input $2/M, cached $0.20/M, output $12/M. 1M input of which 200K
    // cached → 800K × $2 + 200K × $0.20 + 500K output × $12 = 1.6 + 0.04 + 6.0.
    const cost = codexCostUsd("gpt-5.6-terra", {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(1.6 + 0.04 + 6.0, 6);
  });

  it("prices the other two tiers", () => {
    expect(
      codexCostUsd("gpt-5.6-sol", {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBeCloseTo(5.0, 6);
    expect(
      codexCostUsd("gpt-5.6-luna", {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(1.2, 6);
  });

  it("returns null (unknown) for a model the table does not carry — never a guessed number", () => {
    expect(
      codexCostUsd("gpt-5.6-nebula", {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
      }),
    ).toBeNull();
    expect(
      codexCostUsd(undefined, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
    ).toBeNull();
  });

  it("uses the configured model spelling verbatim", () => {
    expect(
      codexCostUsd("GPT-5.6-TERRA", {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBeNull();
  });

  it("does not silently clamp cached input that exceeds total input", () => {
    const cost = codexCostUsd("gpt-5.6-terra", {
      inputTokens: 100_000,
      cachedInputTokens: 200_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(-0.16, 6);
  });
});

describe("formatting", () => {
  it("renders durations as s / m / h m", () => {
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(42_000)).toBe("42s");
    expect(formatDurationMs(7 * 60_000)).toBe("7m");
    expect(formatDurationMs((60 + 10) * 60_000)).toBe("1h 10m");
  });

  it("renders token counts compactly", () => {
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(45_000)).toBe("45.0K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("shows dollars when known and a token fallback when the price is unknown", () => {
    expect(formatCostUsd(1.87, 0)).toBe("$1.87");
    expect(formatCostUsd(null, 1_200_000)).toBe("1.2M tokens, price unavailable");
  });

  it("joins cost and agent time for a status/TUI row", () => {
    expect(formatRunningTotals(13.41, 42 * 60_000, 0)).toBe("$13.41 · agent 42m");
    expect(formatRunningTotals(null, 60_000, 3_000)).toBe(
      "3.0K tokens, price unavailable · agent 1m",
    );
  });
});

describe("UsageLedger", () => {
  it("tallies sessions per stage row and rolls up totals", () => {
    const ledger = new UsageLedger();
    ledger.add("implementation", usage({ durationMs: 60_000, costUsd: 4.5, inputTokens: 1_000 }));
    ledger.add("implementation", usage({ durationMs: 60_000, costUsd: 4.5, outputTokens: 500 }));
    ledger.add("code-review", usage({ durationMs: 30_000, costUsd: 2.5 }));
    ledger.add("commit-message", usage({ durationMs: 1_000, costUsd: 0.04 }));

    const rows = ledger.snapshot();
    expect(rows.map((row) => row.label)).toEqual(["Implementation", "Code Review", "Scribe"]);
    const implementation = rows[0];
    expect(implementation?.sessions).toBe(2);
    expect(implementation?.durationMs).toBe(120_000);
    expect(implementation?.knownCostUsd).toBeCloseTo(9.0, 6);

    const totals = ledger.totals();
    expect(totals.sessions).toBe(4);
    expect(totals.costUsd).toBeCloseTo(11.54, 6);
    expect(totals.durationMs).toBe(151_000);
  });

  it("makes the total cost unknown when any session had no known price", () => {
    const ledger = new UsageLedger();
    ledger.add("implementation", usage({ costUsd: 4.5 }));
    ledger.add("qa", usage({ costUsd: null, inputTokens: 1_000, outputTokens: 200 }));
    expect(ledger.totals().costUsd).toBeNull();
  });

  it("keeps provider-confirmed and configured fallback models distinct across sessions", () => {
    const ledger = new UsageLedger();
    ledger.add("implementation", usage({ model: "provider-model-a" }), "configured-model");
    ledger.add("implementation", usage({ model: "provider-model-b" }), "configured-model");
    ledger.add("implementation", usage(), "configured-model");

    expect(ledger.snapshot()[0]?.models).toEqual([
      { name: "provider-model-a", source: "provider" },
      { name: "provider-model-b", source: "provider" },
      { name: "configured-model", source: "configured" },
    ]);
  });
});

describe("renderUsageTable", () => {
  it("renders per-stage rows and a bold total with agent and elapsed labeled distinctly", () => {
    const ledger = new UsageLedger();
    ledger.add(
      "implementation",
      usage({ durationMs: 28 * 60_000, costUsd: 9.0, model: "provider-model" }),
      "configured-model",
    );
    ledger.add("code-review", usage({ durationMs: 6 * 60_000, costUsd: 2.5 }), "review-model");
    ledger.add("qa", usage({ durationMs: 7 * 60_000, costUsd: 1.87 }));
    ledger.add("commit-message", usage({ durationMs: 60_000, costUsd: 0.04 }), "scribe-model");

    const table = renderUsageTable(ledger.snapshot(), (3 * 60 + 10) * 60_000);
    expect(table).toContain("| Stage | Model | Sessions | Time | Cost |");
    expect(table).toContain(
      "| Implementation | provider-model (provider-confirmed) | 1 | 28m | $9.00 |",
    );
    expect(table).toContain("| Code Review | review-model (configured) | 1 | 6m | $2.50 |");
    expect(table).toContain("| QA | not reported | 1 | 7m | $1.87 |");
    expect(table).toContain("| Scribe | scribe-model (configured) | 1 | 1m | $0.04 |");
    expect(table).toContain(
      "| **Total** |  | **4** | **agent 42m · elapsed 3h 10m** | **$13.41** |",
    );
  });

  it("renders every provider-confirmed model used by continuations in one stage", () => {
    const ledger = new UsageLedger();
    ledger.add("implementation", usage({ model: "provider-model-a" }), "configured-model");
    ledger.add("implementation", usage({ model: "provider-model-b" }), "configured-model");

    expect(renderUsageTable(ledger.snapshot(), null)).toContain(
      "| Implementation | provider-model-a (provider-confirmed), provider-model-b (provider-confirmed) |",
    );
  });

  it("appends an estimate note when any dollars in the table came from the Codex table", () => {
    const ledger = new UsageLedger();
    // A Claude row (exact) and a Codex row (table estimate) together.
    ledger.add("implementation", usage({ durationMs: 60_000, costUsd: 9.0 }));
    ledger.add("qa", usage({ durationMs: 60_000, costUsd: 1.5, isCostEstimated: true }));
    const table = renderUsageTable(ledger.snapshot(), null);
    expect(table).toContain("_Codex costs are a table estimate, runs low._");
  });

  it("omits the estimate note when every cost is provider-reported", () => {
    const ledger = new UsageLedger();
    ledger.add("implementation", usage({ durationMs: 60_000, costUsd: 9.0 }));
    expect(renderUsageTable(ledger.snapshot(), null)).not.toContain("runs low");
  });

  it("shows a token fallback in a row and the total when a session was unpriced", () => {
    const ledger = new UsageLedger();
    ledger.add(
      "qa",
      usage({ durationMs: 60_000, costUsd: null, inputTokens: 1_000_000, outputTokens: 200_000 }),
    );
    const table = renderUsageTable(ledger.snapshot(), null);
    expect(table).toContain("| QA | not reported | 1 | 1m | 1.2M tokens, price unavailable |");
    // No elapsed clause when elapsedMs is null.
    expect(table).toContain("**agent 1m**");
    expect(table).not.toContain("elapsed");
  });
});
