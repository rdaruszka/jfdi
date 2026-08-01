#!/usr/bin/env node
import { addCommand } from "./commands/add.js";
import { listCommand } from "./commands/list.js";
import { totalCommand } from "./commands/total.js";
import { UsageError } from "./entry.js";

const USAGE = `penny — a tiny expense ledger

Usage:
  penny add <amount> <category> [description...] [--date YYYY-MM-DD]
  penny list
  penny total

Entries are stored in penny.json in the current directory
(override with the PENNY_FILE environment variable).`;

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case "add":
        console.log(await addCommand(args));
        return 0;
      case "list":
        console.log(await listCommand(args));
        return 0;
      case "total":
        console.log(await totalCommand(args));
        return 0;
      case undefined:
      case "help":
      case "--help":
        console.log(USAGE);
        return command === undefined ? 1 : 0;
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

process.exitCode = await main();
