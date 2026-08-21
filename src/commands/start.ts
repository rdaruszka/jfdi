import * as path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import type { FrontEnd, JfdiConfig } from "../config.js";
import { Coordinator } from "../coordinator.js";
import type { PipelineContext } from "../pipeline.js";
import { App } from "../tui/App.js";
import { EXIT_SIGINT, EXIT_SIGTERM } from "../util/exit-codes.js";
import { startWebFrontEnd } from "../web/server.js";
import { buildContext } from "./context.js";

export interface StartOptions {
  frontEnd?: FrontEnd;
}

export function resolveFrontEnd(options: StartOptions, config: JfdiConfig): FrontEnd {
  return options.frontEnd ?? config.frontEnd;
}

function refuseTerminalFrontEnd(): number {
  console.error("jfdi start requires a terminal (TTY); it renders a live TUI");
  return 1;
}

/**
 * `jfdi start` — coordinator multi-mode: watch the board, dispatch concurrently,
 * serialize integration, and present the selected live front end.
 */
export async function startCommand(options: StartOptions = {}): Promise<number> {
  if (!process.stdout.isTTY && options.frontEnd === "terminal") return refuseTerminalFrontEnd();
  let context: PipelineContext;
  try {
    context = await buildContext();
  } catch (error) {
    // With no explicit selection, redirected output historically refused the
    // terminal front end before context errors could shadow that diagnostic.
    // A valid web config loads successfully; an explicit web selection keeps
    // the context error because the terminal constraint does not apply to it.
    if (!process.stdout.isTTY && options.frontEnd === undefined) return refuseTerminalFrontEnd();
    throw error;
  }
  const frontEnd = resolveFrontEnd(options, context.config);
  if (frontEnd === "web") return startWithWebFrontEnd(context);
  if (!process.stdout.isTTY) return refuseTerminalFrontEnd();
  return startWithTerminalFrontEnd(context);
}

async function startWithTerminalFrontEnd(context: PipelineContext): Promise<number> {
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
      targetBranch: context.config.integration.targetBranch,
      onQuit: shutdown,
      onRetry: () => context.pause.retryNow(),
    }),
  );
  await coordinator.start();
  await app.waitUntilExit();
  await context.log.flush();
  return 0;
}

async function startWithWebFrontEnd(context: PipelineContext): Promise<number> {
  const coordinator = new Coordinator(context);
  const frontEnd = await startWebFrontEnd({
    log: context.log,
    boardName: path.basename(context.config.board.path),
    targetBranch: context.config.integration.targetBranch,
  });
  let signalExitCode = 0;
  const handleSignal = (exitCode: number) => {
    signalExitCode = exitCode;
    coordinator.stop();
    void frontEnd.close().catch((error: unknown) => {
      console.error(`jfdi: could not stop the web front end: ${(error as Error).message}`);
    });
  };
  const handleInterrupt = () => handleSignal(EXIT_SIGINT);
  const handleTermination = () => handleSignal(EXIT_SIGTERM);
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);
  console.log(`JFDI web front end: ${frontEnd.url}`);
  try {
    await coordinator.start();
    await frontEnd.waitUntilExit();
    return signalExitCode;
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTermination);
    coordinator.stop();
    await frontEnd.close();
    await context.log.flush();
  }
}
