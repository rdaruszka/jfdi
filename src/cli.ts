const USAGE = `jfdi — Just F'ing Do It

Usage:
  jfdi run <ticket>     Run one ticket through the full pipeline (card text,
                        [[wikilink]], or an inline description). Add --force to
                        run a ticket whose blocked-by tickets are not yet done.
  jfdi start            Watch the board and run pipelines continuously (live TUI)
  jfdi status [--json]  Snapshot of coordinator state
  jfdi logs <ticket>    Dump a ticket's raw session logs
  jfdi merge <ticket>   Approve a Ready-to-Merge ticket (on-approval mode)
  jfdi convo            Interactive session scoped to the JFDI layer itself
  jfdi init             Scaffold .jfdi/ and set up the mechanical gate
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run": {
        const isForced = rest.includes("--force");
        const ref = rest
          .filter((arg) => arg !== "--force")
          .join(" ")
          .trim();
        if (!ref) return usageError("jfdi run <ticket> — a ticket reference is required");
        const { runCommand } = await import("./commands/run.js");
        return await runCommand(ref, { isForced });
      }
      case "start": {
        const { startCommand } = await import("./commands/start.js");
        return await startCommand();
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
      case "convo": {
        const { convoCommand } = await import("./commands/convo.js");
        return await convoCommand();
      }
      case "init": {
        const { initCommand } = await import("./commands/init.js");
        return await initCommand({ isBare: rest.includes("--bare") });
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
