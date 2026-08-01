import * as fs from "node:fs/promises";
import { type Entry, formatEntry, isIsoDate, parseAmount, today, UsageError } from "../entry.js";

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

async function saveEntries(entries: Entry[]): Promise<void> {
  await fs.writeFile(dataFile(), `${JSON.stringify(entries, null, 2)}\n`);
}

function splitDateFlag(args: string[]): { positional: string[]; date: string | undefined } {
  const positional: string[] = [];
  let date: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--date") {
      const value = args[++i];
      if (!value || !isIsoDate(value)) throw new UsageError("--date expects YYYY-MM-DD");
      date = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, date };
}

export async function addCommand(args: string[]): Promise<string> {
  const { positional, date } = splitDateFlag(args);
  const [rawAmount, category, ...rest] = positional;
  if (!rawAmount || !category) {
    throw new UsageError(
      "usage: penny add <amount> <category> [description...] [--date YYYY-MM-DD]",
    );
  }
  const amount = parseAmount(rawAmount);
  const entries = await loadEntries();
  const entry: Entry = {
    id: entries.length + 1,
    date: date ?? today(),
    amount,
    category,
    description: rest.join(" "),
  };
  entries.push(entry);
  await saveEntries(entries);
  return `Added ${formatEntry(entry)}`;
}
