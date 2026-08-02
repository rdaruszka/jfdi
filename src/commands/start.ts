import * as path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { Coordinator } from "../coordinator.js";
import { App } from "../tui/App.js";
import { EXIT_SIGINT, EXIT_SIGTERM } from "../util/exit-codes.js";
import { attachInlinePrinter, buildContext } from "./context.js";

/**
 * `jfdi start` — coordinator multi-mode: watch the board, dispatch concurrently,
 * serialize integration, and present the live TUI (or plain streaming when not
 * attached to a TTY).
 */
export async function startCommand(): Promise<number> {
  const context = await buildContext();
  const coordinator = new Coordinator(context);

  const shutdown = () => {
    coordinator.stop();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(EXIT_SIGINT);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(EXIT_SIGTERM);
  });

  if (!process.stdout.isTTY) {
    const detach = attachInlinePrinter(context.log);
    await coordinator.start();
    console.log("watching the board (no TTY — plain streaming; ctrl-c to stop)");
    await new Promise(() => {
      // Intentionally never resolves — run until killed.
    });
    detach();
    return 0;
  }

  const app = render(
    createElement(App, {
      log: context.log,
      boardName: path.basename(context.config.board.path),
      targetBranch: context.config.integration.target_branch,
      onQuit: shutdown,
    }),
  );
  await coordinator.start();
  await app.waitUntilExit();
  await context.log.flush();
  return 0;
}
