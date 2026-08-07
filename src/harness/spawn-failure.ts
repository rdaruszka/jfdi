import type { HarnessSelection } from "./types.js";

/**
 * What a session that never started says. A provider CLI that is missing or
 * unusable is a configuration problem, not a task failure, so the message names
 * both halves of the fix: the binary to install and the selection channel to
 * change (`stages` for pipeline sessions, command flags for init). The default
 * mix is deliberately cross-provider, so a project with only one CLI installed
 * meets this at its first review stage.
 */
export function spawnFailureText(
  executable: string,
  selection: HarnessSelection,
  detail: string,
  selectionSource: "stage-config" | "init-flags" = "stage-config",
): string {
  const remedy =
    selectionSource === "init-flags"
      ? "rerun jfdi init with --harness set to a provider you have"
      : `point stages.${selection.sessionKind}.harness at a provider you have`;
  return `failed to spawn "${executable}" for the ${selection.sessionKind} session: ${detail} — install the ${executable} CLI and put it on PATH, or ${remedy}`;
}
