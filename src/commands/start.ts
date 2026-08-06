import * as path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { Coordinator } from "../coordinator.js";
import { App } from "../tui/App.js";
import { EXIT_SIGINT, EXIT_SIGTERM } from "../util/exit-codes.js";
import { buildContext } from "./context.js";

/**
 * `jfdi start` — coordinator multi-mode: watch the board, dispatch concurrently,
 * serialize integration, and present the live TUI.
 */
export async function startCommand(): Promise<number> {
  if (!process.stdout.isTTY) {
    console.error("jfdi start requires a terminal (TTY); it renders a live TUI");
    return 1;
  }

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

  const app = render(
    createElement(App, {
      log: context.log,
      boardName: path.basename(context.config.board.path),
      targetBranch: context.config.integration.target_branch,
      onQuit: shutdown,
      onRetry: () => context.pause.retryNow(),
    }),
  );
  await coordinator.start();
  await app.waitUntilExit();
  await context.log.flush();
  return 0;
}
