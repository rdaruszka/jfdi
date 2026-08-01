import * as path from "node:path";
import { readIfExists } from "./util/fsx.js";

export interface ColumnMap {
  begin: string;
  inProgress: string;
  done: string;
  blocked: string;
  readyToMerge: string;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string, where: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.length === 0)
    throw new ConfigError(`${where} must be a non-empty string`);
  return v;
}

function requiredStr(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0)
    throw new ConfigError(`${where} must be a non-empty string`);
  return v;
}

function num(v: unknown, fallback: number, where: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new ConfigError(`${where} must be a positive integer`);
  return v;
}

/** Parse and validate raw config JSON, filling defaults for absent fields. */
export function parseConfig(raw: unknown): JfdiConfig {
  if (!isRecord(raw)) throw new ConfigError("config root must be an object");
  const d = defaultConfig();

  const board = isRecord(raw.board) ? raw.board : {};
  const cols = isRecord(board.columns) ? board.columns : {};
  const columns: ColumnMap = {
    begin: str(cols.begin, d.board.columns.begin, "board.columns.begin"),
    inProgress: str(cols.inProgress, d.board.columns.inProgress, "board.columns.inProgress"),
    done: str(cols.done, d.board.columns.done, "board.columns.done"),
    blocked: str(cols.blocked, d.board.columns.blocked, "board.columns.blocked"),
    readyToMerge: str(
      cols.readyToMerge,
      d.board.columns.readyToMerge,
      "board.columns.readyToMerge",
    ),
  };

  let gate: GateCommand[] = d.gate;
  if (raw.gate !== undefined) {
    if (!Array.isArray(raw.gate)) throw new ConfigError("gate must be an array");
    gate = raw.gate.map((g, i) => {
      if (!isRecord(g)) throw new ConfigError(`gate[${i}] must be an object`);
      return {
        name: requiredStr(g.name, `gate[${i}].name`),
        cmd: requiredStr(g.cmd, `gate[${i}].cmd`),
      };
    });
  }

  const pipeline = isRecord(raw.pipeline) ? raw.pipeline : {};
  const integration = isRecord(raw.integration) ? raw.integration : {};
  const mode = str(integration.mode, d.integration.mode, "integration.mode");
  if (mode !== "auto" && mode !== "on-approval")
    throw new ConfigError(`integration.mode must be "auto" or "on-approval", got "${mode}"`);

  let harnessArgs = d.harnessArgs;
  if (raw.harnessArgs !== undefined) {
    if (!Array.isArray(raw.harnessArgs) || raw.harnessArgs.some((a) => typeof a !== "string"))
      throw new ConfigError("harnessArgs must be an array of strings");
    harnessArgs = raw.harnessArgs as string[];
  }

  return {
    board: { path: str(board.path, d.board.path, "board.path"), columns },
    ticketsDir: str(raw.ticketsDir, d.ticketsDir, "ticketsDir"),
    gate,
    pipeline: {
      max_rounds: num(pipeline.max_rounds, d.pipeline.max_rounds, "pipeline.max_rounds"),
    },
    integration: {
      target_branch: str(
        integration.target_branch,
        d.integration.target_branch,
        "integration.target_branch",
      ),
      mode,
    },
    max_concurrent: num(raw.max_concurrent, d.max_concurrent, "max_concurrent"),
    harness: str(raw.harness, d.harness, "harness"),
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
  } catch (err) {
    throw new ConfigError(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
