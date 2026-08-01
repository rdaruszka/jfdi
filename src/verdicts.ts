import { readIfExists } from "./util/fsx.js";

export interface ImplementationVerdict {
  status: "done" | "escalate";
  summary?: string;
  decisions?: string[];
  question?: string;
  recommendation?: string;
}

export interface ReviewVerdict {
  verdict: "pass" | "fail" | "escalate";
  feedback?: string;
  testsAdded?: string;
  decisions?: string[];
  question?: string;
  recommendation?: string;
}

export interface IntegrationVerdict {
  resolution: "clean" | "complicated";
  notes?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === "string");
  return items.length > 0 ? items : undefined;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
  const decisions = strArray(raw.decisions);
  const out: ImplementationVerdict = { status };
  const summary = optStr(raw.summary);
  if (summary) out.summary = summary;
  if (decisions) out.decisions = decisions;
  const question = optStr(raw.question);
  if (question) out.question = question;
  const recommendation = optStr(raw.recommendation);
  if (recommendation) out.recommendation = recommendation;
  return out;
}

export async function readReviewVerdict(
  path: string,
  opts: { allowEscalate: boolean },
): Promise<ReviewVerdict | null> {
  const raw = await readVerdictFile(path);
  if (!raw) return null;
  const verdict = raw.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "escalate") return null;
  if (verdict === "escalate" && !opts.allowEscalate) return null;
  const out: ReviewVerdict = { verdict };
  const feedback = optStr(raw.feedback);
  if (feedback) out.feedback = feedback;
  const testsAdded = optStr(raw.testsAdded);
  if (testsAdded) out.testsAdded = testsAdded;
  const decisions = strArray(raw.decisions);
  if (decisions) out.decisions = decisions;
  const question = optStr(raw.question);
  if (question) out.question = question;
  const recommendation = optStr(raw.recommendation);
  if (recommendation) out.recommendation = recommendation;
  return out;
}

export async function readIntegrationVerdict(path: string): Promise<IntegrationVerdict | null> {
  const raw = await readVerdictFile(path);
  if (!raw) return null;
  const resolution = raw.resolution;
  if (resolution !== "clean" && resolution !== "complicated") return null;
  const out: IntegrationVerdict = { resolution };
  const notes = optStr(raw.notes);
  if (notes) out.notes = notes;
  return out;
}
