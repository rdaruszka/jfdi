import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type { GateCommand } from "./config.js";
import { EXIT_COMMAND_NOT_EXECUTABLE } from "./util/exit-codes.js";

export interface GateCommandResult {
  name: string;
  command: string;
  code: number;
  /** Interleaved stdout+stderr excerpt sized for prompt context. */
  output: string;
  durationMs: number;
}

export interface GateResult {
  ok: boolean;
  results: GateCommandResult[];
  /** Absolute path to the complete combined gate transcript. */
  logPath: string;
}

/** Transcript characters quoted into prompts; the complete output stays in `logPath`. */
const MAX_PROMPT_OUTPUT_CHARS = 20_000;
const TRUNCATION_MARKER = "\n…(middle truncated; full output is in the gate log)…\n";
const MILLISECONDS_PER_SECOND = 1_000;

function promptExcerpt(output: string): string {
  if (output.length <= MAX_PROMPT_OUTPUT_CHARS) return output;
  const contentChars = MAX_PROMPT_OUTPUT_CHARS - TRUNCATION_MARKER.length;
  const headChars = Math.ceil(contentChars / 2);
  const tailChars = contentChars - headChars;
  return `${output.slice(0, headChars)}${TRUNCATION_MARKER}${output.slice(-tailChars)}`;
}

function runCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) =>
      resolve({ code: EXIT_COMMAND_NOT_EXECUTABLE, output: `${output}\n${error.message}` }),
    );
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
  logPath: string,
  onCommand?: (name: string) => void,
): Promise<GateResult> {
  const fullResults: GateCommandResult[] = [];
  for (const { name, command } of gate) {
    onCommand?.(name);
    const started = Date.now();
    const { code, output } = await runCommand(command, cwd);
    fullResults.push({ name, command, code, output, durationMs: Date.now() - started });
    if (code !== 0) break;
  }
  await fs.writeFile(logPath, fullResults.map((result) => result.output).join(""), "utf8");
  const results = fullResults.map((result) => ({
    ...result,
    output: promptExcerpt(result.output),
  }));
  return { ok: results.every((result) => result.code === 0), results, logPath };
}

/**
 * Render a passing gate as prompt context for reviewers, so they trust the
 * mechanical result instead of burning session turns re-running it.
 */
export function formatGatePass(result: GateResult): string {
  if (result.results.length === 0) return "";
  const steps = result.results
    .map((step) => `${step.name} ✓ (${(step.durationMs / MILLISECONDS_PER_SECOND).toFixed(1)}s)`)
    .join(", ");
  return [
    `The mechanical gate has already passed on the current commit: ${steps}.`,
    "Do not re-run the gate commands — spend your session on what they cannot check.",
  ].join("\n");
}

/** Render a gate failure as feedback for the Implementation agent. */
export function formatGateFailure(result: GateResult): string {
  const failed = result.results.at(-1);
  if (!failed) return "gate failed with no results";
  return [
    `Mechanical gate failed at step "${failed.name}" (\`${failed.command}\`, exit ${failed.code}).`,
    `Full output: \`${result.logPath}\``,
    "",
    "Prompt-sized output excerpt (head and tail):",
    "```",
    failed.output.trim(),
    "```",
  ].join("\n");
}
