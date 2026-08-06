/**
 * Per-model cost and time accounting, and the one place its prose format lives.
 *
 * A run's sessions each report a provider-neutral {@link SessionUsage}; the
 * {@link UsageLedger} tallies them per stage (Implementation / Code Review / QA
 * / Scribe / Integration) so a table can show what a ticket cost. Dollars and
 * time are what humans read (§1 of the cost-reporting ticket); tokens are the
 * machine record and the fallback when no price is known — `unknown` there is a
 * deliberate signal, never a fabricated number.
 */
import type { SessionKind, SessionUsage } from "./harness/types.js";

/** The rows a usage table shows, in the order it shows them. */
export const USAGE_ROW_LABELS = [
  "Implementation",
  "Code Review",
  "QA",
  "Scribe",
  "Integration",
] as const;
export type UsageRowLabel = (typeof USAGE_ROW_LABELS)[number];

export interface UsageModel {
  name: string;
  source: "provider" | "configured";
}

/** Which table row a session's kind rolls up into. The scribe is not a stage. */
const SESSION_KIND_ROW: Record<SessionKind, UsageRowLabel> = {
  implementation: "Implementation",
  "code-review": "Code Review",
  qa: "QA",
  integration: "Integration",
  "commit-message": "Scribe",
};

/** One row's models and running totals across the sessions that rolled into it. */
export interface UsageRow {
  label: UsageRowLabel;
  /** Distinct models used by this row's sessions, in first-seen order. */
  models: UsageModel[];
  sessions: number;
  durationMs: number;
  /** Summed dollars for sessions whose price was known. */
  knownCostUsd: number;
  /** Sessions with no known price — the row cannot state exact dollars for these. */
  unknownCostSessions: number;
  /** Sessions whose dollars are a price-table estimate (Codex), not provider-reported. */
  estimatedCostSessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * The note appended below a table, and beside a trailer's dollars, when any of
 * the cost came from the Codex price table: it runs low because Codex reports no
 * cache-write or long-context counts to bill (see `codex-pricing.ts`).
 */
export const COST_ESTIMATE_NOTE = "estimate, runs low";

/** A run's grand totals, as the Total row and the state snapshot read them. */
export interface UsageTotals {
  sessions: number;
  durationMs: number;
  /** Null when any session's cost was unknown — no honest single dollar figure exists. */
  costUsd: number | null;
  totalTokens: number;
}

/** Total billed tokens for a row: input plus output (cached input is a subset of input). */
function rowTokens(row: Pick<UsageRow, "inputTokens" | "outputTokens">): number {
  return row.inputTokens + row.outputTokens;
}

/**
 * Per-run tally of session usage. One instance lives on the pipeline context and
 * every session — stage, scribe, integration — adds itself as it completes.
 */
export class UsageLedger {
  private readonly rows = new Map<UsageRowLabel, UsageRow>();

  add(kind: SessionKind, usage: SessionUsage, configuredModel?: string): void {
    const label = SESSION_KIND_ROW[kind];
    const row = this.rows.get(label) ?? {
      label,
      models: [],
      sessions: 0,
      durationMs: 0,
      knownCostUsd: 0,
      unknownCostSessions: 0,
      estimatedCostSessions: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    const model = resolveUsageModel(usage, configuredModel);
    if (
      model !== null &&
      !row.models.some(
        (existing) => existing.name === model.name && existing.source === model.source,
      )
    )
      row.models.push(model);
    row.sessions += 1;
    row.durationMs += usage.durationMs;
    if (usage.costUsd === null) row.unknownCostSessions += 1;
    else row.knownCostUsd += usage.costUsd;
    if (usage.isCostEstimated) row.estimatedCostSessions += 1;
    row.inputTokens += usage.inputTokens;
    row.cachedInputTokens += usage.cachedInputTokens;
    row.outputTokens += usage.outputTokens;
    this.rows.set(label, row);
  }

  /** The non-empty rows, in table order — a plain-data snapshot safe to persist. */
  snapshot(): UsageRow[] {
    return USAGE_ROW_LABELS.map((label) => this.rows.get(label)).filter(
      (row): row is UsageRow => row !== undefined,
    );
  }

  totals(): UsageTotals {
    return usageTotals(this.snapshot());
  }
}

/**
 * Per-ticket ledgers, keyed by ticket id. The coordinator shares one pipeline
 * context across concurrent runs, so a single ledger would interleave tickets;
 * this keeps each run's tally its own. A run's entry `start`s a fresh ledger and
 * a terminal transition `finish`es it, so the map stays bounded by live runs.
 */
export class UsageRegistry {
  private readonly byTicket = new Map<string, UsageLedger>();

  /** Begin a fresh tally for a run, discarding any prior one for that ticket. */
  start(ticketId: string): void {
    this.byTicket.set(ticketId, new UsageLedger());
  }

  /** The ticket's ledger, created empty if a session arrives before `start`. */
  of(ticketId: string): UsageLedger {
    const existing = this.byTicket.get(ticketId);
    if (existing) return existing;
    const ledger = new UsageLedger();
    this.byTicket.set(ticketId, ledger);
    return ledger;
  }

  add(ticketId: string, kind: SessionKind, usage: SessionUsage, configuredModel?: string): void {
    this.of(ticketId).add(kind, usage, configuredModel);
  }

  /** Drop a completed run's ledger — call on merged/failed/blocked. */
  finish(ticketId: string): void {
    this.byTicket.delete(ticketId);
  }
}

/** Fold a set of rows into grand totals — cost is null if any session was unpriced. */
export function usageTotals(rows: readonly UsageRow[]): UsageTotals {
  let sessions = 0;
  let durationMs = 0;
  let knownCostUsd = 0;
  let unknownCostSessions = 0;
  let totalTokens = 0;
  for (const row of rows) {
    sessions += row.sessions;
    durationMs += row.durationMs;
    knownCostUsd += row.knownCostUsd;
    unknownCostSessions += row.unknownCostSessions;
    totalTokens += rowTokens(row);
  }
  return {
    sessions,
    durationMs,
    costUsd: unknownCostSessions > 0 ? null : knownCostUsd,
    totalTokens,
  };
}

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const THOUSAND = 1_000;
const MILLION = 1_000_000;

/** Human duration: `42s`, `7m`, `1h 10m`. Zero is `0s`, never blank. */
export function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / MS_PER_SECOND);
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${hours}h ${minutes}m`;
}

/** Compact token count for the price-unknown fallback: `800`, `45K`, `1.2M`. */
export function formatTokens(tokens: number): string {
  if (tokens < THOUSAND) return `${tokens}`;
  if (tokens < MILLION) return `${(tokens / THOUSAND).toFixed(1)}K`;
  return `${(tokens / MILLION).toFixed(1)}M`;
}

/** Dollars as prose, or the token fallback when no price is known. */
export function formatCostUsd(costUsd: number | null, totalTokens: number): string {
  return costUsd === null
    ? `${formatTokens(totalTokens)} tokens, price unavailable`
    : `$${costUsd.toFixed(2)}`;
}

/** The cost cell of one usage-table row. */
function rowCostCell(row: UsageRow): string {
  return formatCostUsd(row.unknownCostSessions > 0 ? null : row.knownCostUsd, rowTokens(row));
}

/** Prefer what the provider says ran; use configured intent only when it says nothing. */
export function resolveUsageModel(
  usage: SessionUsage,
  configuredModel: string | undefined,
): UsageModel | null {
  if (usage.model !== undefined) return { name: usage.model, source: "provider" };
  if (configuredModel !== undefined) return { name: configuredModel, source: "configured" };
  return null;
}

function rowModelCell(row: UsageRow): string {
  if (row.models.length === 0) return "not reported";
  return row.models
    .map((model) =>
      model.source === "provider"
        ? `${model.name} (provider-confirmed)`
        : `${model.name} (configured)`,
    )
    .join(", ");
}

/**
 * The per-stage model/cost/time table the ready-to-merge and merged comments carry.
 * `elapsedMs` is dispatch→now wall-clock, shown beside agent time in the Total
 * row and labeled distinctly (§1/§2 of the ticket); null omits the elapsed clause.
 */
export function renderUsageTable(rows: readonly UsageRow[], elapsedMs: number | null): string {
  const totals = usageTotals(rows);
  const header = ["| Stage | Model | Sessions | Time | Cost |", "|---|---|---|---|---|"];
  const body = rows.map(
    (row) =>
      `| ${row.label} | ${rowModelCell(row)} | ${row.sessions} | ${formatDurationMs(row.durationMs)} | ${rowCostCell(row)} |`,
  );
  const totalTime =
    elapsedMs === null
      ? `agent ${formatDurationMs(totals.durationMs)}`
      : `agent ${formatDurationMs(totals.durationMs)} · elapsed ${formatDurationMs(elapsedMs)}`;
  const totalRow = `| **Total** |  | **${totals.sessions}** | **${totalTime}** | **${formatCostUsd(totals.costUsd, totals.totalTokens)}** |`;
  const table = [...header, ...body, totalRow].join("\n");
  // One brief note when any dollars in the table are Codex table estimates.
  const hasEstimate = rows.some((row) => row.estimatedCostSessions > 0);
  return hasEstimate ? `${table}\n\n_Codex costs are a table ${COST_ESTIMATE_NOTE}._` : table;
}

/** The one-line cost + time a `jfdi status` / TUI ticket row appends. */
export function formatRunningTotals(
  costUsd: number | null,
  agentMs: number,
  totalTokens: number,
): string {
  return `${formatCostUsd(costUsd, totalTokens)} · agent ${formatDurationMs(agentMs)}`;
}
