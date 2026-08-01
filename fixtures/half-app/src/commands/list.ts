import * as fs from "node:fs/promises";
import { type Entry, formatEntry, UsageError } from "../entry.js";

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

export async function listCommand(args: string[]): Promise<string> {
  if (args.length > 0) {
    throw new UsageError(`list takes no arguments, got: ${args.join(" ")}`);
  }
  const entries = await loadEntries();
  if (entries.length === 0) return "No entries.";
  return entries.map(formatEntry).join("\n");
}
