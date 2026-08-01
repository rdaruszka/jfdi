/** Shared entry model and validation. */

export interface Entry {
  id: number;
  /** YYYY-MM-DD */
  date: string;
  /** Dollars. */
  amount: number;
  category: string;
  description: string;
}

/** A user error: the CLI prints the message and exits 1, no stack trace. */
export class UsageError extends Error {
  override name = "UsageError";
}

export function parseAmount(raw: string): number {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new UsageError(`amount must be a positive number, got "${raw}"`);
  }
  return amount;
}

export function isIsoDate(raw: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today in the local timezone as YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatEntry(entry: Entry): string {
  const amount = entry.amount.toFixed(2).padStart(9);
  const suffix = entry.description ? `  ${entry.description}` : "";
  return `#${entry.id}  ${entry.date}  ${amount}  ${entry.category}${suffix}`;
}
