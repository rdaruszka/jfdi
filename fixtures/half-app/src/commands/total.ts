import * as fs from "node:fs/promises";
import { type Entry, UsageError } from "../entry.js";

function dataFile(): string {
  return process.env.PENNY_FILE ?? "penny.json";
}

async function loadEntries(): Promise<Entry[]> {
  try {
    return JSON.parse(await fs.readFile(dataFile(), "utf8")) as Entry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function totalCommand(args: string[]): Promise<string> {
  if (args.length > 0) {
    throw new UsageError(`total takes no arguments, got: ${args.join(" ")}`);
  }
  const entries = await loadEntries();
  let sum = 0;
  for (const entry of entries) sum += entry.amount;
  return `Total: ${sum}`;
}
