import { defineConfig } from "vitest/config";

// Scope discovery to src/ — fixtures/half-app carries its own test suite that
// runs under its own toolchain, never under this repo's.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
