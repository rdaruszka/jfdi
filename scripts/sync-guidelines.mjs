// Regenerate the product-content modules from their authoritative docs. Run via
// `pnpm sync:guidelines` after editing either doc; their unit tests fail the gate
// whenever a generated module drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function compileDocument({ documentName, moduleName, testName, exportName, description }) {
  const markdown = readFileSync(join(repoRoot, "docs", documentName), "utf8");
  const escaped = markdown.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  const source = `// GENERATED from docs/${documentName} — do not edit by hand.
// Edit the doc, then run: pnpm sync:guidelines
// (src/${testName} fails the gate if the two drift.)

/**
${description}
 */
export const ${exportName} = \`${escaped}\`;
`;

  writeFileSync(join(repoRoot, "src", moduleName), source);
  console.log(`src/${moduleName} regenerated from docs/${documentName}`);
}

compileDocument({
  documentName: "coding-guidelines.md",
  moduleName: "guidelines.ts",
  testName: "guidelines.test.ts",
  exportName: "CODING_GUIDELINES",
  description: ` * The generic, language-agnostic coding guidelines JFDI ships with, compiled in
 * so the installed CLI carries them. Injected into the init prompt so the init
 * agent can instantiate them for a target repo (into its CLAUDE.md and lint
 * config). JFDI's own TypeScript instantiation lives in this repo's CLAUDE.md —
 * keep it in step when a rule changes.`,
});

compileDocument({
  documentName: "jfdi-operations.md",
  moduleName: "jfdi-operations.ts",
  testName: "jfdi-operations.test.ts",
  exportName: "JFDI_OPERATIONS",
  description: ` * The operational contract JFDI ships with, compiled in so the installed CLI
 * carries it. Injected into the init prompt so the init agent can configure a
 * target project with an accurate understanding of the pipeline.`,
});
