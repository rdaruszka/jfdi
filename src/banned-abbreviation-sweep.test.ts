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
 * Rather than parse every identifier, this pins the mechanical forms the sweep
 * regressed on: local/function declarations, function parameters, authored
 * option fields, and stub environment properties whose names contain a banned
 * segment. Matching declaration sites (not bare occurrences) keeps historical
 * references in comments and "this name is gone" string assertions (e.g.
 * dead-exports-sweep's `"ensureTicketsDir"`) from tripping the guard, while
 * still catching a banned declaration even when it lives inside a stub-CLI
 * template string. Singular and plural suffixes are covered. The allowlisted
 * spellings (`Directory`, `Repository`, `Specification`, `Command`,
 * `Implementation`) end differently, so they never match.
 */
describe("banned-abbreviation sweep stays swept", () => {
  const declaration = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\b/g;
  const arrowParameters = /\(([^()]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g;
  const namedFunctionParameters = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g;
  const parameterIdentifier = /\b([A-Za-z_$][\w$]*)\b/g;
  const authoredOptionField = /^\s*([A-Za-z_$][\w$]*(?:Subdirs?|Impls?))\??\s*:/g;
  const stubEnvironmentProperty = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
  const bannedIdentifier =
    /^(?:dir|repo|spec|cmd|tmp|ctx|cfg|obj|impl|subdir|[A-Za-z_$][\w$]*(?:Dirs?|Repos?|Specs?|Cmds?|Tmps?|Ctxs?|Cfgs?|Objs?|Impls?|Subdirs?))$/;
  const bannedStubEnvironmentSegment = /(?:^|_)(?:IMPL|SUBDIR)(?:_|$)/;

  const isBannedIdentifier = (identifier: string | undefined): identifier is string =>
    identifier !== undefined && bannedIdentifier.test(identifier);

  const findBannedIdentifiers = (line: string): string[] => {
    const declaredIdentifiers = Array.from(line.matchAll(declaration), (match) => match[1]).filter(
      isBannedIdentifier,
    );
    const parameterLists = Array.from(
      line.matchAll(arrowParameters),
      (match) => match[1] ?? match[2],
    )
      .concat(Array.from(line.matchAll(namedFunctionParameters), (match) => match[1]))
      .filter((parameters): parameters is string => parameters !== undefined);
    const functionParameterIdentifiers = parameterLists.flatMap((parameters) =>
      Array.from(parameters.matchAll(parameterIdentifier), (match) => match[1]).filter(
        isBannedIdentifier,
      ),
    );
    const authoredOptionFields = Array.from(
      line.matchAll(authoredOptionField),
      (match) => match[1],
    ).filter(isBannedIdentifier);
    const stubEnvironmentProperties = Array.from(
      line.matchAll(stubEnvironmentProperty),
      (match) => match[1],
    ).filter(
      (identifier): identifier is string =>
        identifier !== undefined && bannedStubEnvironmentSegment.test(identifier),
    );
    return [
      ...declaredIdentifiers,
      ...functionParameterIdentifiers,
      ...authoredOptionFields,
      ...stubEnvironmentProperties,
    ];
  };

  const walk = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  it("declares no authored identifier containing a banned abbreviation", () => {
    const sourceRoot = path.join(import.meta.dirname);
    const files = walk(sourceRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const identifier of findBannedIdentifiers(line)) {
          violations.push(`${path.relative(sourceRoot, file)}:${index + 1}: ${identifier}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
