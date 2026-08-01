// Regenerate src/guidelines.ts from docs/coding-guidelines.md (the authoritative
// source). Run via `pnpm sync:guidelines` after editing the doc; the unit test
// in src/guidelines.test.ts fails the gate whenever the two drift.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const markdown = readFileSync(join(repoRoot, "docs", "coding-guidelines.md"), "utf8");
const escaped = markdown.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

const source = `// GENERATED from docs/coding-guidelines.md — do not edit by hand.
// Edit the doc, then run: pnpm sync:guidelines
// (src/guidelines.test.ts fails the gate if the two drift.)

/**
 * The generic, language-agnostic coding guidelines JFDI ships with, compiled in
 * so the installed CLI carries them. Injected into the init prompt so the init
 * agent can instantiate them for a target repo (into its CLAUDE.md and lint
 * config). JFDI's own TypeScript instantiation lives in this repo's CLAUDE.md —
 * keep it in step when a rule changes.
 */
export const CODING_GUIDELINES = \`${escaped}\`;
`;

writeFileSync(join(repoRoot, "src", "guidelines.ts"), source);
console.log("src/guidelines.ts regenerated from docs/coding-guidelines.md");
