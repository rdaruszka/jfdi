import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_TIMEOUT_MS = 180_000;

export default async function buildCLI(): Promise<void> {
  await execFileAsync("pnpm", ["build"], {
    cwd: import.meta.dirname,
    timeout: BUILD_TIMEOUT_MS,
  });
}
