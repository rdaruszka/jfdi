import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readIfExists } from "./util/fsx.js";

/**
 * Where a session's agent writes its verdict: the worktree root, the one
 * location every provider's sandboxed permission mode lets an agent write
 * (Claude's `auto` and Codex's `workspace-write` both confine writes to the
 * workspace; no flag extends Claude's boundary). The pipeline collects the
 * file into the run's state directory after the session ends — agents are
 * never asked to write outside their workspace.
 */
export function agentVerdictPath(worktreePath: string, stage: string): string {
  return path.join(worktreePath, `${stage}.verdict.json`);
}

/**
 * Move the agent's in-worktree verdict to its state-directory home. A move,
 * not a copy: a verdict left behind would be swept into the next handoff or
 * checkpoint commit. An absent source is not an error — a session that wrote
 * no verdict is the caller's invalid-verdict path. Copy-then-delete because
 * the worktree and the state directory may sit on different filesystems.
 */
export async function collectVerdict(agentPath: string, destinationPath: string): Promise<void> {
  try {
    await fs.copyFile(agentPath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(agentPath);
}

export interface ImplementationVerdict {
  status: "done" | "escalate";
  summary?: string;
  decisions?: string[];
  /** Out-of-scope issues spotted in passing — proposed as inbox cards, never fixed inline. */
  observations?: string[];
  question?: string;
  recommendation?: string;
}

export interface ReviewVerdict {
  verdict: "pass" | "fail" | "escalate";
  feedback?: string;
  testsAdded?: string;
  decisions?: string[];
  /** Out-of-scope issues spotted in passing — proposed as inbox cards, never fixed inline. */
  observations?: string[];
  question?: string;
  recommendation?: string;
}

export interface IntegrationVerdict {
  resolution: "clean" | "complicated";
  notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((x): x is string => typeof x === "string");
  return items.length > 0 ? items : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type VerdictReadResult<Verdict> =
  | { status: "valid"; verdict: Verdict }
  | { status: "missing" }
  | { status: "invalid"; error: string };

interface VerdictReadOptions {
  /** The agent-facing path to name in errors when the collected file lives elsewhere. */
  reportedPath?: string;
}

type VerdictFileReadResult = VerdictReadResult<Record<string, unknown>>;

async function readVerdictFile(
  verdictPath: string,
  options: VerdictReadOptions,
): Promise<VerdictFileReadResult> {
  const content = await readIfExists(verdictPath);
  if (content === null) return { status: "missing" };
  const reportedPath = options.reportedPath ?? verdictPath;
  try {
    // Tolerate agents wrapping the JSON in a fenced block despite instructions.
    const stripped = content.replace(/^```(?:json)?\s*\n?|\n?```\s*$/g, "").trim();
    const parsed = JSON.parse(stripped) as unknown;
    if (!isRecord(parsed)) {
      const received = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
      return {
        status: "invalid",
        error: `Top-level JSON value must be an object; received ${received}. Verdict file: ${reportedPath}`,
      };
    }
    return { status: "valid", verdict: parsed };
  } catch (error) {
    return {
      status: "invalid",
      error: `JSON parse failed: ${(error as Error).message}. Verdict file: ${reportedPath}`,
    };
  }
}

function enumError(
  raw: Record<string, unknown>,
  field: string,
  allowedValues: readonly string[],
  reportedPath: string,
): string {
  const allowed = allowedValues.map((value) => JSON.stringify(value)).join(", ");
  if (!(field in raw))
    return `required field ${JSON.stringify(field)} is missing; allowed values: ${allowed}. Verdict file: ${reportedPath}`;
  return `field ${JSON.stringify(field)} has value ${JSON.stringify(raw[field])}; allowed values: ${allowed}. Verdict file: ${reportedPath}`;
}

export async function readImplementationVerdict(
  verdictPath: string,
  options: VerdictReadOptions = {},
): Promise<VerdictReadResult<ImplementationVerdict>> {
  const file = await readVerdictFile(verdictPath, options);
  if (file.status !== "valid") return file;
  const raw = file.verdict;
  const status = raw.status;
  if (status !== "done" && status !== "escalate")
    return {
      status: "invalid",
      error: enumError(raw, "status", ["done", "escalate"], options.reportedPath ?? verdictPath),
    };
  const decisions = stringArray(raw.decisions);
  const result: ImplementationVerdict = { status };
  const summary = optionalString(raw.summary);
  if (summary) result.summary = summary;
  if (decisions) result.decisions = decisions;
  const observations = stringArray(raw.observations);
  if (observations) result.observations = observations;
  const question = optionalString(raw.question);
  if (question) result.question = question;
  const recommendation = optionalString(raw.recommendation);
  if (recommendation) result.recommendation = recommendation;
  return { status: "valid", verdict: result };
}

export async function readReviewVerdict(
  verdictPath: string,
  options: { isEscalateAllowed: boolean } & VerdictReadOptions,
): Promise<VerdictReadResult<ReviewVerdict>> {
  const file = await readVerdictFile(verdictPath, options);
  if (file.status !== "valid") return file;
  const raw = file.verdict;
  const verdict = raw.verdict;
  const allowedValues = options.isEscalateAllowed
    ? (["pass", "fail", "escalate"] as const)
    : (["pass", "fail"] as const);
  if (
    (verdict !== "pass" && verdict !== "fail" && verdict !== "escalate") ||
    (verdict === "escalate" && !options.isEscalateAllowed)
  )
    return {
      status: "invalid",
      error: enumError(raw, "verdict", allowedValues, options.reportedPath ?? verdictPath),
    };
  const result: ReviewVerdict = { verdict };
  const feedback = optionalString(raw.feedback);
  if (feedback) result.feedback = feedback;
  const testsAdded = optionalString(raw.testsAdded);
  if (testsAdded) result.testsAdded = testsAdded;
  const decisions = stringArray(raw.decisions);
  if (decisions) result.decisions = decisions;
  const observations = stringArray(raw.observations);
  if (observations) result.observations = observations;
  const question = optionalString(raw.question);
  if (question) result.question = question;
  const recommendation = optionalString(raw.recommendation);
  if (recommendation) result.recommendation = recommendation;
  return { status: "valid", verdict: result };
}

export async function readIntegrationVerdict(
  verdictPath: string,
  options: VerdictReadOptions = {},
): Promise<VerdictReadResult<IntegrationVerdict>> {
  const file = await readVerdictFile(verdictPath, options);
  if (file.status !== "valid") return file;
  const raw = file.verdict;
  const resolution = raw.resolution;
  if (resolution !== "clean" && resolution !== "complicated")
    return {
      status: "invalid",
      error: enumError(
        raw,
        "resolution",
        ["clean", "complicated"],
        options.reportedPath ?? verdictPath,
      ),
    };
  const result: IntegrationVerdict = { resolution };
  const notes = optionalString(raw.notes);
  if (notes) result.notes = notes;
  return { status: "valid", verdict: result };
}
