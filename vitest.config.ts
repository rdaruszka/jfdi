import * as os from "node:os";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

// Scope discovery to src/ — fixtures/half-app carries its own test suite that
// runs under its own toolchain, never under this repo's.
// JFDI_HOME redirects run state (~/.jfdi/projects/<key>/) into the temp dir, so
// even a test that forgets to inject a state directory cannot touch the real one.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    env: { JFDI_HOME: path.join(os.tmpdir(), "jfdi-test-home") },
  },
});
