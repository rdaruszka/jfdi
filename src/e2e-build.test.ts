import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.dirname(import.meta.dirname);

describe("e2e build setup", () => {
  it("builds once in global setup and never from an e2e file", async () => {
    const vitestConfig = await fs.readFile(path.join(repoRoot, "vitest.config.ts"), "utf8");
    expect(vitestConfig).toContain('globalSetup: ["./vitest.global-setup.ts"]');

    const globalSetup = await fs.readFile(path.join(repoRoot, "vitest.global-setup.ts"), "utf8");
    expect(globalSetup.match(/execFileAsync\("pnpm", \["build"\]/g)).toHaveLength(1);

    const sourceFiles = await fs.readdir(path.join(repoRoot, "src"));
    const e2eFiles = sourceFiles.filter((file) => file.endsWith(".e2e.test.ts"));
    expect(e2eFiles.length).toBeGreaterThan(0);

    const e2eSources = await Promise.all(
      e2eFiles.map((file) => fs.readFile(path.join(repoRoot, "src", file), "utf8")),
    );
    expect(
      e2eSources.filter((source) => /execFileAsync\("pnpm", \["build"\]/.test(source)),
    ).toEqual([]);
  });
});
