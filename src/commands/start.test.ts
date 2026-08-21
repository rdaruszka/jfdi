import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";
import type { PipelineContext } from "../pipeline.js";
import { EXIT_SIGINT } from "../util/exit-codes.js";
import { buildContext } from "./context.js";
import { resolveFrontEnd, startCommand } from "./start.js";

const mocks = vi.hoisted(() => ({
  coordinator: {
    start: vi.fn<() => Promise<void>>(),
    stop: vi.fn<() => void>(),
  },
  app: {
    unmount: vi.fn<() => void>(),
    waitUntilExit: vi.fn<() => Promise<void>>(),
  },
  render: vi.fn(),
}));

vi.mock("./context.js", () => ({
  buildContext: vi.fn(),
}));
vi.mock("../coordinator.js", () => {
  class Coordinator {
    start(): Promise<void> {
      return mocks.coordinator.start();
    }
    stop(): void {
      mocks.coordinator.stop();
    }
  }
  const mockModule: Record<string, unknown> = {};
  Object.defineProperty(mockModule, "Coordinator", { value: Coordinator });
  return mockModule;
});
vi.mock("../tui/App.js", () => {
  function App() {
    return null;
  }
  const mockModule: Record<string, unknown> = {};
  Object.defineProperty(mockModule, "App", { value: App });
  return mockModule;
});
vi.mock("ink", () => ({ render: mocks.render }));

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

function context(): PipelineContext {
  return {
    config: {
      board: { path: ".jfdi/board.md" },
      integration: { targetBranch: "main" },
    },
    log: { flush: vi.fn(() => Promise.resolve()) },
  } as unknown as PipelineContext;
}

describe("startCommand", () => {
  it("uses the config default and lets the CLI override it", () => {
    expect(resolveFrontEnd({}, { ...defaultConfig(), frontEnd: "web" })).toBe("web");
    expect(resolveFrontEnd({ frontEnd: "terminal" }, { ...defaultConfig(), frontEnd: "web" })).toBe(
      "terminal",
    );
  });

  it("refuses redirected output before starting the coordinator", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(buildContext).mockResolvedValue({ config: defaultConfig() } as never);

    await expect(startCommand()).resolves.toBe(1);

    expect(consoleError).toHaveBeenCalledWith(
      "jfdi start requires a terminal (TTY); it renders a live TUI",
    );
    expect(buildContext).toHaveBeenCalledOnce();
  });

  it("keeps the TTY refusal ahead of context errors for an implicit front end", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(buildContext).mockRejectedValue(new Error("not inside a git repository"));

    await expect(startCommand()).resolves.toBe(1);

    expect(consoleError).toHaveBeenCalledWith(
      "jfdi start requires a terminal (TTY); it renders a live TUI",
    );
  });

  it("does not hide context errors from an explicitly selected web front end", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    vi.mocked(buildContext).mockRejectedValue(new Error("not inside a git repository"));

    await expect(startCommand({ frontEnd: "web" })).rejects.toThrow("not inside a git repository");
  });

  it("owns Ctrl-C so the coordinator and TUI are both released before returning", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.mocked(buildContext).mockResolvedValue(context());
    mocks.coordinator.start.mockResolvedValue();
    mocks.app.waitUntilExit.mockResolvedValue();
    mocks.render.mockReturnValue(mocks.app);

    await expect(startCommand()).resolves.toBe(0);

    expect(mocks.render).toHaveBeenCalledWith(expect.anything(), { exitOnCtrlC: false });
    expect(mocks.coordinator.stop).toHaveBeenCalledOnce();
    expect(mocks.app.unmount).toHaveBeenCalledOnce();
  });

  it("routes one raw-mode Ctrl-C through coordinator shutdown and process exit", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.mocked(buildContext).mockResolvedValue(context());
    const exitProcess = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    mocks.coordinator.start.mockResolvedValue();
    mocks.app.waitUntilExit.mockResolvedValue();
    mocks.render.mockImplementation(
      (element: ReactElement<{ onQuit: (exitCode: number) => void }>) => {
        element.props.onQuit(EXIT_SIGINT);
        return mocks.app;
      },
    );

    await expect(startCommand()).resolves.toBe(EXIT_SIGINT);

    expect(mocks.coordinator.stop).toHaveBeenCalledOnce();
    expect(mocks.app.unmount).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(EXIT_SIGINT);
  });
});
