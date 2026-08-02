import { readIfExists } from "./util/fsx.js";

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

async function readVerdictFile(path: string): Promise<Record<string, unknown> | null> {
  const content = await readIfExists(path);
  if (content === null) return null;
  try {
    // Tolerate agents wrapping the JSON in a fenced block despite instructions.
    const stripped = content.replace(/^```(?:json)?\s*\n?|\n?```\s*$/g, "").trim();
    const parsed = JSON.parse(stripped) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readImplementationVerdict(
  path: string,
): Promise<ImplementationVerdict | null> {
  const raw = await readVerdictFile(path);
  if (!raw) return null;
  const status = raw.status;
  if (status !== "done" && status !== "escalate") return null;
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
  return result;
}

export async function readReviewVerdict(
  path: string,
  options: { allowEscalate: boolean },
): Promise<ReviewVerdict | null> {
  const raw = await readVerdictFile(path);
  if (!raw) return null;
  const verdict = raw.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "escalate") return null;
  if (verdict === "escalate" && !options.allowEscalate) return null;
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
  return result;
}

export async function readIntegrationVerdict(path: string): Promise<IntegrationVerdict | null> {
  const raw = await readVerdictFile(path);
  if (!raw) return null;
  const resolution = raw.resolution;
  if (resolution !== "clean" && resolution !== "complicated") return null;
  const result: IntegrationVerdict = { resolution };
  const notes = optionalString(raw.notes);
  if (notes) result.notes = notes;
  return result;
}
