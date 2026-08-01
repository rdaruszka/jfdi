import * as path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { Coordinator } from "../coordinator.js";
import { App } from "../tui/App.js";
import { attachInlinePrinter, buildContext } from "./context.js";

/**
 * `jfdi start` — coordinator multi-mode: watch the board, dispatch concurrently,
 * serialize integration, and present the live TUI (or plain streaming when not
 * attached to a TTY).
 */
export async function startCommand(): Promise<number> {
  const ctx = await buildContext();
  const coordinator = new Coordinator(ctx);

  const shutdown = () => {
    coordinator.stop();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });

  if (!process.stdout.isTTY) {
    const detach = attachInlinePrinter(ctx.log);
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
      log: ctx.log,
      boardName: path.basename(ctx.config.board.path),
      targetBranch: ctx.config.integration.target_branch,
      onQuit: shutdown,
    }),
  );
  await coordinator.start();
  await app.waitUntilExit();
  await ctx.log.flush();
  return 0;
}
