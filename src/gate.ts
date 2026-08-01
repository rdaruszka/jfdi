import { spawn } from "node:child_process";
import type { GateCommand } from "./config.js";

export interface GateCommandResult {
  name: string;
  cmd: string;
  code: number;
  /** Interleaved stdout+stderr, tail-truncated. */
  output: string;
  durationMs: number;
}

export interface GateResult {
  ok: boolean;
  results: GateCommandResult[];
}

const MAX_OUTPUT_CHARS = 20_000;

function tail(s: string): string {
  return s.length <= MAX_OUTPUT_CHARS ? s : `…(truncated)…\n${s.slice(-MAX_OUTPUT_CHARS)}`;
}

function runCommand(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => resolve({ code: 127, output: `${output}\n${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Run the mechanical gate: each command in order, in `cwd`, stopping at the
 * first non-zero exit. The gate is the cheapest reviewer and runs first, always.
 */
export async function runGate(
  gate: GateCommand[],
  cwd: string,
  onCommand?: (name: string) => void,
): Promise<GateResult> {
  const results: GateCommandResult[] = [];
  for (const { name, cmd } of gate) {
    onCommand?.(name);
    const started = Date.now();
    const { code, output } = await runCommand(cmd, cwd);
    results.push({ name, cmd, code, output: tail(output), durationMs: Date.now() - started });
    if (code !== 0) return { ok: false, results };
  }
  return { ok: true, results };
}

/** Render a gate failure as feedback for the Implementation agent. */
export function formatGateFailure(result: GateResult): string {
  const failed = result.results.at(-1);
  if (!failed) return "gate failed with no results";
  return [
    `Mechanical gate failed at step "${failed.name}" (\`${failed.cmd}\`, exit ${failed.code}).`,
    "",
    "Output:",
    "```",
    failed.output.trim(),
    "```",
  ].join("\n");
}
