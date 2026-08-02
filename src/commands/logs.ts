import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runsDir } from "../pipeline.js";
import { buildContext } from "./context.js";

const RUN_DIR_RE = /^run-\d+$/;
/** Characters in the `run-` prefix, stripped to compare run directories numerically. */
const RUN_DIR_PREFIX_LENGTH = "run-".length;

/** `jfdi logs <ticket>` — dump the latest run's raw session logs. */
export async function logsCommand(ticketId: string): Promise<number> {
  const context = await buildContext();
  const base = runsDir(context.stateDir, ticketId);
  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch {
    console.error(`no runs recorded for ticket "${ticketId}"`);
    return 1;
  }
  const runs = entries
    .filter((entry) => RUN_DIR_RE.test(entry))
    .sort(
      (a, b) => Number(a.slice(RUN_DIR_PREFIX_LENGTH)) - Number(b.slice(RUN_DIR_PREFIX_LENGTH)),
    );
  const latest = runs.at(-1);
  const dirs = [...(latest ? [path.join(base, latest)] : []), path.join(base, "integration")];
  let printed = false;
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      const rounds = await fs.readdir(dir, { recursive: true });
      files = rounds
        .filter((f) => String(f).endsWith(".log.jsonl"))
        .map(String)
        .sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      console.log(`\n===== ${path.relative(context.stateDir, full)} =====`);
      console.log(await fs.readFile(full, "utf8"));
      printed = true;
    }
  }
  if (!printed) {
    console.error(`no session logs found for ticket "${ticketId}"`);
    return 1;
  }
  return 0;
}
