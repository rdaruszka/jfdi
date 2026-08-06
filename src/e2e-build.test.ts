import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(import.meta.dirname);
const CLI_TIMEOUT_MS = 30_000;

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

  it("leaves a runnable CLI in dist/ that global setup built before any e2e test", async () => {
    // The whole point of the single global build: every e2e file spawns the CLI
    // from this dist/ without building it. If global setup did not run (or built
    // a torn dist/), the CLI would be missing or exit non-zero — the exact
    // `jfdi help -> exit 1` symptom this ticket removes. Prove the positive: the
    // artifact global setup produced launches and its help exits 0.
    const cliPath = path.join(repoRoot, "dist", "index.js");
    await expect(fs.stat(cliPath)).resolves.toBeDefined();

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "help"], {
      cwd: repoRoot,
      timeout: CLI_TIMEOUT_MS,
    });
    expect(stdout).toContain("jfdi");
  });

  it("keeps test harness doubles out of the production build", async () => {
    const harnessArtifacts = await fs.readdir(path.join(repoRoot, "dist", "harness"));

    expect(harnessArtifacts.filter((artifact) => artifact.startsWith("fake."))).toEqual([]);
  });

  it("ships no fake harness code anywhere in dist, under any filename", async () => {
    // The filename check above only guards dist/harness/fake.*. The acceptance
    // criterion is broader: NO fake/double code lands in dist under any path. A
    // reintroduced double inline in a production file, or a stray build of
    // test-helpers.ts, would clear the filename check while still shipping the
    // mock. Pin it by symbol across the whole tree — this is the actual product
    // surface a consumer installs.
    const distRoot = path.join(repoRoot, "dist");

    async function jsFilesUnder(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return jsFilesUnder(full);
          return entry.name.endsWith(".js") ? [full] : [];
        }),
      );
      return nested.flat();
    }

    const jsFiles = await jsFilesUnder(distRoot);
    const contents = await Promise.all(
      jsFiles.map(async (file) => ({ file, source: await fs.readFile(file, "utf8") })),
    );
    const leaked = contents
      .filter(({ source }) => /\bFakeHarness\b|\bFakeHandler\b/.test(source))
      .map(({ file }) => path.relative(distRoot, file));

    expect(leaked).toEqual([]);
    // Guard the relocation target itself: test-helpers.ts is test code and must
    // never compile into the shipped tree.
    expect(jsFiles.map((file) => path.relative(distRoot, file))).not.toContain("test-helpers.js");
  });
});
