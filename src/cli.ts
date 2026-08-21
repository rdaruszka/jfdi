import type { InitOptions } from "./commands/init.js";
import type { StartOptions } from "./commands/start.js";

const USAGE = `jfdi — Just F'ing Do It

Usage:
  jfdi run <ticket>     Run one ticket through the full pipeline (card text,
                        [[wikilink]], or an inline description). Add --force to
                        run a ticket whose blocked-by tickets are not yet done.
  jfdi start [options]  Watch the board and run pipelines continuously
  jfdi status [--json]  Snapshot of coordinator state
  jfdi logs <ticket>    Dump a ticket's raw session logs
  jfdi merge <ticket>   Approve a Ready-to-Merge ticket (on-approval mode)
  jfdi update-config    Rewrite legacy config keys to the canonical schema
  jfdi init [options]   Scaffold .jfdi/ and conversationally tune the setup

Init options:
  --bare                Scaffold only; do not launch an interactive session
  --harness <provider>  claude or codex (default: claude)
  --model <model>       Provider model (default: claude-fable-5)
  --effort <level>      Provider effort (default: provider default)

Start options:
  --front-end <name>    terminal or web (default: config, then terminal)
`;

function optionValue(args: string[], index: number): string {
  const option = args[index];
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case "--bare":
        options.isBare = true;
        break;
      case "--harness": {
        const harness = optionValue(args, index);
        if (harness !== "claude" && harness !== "codex") {
          throw new Error(`--harness must be "claude" or "codex", got "${harness}"`);
        }
        options.harness = harness;
        index += 1;
        break;
      }
      case "--model":
        options.model = optionValue(args, index);
        index += 1;
        break;
      case "--effort":
        options.effort = optionValue(args, index);
        index += 1;
        break;
      default:
        throw new Error(`unknown init option "${option}"`);
    }
  }
  return options;
}

export function parseStartOptions(args: string[]): StartOptions {
  const options: StartOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--front-end") throw new Error(`unknown start option "${option}"`);
    const frontEnd = optionValue(args, index);
    if (frontEnd !== "terminal" && frontEnd !== "web")
      throw new Error(`--front-end must be "terminal" or "web", got "${frontEnd}"`);
    options.frontEnd = frontEnd;
    index += 1;
  }
  return options;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run": {
        const isForced = rest.includes("--force");
        const ticketReference = rest
          .filter((argument) => argument !== "--force")
          .join(" ")
          .trim();
        if (!ticketReference)
          return usageError("jfdi run <ticket> — a ticket reference is required");
        const { runCommand } = await import("./commands/run.js");
        return await runCommand(ticketReference, { isForced });
      }
      case "start": {
        const { startCommand } = await import("./commands/start.js");
        return await startCommand(parseStartOptions(rest));
      }
      case "status": {
        const { statusCommand } = await import("./commands/status.js");
        return await statusCommand({ shouldEmitJson: rest.includes("--json") });
      }
      case "logs": {
        const id = rest[0];
        if (!id) return usageError("jfdi logs <ticket-id>");
        const { logsCommand } = await import("./commands/logs.js");
        return await logsCommand(id);
      }
      case "merge": {
        const id = rest[0];
        if (!id) return usageError("jfdi merge <ticket-id>");
        const { mergeCommand } = await import("./commands/merge.js");
        return await mergeCommand(id);
      }
      case "update-config": {
        const { updateConfigCommand } = await import("./commands/update-config.js");
        return await updateConfigCommand();
      }
      case "init": {
        const { initCommand } = await import("./commands/init.js");
        return await initCommand(parseInitOptions(rest));
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        return usageError(`unknown command "${command}"`);
    }
  } catch (error) {
    console.error(`jfdi: ${(error as Error).message}`);
    return 1;
  }
}

function usageError(message: string): number {
  console.error(`jfdi: ${message}\n`);
  console.error(USAGE);
  return 1;
}
