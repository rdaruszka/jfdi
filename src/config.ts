import * as path from "node:path";
import type { StageName } from "./events.js";
import { EFFORT_LEVELS_BY_HARNESS } from "./harness/index.js";
import type { HarnessName } from "./harness/types.js";
import { readIfExists } from "./util/fsx.js";

export interface ColumnMap {
  begin: string;
  inProgress: string;
  done: string;
  blocked: string;
  readyToMerge: string;
  /** Agent proposals land here; humans promote or delete. Never dispatched from. */
  inbox: string;
}

export interface GateCommand {
  name: string;
  cmd: string;
}

export type IntegrationMode = "auto" | "on-approval";
export type { HarnessName };

/**
 * Which agent one stage runs. `model` and `effort` are provider-native strings
 * passed to the CLI verbatim; absent means the provider's own default, never a
 * value inherited from another stage — so naming only a harness can never pair
 * one provider with another's model.
 */
export interface StageConfig {
  harness: HarnessName;
  model?: string;
  effort?: string;
}

export interface JfdiConfig {
  board: { path: string; columns: ColumnMap };
  ticketsDir: string;
  gate: GateCommand[];
  pipeline: { max_rounds: number };
  integration: { target_branch: string; mode: IntegrationMode };
  max_concurrent: number;
  /** Required, one entry per stage — there is no global harness. */
  stages: Record<StageName, StageConfig>;
}

export const JFDI_DIR = ".jfdi";

export function defaultConfig(): JfdiConfig {
  return {
    board: {
      path: `${JFDI_DIR}/board.md`,
      columns: {
        begin: "Ready",
        inProgress: "In Progress",
        done: "Done",
        blocked: "Blocked",
        readyToMerge: "Ready to Merge",
        inbox: "Inbox",
      },
    },
    ticketsDir: `${JFDI_DIR}/tickets`,
    gate: [],
    pipeline: { max_rounds: 3 },
    integration: { target_branch: "main", mode: "on-approval" },
    max_concurrent: 2,
    stages: {
      implementation: { harness: "claude", model: "claude-opus-5", effort: "high" },
      // Deliberately a different provider from implementation: a reviewer that
      // is not the author's own model does not share the author's blind spots.
      "code-review": { harness: "codex", model: "gpt-5.6-sol", effort: "high" },
      qa: { harness: "claude", model: "claude-opus-5", effort: "high" },
      // Integration only spawns on merge conflicts, so this prices conflict
      // resolution alone — rare, but its output lands on the target branch
      // where the gate cannot catch silently dropped logic.
      integration: { harness: "claude", model: "claude-opus-5", effort: "medium" },
    },
  };
}

/** Every `StageName`, as a runtime list — the compiler enforces the pairing. */
const STAGE_NAMES: Record<StageName, true> = {
  implementation: true,
  "code-review": true,
  qa: true,
  integration: true,
};

/** Quoted into every `stages` rejection, so the message shows the fix. */
const STAGES_EXAMPLE = `"stages": {
  "implementation": { "harness": "claude", "model": "claude-opus-5", "effort": "high" },
  "code-review":    { "harness": "codex",  "model": "gpt-5.6-sol",   "effort": "high" },
  "qa":             { "harness": "claude", "model": "claude-opus-5", "effort": "high" },
  "integration":    { "harness": "claude", "model": "claude-opus-5", "effort": "medium" }
}`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrDefault(value: unknown, fallback: string, where: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0)
    throw new ConfigError(`${where} must be a non-empty string`);
  return value;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ConfigError(`${where} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new ConfigError(`${where} must be a positive integer`);
  return value;
}

/** One `stages.<stage>` entry: harness required, model and effort optional. */
function parseStageConfig(raw: unknown, stage: StageName): StageConfig {
  const where = `stages.${stage}`;
  if (!isRecord(raw)) throw new ConfigError(`${where} must be an object, e.g. ${STAGES_EXAMPLE}`);
  const harness = requiredString(raw.harness, `${where}.harness`);
  if (harness !== "claude" && harness !== "codex")
    throw new ConfigError(`${where}.harness must be "claude" or "codex", got "${harness}"`);
  const effort =
    raw.effort === undefined ? undefined : requiredString(raw.effort, `${where}.effort`);
  const accepted = EFFORT_LEVELS_BY_HARNESS[harness];
  if (effort !== undefined && !accepted.includes(effort))
    throw new ConfigError(
      `${where}.effort is "${effort}", which the ${harness} harness does not accept; use one of: ${accepted.join(", ")}`,
    );
  return {
    harness,
    // Omit rather than store undefined: an absent value must pass no CLI flag.
    ...(raw.model === undefined ? {} : { model: requiredString(raw.model, `${where}.model`) }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * The required `stages` section. Breaking format change with no migration
 * support: every rejection shows the block to paste in, because the only fix
 * is editing config.json by hand.
 */
function parseStages(raw: unknown): Record<StageName, StageConfig> {
  if (raw === undefined)
    throw new ConfigError(
      `config is missing the required "stages" section; add it, e.g.\n${STAGES_EXAMPLE}`,
    );
  if (!isRecord(raw)) throw new ConfigError(`stages must be an object, e.g. ${STAGES_EXAMPLE}`);
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(STAGE_NAMES, key))
      throw new ConfigError(
        `stages has an unknown entry "${key}"; the stages are ${Object.keys(STAGE_NAMES).join(", ")}`,
      );
  }
  const missing = Object.keys(STAGE_NAMES).filter((stage) => raw[stage] === undefined);
  if (missing.length > 0)
    throw new ConfigError(
      `stages is missing an entry for ${missing.join(", ")}; every stage needs one, e.g.\n${STAGES_EXAMPLE}`,
    );
  return {
    implementation: parseStageConfig(raw.implementation, "implementation"),
    "code-review": parseStageConfig(raw["code-review"], "code-review"),
    qa: parseStageConfig(raw.qa, "qa"),
    integration: parseStageConfig(raw.integration, "integration"),
  };
}

/** Parse and validate raw config JSON, filling defaults for absent fields. */
export function parseConfig(raw: unknown): JfdiConfig {
  if (!isRecord(raw)) throw new ConfigError("config root must be an object");
  if (raw.harnessArgs !== undefined)
    throw new ConfigError(
      "harnessArgs is no longer supported; harness permissions are managed by JFDI",
    );
  if (raw.harness !== undefined)
    throw new ConfigError(
      `the top-level "harness" key is no longer supported — harness, model and effort are chosen per stage. Replace it with:\n${STAGES_EXAMPLE}`,
    );
  const defaults = defaultConfig();

  const board = isRecord(raw.board) ? raw.board : {};
  const rawColumns = isRecord(board.columns) ? board.columns : {};
  const columns: ColumnMap = {
    begin: stringOrDefault(rawColumns.begin, defaults.board.columns.begin, "board.columns.begin"),
    inProgress: stringOrDefault(
      rawColumns.inProgress,
      defaults.board.columns.inProgress,
      "board.columns.inProgress",
    ),
    done: stringOrDefault(rawColumns.done, defaults.board.columns.done, "board.columns.done"),
    blocked: stringOrDefault(
      rawColumns.blocked,
      defaults.board.columns.blocked,
      "board.columns.blocked",
    ),
    readyToMerge: stringOrDefault(
      rawColumns.readyToMerge,
      defaults.board.columns.readyToMerge,
      "board.columns.readyToMerge",
    ),
    inbox: stringOrDefault(rawColumns.inbox, defaults.board.columns.inbox, "board.columns.inbox"),
  };

  let gate: GateCommand[] = defaults.gate;
  if (raw.gate !== undefined) {
    if (!Array.isArray(raw.gate)) throw new ConfigError("gate must be an array");
    gate = raw.gate.map((rawGateCommand, i) => {
      if (!isRecord(rawGateCommand)) throw new ConfigError(`gate[${i}] must be an object`);
      return {
        name: requiredString(rawGateCommand.name, `gate[${i}].name`),
        cmd: requiredString(rawGateCommand.cmd, `gate[${i}].cmd`),
      };
    });
  }

  const pipeline = isRecord(raw.pipeline) ? raw.pipeline : {};
  const integration = isRecord(raw.integration) ? raw.integration : {};
  const mode = stringOrDefault(integration.mode, defaults.integration.mode, "integration.mode");
  if (mode !== "auto" && mode !== "on-approval")
    throw new ConfigError(`integration.mode must be "auto" or "on-approval", got "${mode}"`);

  return {
    board: { path: stringOrDefault(board.path, defaults.board.path, "board.path"), columns },
    ticketsDir: stringOrDefault(raw.ticketsDir, defaults.ticketsDir, "ticketsDir"),
    gate,
    pipeline: {
      max_rounds: positiveInteger(
        pipeline.max_rounds,
        defaults.pipeline.max_rounds,
        "pipeline.max_rounds",
      ),
    },
    integration: {
      target_branch: stringOrDefault(
        integration.target_branch,
        defaults.integration.target_branch,
        "integration.target_branch",
      ),
      mode,
    },
    max_concurrent: positiveInteger(raw.max_concurrent, defaults.max_concurrent, "max_concurrent"),
    stages: parseStages(raw.stages),
  };
}

/** Load config from <repoRoot>/.jfdi/config.json; defaults if the file is absent. */
export async function loadConfig(repoRoot: string): Promise<JfdiConfig> {
  const file = path.join(repoRoot, JFDI_DIR, "config.json");
  const content = await readIfExists(file);
  if (content === null) return defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}
