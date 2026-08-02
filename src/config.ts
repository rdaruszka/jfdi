import * as path from "node:path";
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

export interface JfdiConfig {
  board: { path: string; columns: ColumnMap };
  ticketsDir: string;
  gate: GateCommand[];
  pipeline: { max_rounds: number };
  integration: { target_branch: string; mode: IntegrationMode };
  max_concurrent: number;
  harness: string;
  /** Extra CLI args passed to the harness subprocess (e.g. permission mode). */
  harnessArgs: string[];
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
    harness: "claude",
    harnessArgs: ["--permission-mode", "bypassPermissions"],
  };
}

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

/** Parse and validate raw config JSON, filling defaults for absent fields. */
export function parseConfig(raw: unknown): JfdiConfig {
  if (!isRecord(raw)) throw new ConfigError("config root must be an object");
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

  let harnessArgs = defaults.harnessArgs;
  if (raw.harnessArgs !== undefined) {
    if (!Array.isArray(raw.harnessArgs) || raw.harnessArgs.some((a) => typeof a !== "string"))
      throw new ConfigError("harnessArgs must be an array of strings");
    harnessArgs = raw.harnessArgs as string[];
  }

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
    harness: stringOrDefault(raw.harness, defaults.harness, "harness"),
    harnessArgs,
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
