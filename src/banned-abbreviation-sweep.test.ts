import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the internal-naming sweep's headline criterion: "No
 * identifier in `src/` uses an abbreviation outside CLAUDE.md's allowlist"
 * (tests included). The sweep's own decision keeps `dir`, `repo`, `spec` and
 * `cmd` off the allowlist, so identifiers built from them must be spelled out
 * (`promptDirectory`, not `promptDir`).
 *
 * Rather than parse every identifier, this pins the mechanical form the sweep
 * regressed on: a local/function *declaration* whose name ends in one of the
 * banned camelCase segments. Matching declarations (not bare occurrences)
 * keeps historical references in comments and "this name is gone" string
 * assertions (e.g. dead-exports-sweep's `"ensureTicketsDir"`) from tripping the
 * guard, while still catching a banned declaration even when it lives inside a
 * stub-CLI template string. The allowlisted spellings (`Directory`,
 * `Repository`, `Specification`, `Command`) end in a different letter, so they
 * never match.
 */
describe("banned-abbreviation sweep stays swept", () => {
  const bannedDeclaration =
    /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*(?:Dir|Repo|Spec|Cmd|Tmp|Ctx|Cfg))\b/g;

  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  it("declares no local identifier ending in a banned abbreviation", () => {
    const sourceRoot = path.join(import.meta.dirname);
    const files = walk(sourceRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        bannedDeclaration.lastIndex = 0;
        let match: RegExpExecArray | null = bannedDeclaration.exec(line);
        while (match !== null) {
          violations.push(`${path.relative(sourceRoot, file)}:${index + 1}: ${match[1]}`);
          match = bannedDeclaration.exec(line);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
