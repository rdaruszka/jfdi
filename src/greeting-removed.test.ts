import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for ticket greeting-dead-module.
//
// The milestone-0 smoke scaffold `src/greeting.ts` — a `greeting()` that
// returned a fixed "jfdi: hello, world" string, verified only by a test
// asserting that constant against itself — was deleted as dead code. The
// mechanical gate (tsc) already rejects a *dangling* import to a removed
// module, so this guard covers what the gate cannot: the scaffold creeping
// back in. Per the ticket, reintroduction is allowed only if a maintainer
// deliberately keeps it as a documented smoke/canary target — undocumented
// dead scaffolding is the defect either way.

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

describe("milestone-0 greeting scaffold stays removed", () => {
  it("has no src/greeting.ts unless it is documented as a deliberate canary", async () => {
    let source: string | null = null;
    try {
      source = await fs.readFile(path.join(SRC_DIR, "greeting.ts"), "utf8");
    } catch {
      source = null; // absent — the expected state after the deletion
    }
    if (source !== null) {
      expect(
        /canary|smoke/i.test(source),
        "src/greeting.ts was reintroduced without documenting it as a deliberate smoke/canary target — delete it, or add a comment stating why it must stay",
      ).toBe(true);
    }
  });

  it("no source module imports a greeting module", async () => {
    // A module specifier ending in `/greeting[.js]` — distinct from the
    // "Add a greeting" ticket-text strings the e2e suite feeds as fixtures,
    // which never appear as a slashed import path.
    const importPattern = /(?:from|import\(?)\s*["'][^"']*\/greeting(?:\.js|\.ts)?["']/;
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC_DIR)) {
      const text = await fs.readFile(file, "utf8");
      if (importPattern.test(text)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(
      offenders,
      `dangling import(s) of the removed greeting module in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
