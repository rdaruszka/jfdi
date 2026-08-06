import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_TIMEOUT_MS = 180_000;

export default async function buildCLI(): Promise<void> {
  await fs.rm(path.join(import.meta.dirname, "dist"), { recursive: true, force: true });
  await execFileAsync("pnpm", ["build"], {
    cwd: import.meta.dirname,
    timeout: BUILD_TIMEOUT_MS,
  });
}
