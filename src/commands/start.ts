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
  let exitCode = 0;
  let isCoordinatorStopped = false;
  const shutdown = (requestedExitCode: number) => {
    if (isCoordinatorStopped) return;
    isCoordinatorStopped = true;
    exitCode = requestedExitCode;
    coordinator.stop();
  };
  const quit = (requestedExitCode: number) => {
    shutdown(requestedExitCode);
    // Stopping releases a paused pipeline with its last failed result. An
    // interrupt must terminate after cleanup, before that pipeline can settle
    // the card as a task failure instead of leaving it resumable In Progress.
    if (requestedExitCode !== 0) process.exit(requestedExitCode);
  };

  try {
    const app = render(
      createElement(App, {
        log: context.log,
        boardName: path.basename(context.config.board.path),
        targetBranch: context.config.integration.targetBranch,
        onQuit: quit,
        onRetry: () => context.pause.retryNow(),
      }),
      { exitOnCtrlC: false },
    );
    let hasUnmountedApp = false;
    const unmountApp = () => {
      if (hasUnmountedApp) return;
      hasUnmountedApp = true;
      app.unmount();
    };
    const onInterrupt = () => {
      shutdown(EXIT_SIGINT);
      unmountApp();
      process.exit(EXIT_SIGINT);
    };
    const onTermination = () => {
      shutdown(EXIT_SIGTERM);
      unmountApp();
      process.exit(EXIT_SIGTERM);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTermination);

    try {
      await coordinator.start();
      await app.waitUntilExit();
      return exitCode;
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTermination);
      unmountApp();
    }
  } finally {
    shutdown(exitCode);
    await context.log.flush();
  }
}
