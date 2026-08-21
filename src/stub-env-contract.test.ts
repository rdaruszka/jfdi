import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the stub-agent env-var contract against half-completed renames. The
 * test harnesses hand their stub CLIs behavior knobs through `STUB_*`
 * environment variables: the harness sets `env.STUB_FOO`/`STUB_FOO:` and the
 * stub template string reads `process.env.STUB_FOO`. A rename that touches only
 * one side silently severs the wire — `process.env.STUB_FOO` becomes
 * `undefined` at runtime rather than throwing, so a green suite does NOT rule
 * out the break (the naming sweep's "a partial rename throws a ReferenceError"
 * reasoning has this hole). The internal-naming sweep hit exactly this: it
 * renamed the write side to `STUB_HANG_IMPLEMENTATION_FROM_INDEX` while the
 * stub kept reading `STUB_HANG_IMPL_FROM_INDEX`, so the freeze knob went dead
 * and its test now races a SIGKILL against an un-frozen pipeline instead of
 * killing at a controlled point.
 *
 * Every `STUB_*` name a stub reads must be provided somewhere in `src/` (as an
 * env assignment or object-literal key). Scoping to the `STUB_` prefix keeps
 * OS/harness-provided variables (PATH, HOME, CI, …) out of scope — those are
 * legitimately read without a matching write in the tree.
 */
describe("stub env-var contract stays connected", () => {
  const read = /process\.env\.(STUB_[A-Z0-9_]+)/g;
  const provided = /\b(STUB_[A-Z0-9_]+)\s*[:=]/g;

  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  it("provides every STUB_* env var a stub reads", () => {
    const sourceRoot = import.meta.dirname;
    const files = walk(sourceRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

    const reads = new Map<string, string>();
    const providedNames = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const [, name] of text.matchAll(read)) {
        if (name !== undefined && !reads.has(name))
          reads.set(name, path.relative(sourceRoot, file));
      }
      for (const [, name] of text.matchAll(provided)) {
        if (name !== undefined) providedNames.add(name);
      }
    }

    const severed = Array.from(reads)
      .filter(([name]) => !providedNames.has(name))
      .map(([name, file]) => `${name} (read in ${file}) is never set — broken stub env contract`);
    expect(severed).toEqual([]);
  });
});
