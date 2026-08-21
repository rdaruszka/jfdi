/**
 * End-to-end acceptance for the init symptom of jfdi-hangs-on-exit: after an
 * interactive agent session ends, the jfdi process must exit on its own.
 *
 * `jfdi init` launches the agent through the harness's interactive path
 * (`spawnInteractive`, `stdio: "inherit"`). A live interactive session leaves
 * the parent's `process.stdin` in flowing mode; while it flows it is a
 * referenced libuv handle that keeps the event loop — and so the whole process
 * — alive after the child has exited, which is the hang: the shell prompt never
 * comes back. The fix releases (pauses) stdin when the interactive launch
 * settles, dropping that reference so the loop can drain and the process exit.
 *
 * This drives the built harness in a real subprocess (the sandbox contract:
 * exercise the artifact, not the source). It reproduces the loop-holding state
 * with `process.stdin.resume()`, runs one interactive launch against a stub
 * agent that exits, and reports whether stdin was left released. Asserting that
 * released state — rather than racing the process's own exit — is the
 * deterministic form of "the process can now let go of the terminal": before the
 * fix stdin stays flowing (`released=false`) and the process would hang; after
 * it, stdin is paused (`released=true`) and the loop is free to end.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(import.meta.dirname);
const distDirectory = path.join(projectRoot, "dist");

/** Cap on the whole subprocess — it exits on its own, so this only guards a wedge. */
const CHILD_TIMEOUT_MS = 15_000;

/**
 * The child, as source: import the built harness, put stdin into the flowing
 * state a live session leaves, run one interactive launch against the stub, then
 * report whether the harness released stdin. It exits explicitly so the check is
 * the reported state, never the process's lifetime.
 */
function childSource(harnessModuleUrl: string, className: string, executable: string): string {
  return [
    `const mod = await import(${JSON.stringify(harnessModuleUrl)});`,
    "process.stdin.resume();",
    `const harness = new mod[${JSON.stringify(className)}]({ sessionKind: "implementation" }, "bypass", ${JSON.stringify(
      executable,
    )});`,
    'const code = await harness.spawnInteractive("brief", { cwd: process.cwd() });',
    'process.stdout.write("released=" + process.stdin.isPaused() + " code=" + code + "\\n");',
    "process.exit(0);",
  ].join("\n");
}

const sandboxRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function runInteractiveChild(harnessModule: string, className: string): Promise<string> {
  const sandboxRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-int-exit-")));
  sandboxRoots.push(sandboxRoot);
  const executable = path.join(sandboxRoot, "agent");
  // A stub interactive agent: the session ends the moment it starts.
  await fs.writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0)\n", { mode: 0o755 });
  const harnessModuleUrl = pathToFileURL(path.join(distDirectory, harnessModule)).href;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", childSource(harnessModuleUrl, className, executable)],
    { cwd: sandboxRoot, timeout: CHILD_TIMEOUT_MS },
  );
  return stdout;
}

describe("a jfdi process can exit after its interactive session ends", () => {
  it.each([
    { module: "harness/claude.js", className: "ClaudeHarness" },
    { module: "harness/codex.js", className: "CodexHarness" },
  ])("releases stdin after a $className interactive launch", async ({ module, className }) => {
    const output = await runInteractiveChild(module, className);

    // The session ran and settled with its code, and stdin — flowing throughout —
    // was released, so nothing is left holding the event loop open.
    expect(output).toContain("code=0");
    expect(output).toContain("released=true");
  });
});
