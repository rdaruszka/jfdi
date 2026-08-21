import { describe, expect, it } from "vitest";
import { EXIT_SIGINT } from "../util/exit-codes.js";
import { exitCodeForInput } from "./App.js";

describe("exitCodeForInput", () => {
  it("turns one raw-mode Ctrl-C keypress into the conventional interrupt exit code", () => {
    expect(exitCodeForInput("c", { ctrl: true })).toBe(EXIT_SIGINT);
  });

  it("keeps q as a successful quit and ignores an ordinary c", () => {
    expect(exitCodeForInput("q", { ctrl: false })).toBe(0);
    expect(exitCodeForInput("c", { ctrl: false })).toBeNull();
  });
});
