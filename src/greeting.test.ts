import { describe, expect, it } from "vitest";
import { greeting } from "./greeting.js";

describe("greeting", () => {
  it("returns the hello-world string", () => {
    expect(greeting()).toBe("jfdi: hello, world");
  });
});
