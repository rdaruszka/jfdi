import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";
import { buildContext } from "./context.js";
import { resolveFrontEnd, startCommand } from "./start.js";

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
});
