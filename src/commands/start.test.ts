import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext } from "./context.js";
import { startCommand } from "./start.js";

vi.mock("./context.js", () => ({
  buildContext: vi.fn(),
}));

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

describe("startCommand", () => {
  it("refuses redirected output before starting the coordinator", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startCommand()).resolves.toBe(1);

    expect(consoleError).toHaveBeenCalledWith(
      "jfdi start requires a terminal (TTY); it renders a live TUI",
    );
    expect(buildContext).not.toHaveBeenCalled();
  });
});
