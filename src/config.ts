import * as path from "node:path";
import { EFFORT_LEVELS_BY_HARNESS } from "./harness/index.js";
import type { HarnessName, SessionKind } from "./harness/types.js";
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
  command: string;
}

export type IntegrationMode = "auto" | "on-approval";
export type PermissionMode = "auto" | "bypass";
export type FrontEnd = "terminal" | "web";
export type { HarnessName, SessionKind };

export const INTEGRATION_MODES = ["auto", "on-approval"] as const;
export const PERMISSION_MODES = ["auto", "bypass"] as const;
export const FRONT_ENDS = ["terminal", "web"] as const;
export const HARNESS_NAMES = ["claude", "codex"] as const;
export const SESSION_KINDS: readonly SessionKind[] = [
  "implementation",
  "code-review",
  "qa",
  "integration",
  "commit-message",
];
export const REVIEW_STAGE_NAMES = ["code-review", "qa"] as const;
export type ReviewStageName = (typeof REVIEW_STAGE_NAMES)[number];
export type RejectionBudgets = Record<ReviewStageName, number>;

export interface IntegrationRemoteConfig {
  fetchBefore: boolean;
  pushAfter: boolean;
}

/**
 * Which agent one `stages` entry runs. `model` and `effort` are provider-native
 * strings passed to the CLI verbatim; absent means the provider's own default,
 * never a value inherited from another entry — so naming only a harness can
 * never pair one provider with another's model.
 */
export interface SessionConfig {
  harness: HarnessName;
  model?: string;
  effort?: string;
}

export interface JfdiConfig {
  board: { path: string; columns: ColumnMap };
  ticketsDirectory: string;
  gate: GateCommand[];
  pipeline: { maxRejections: RejectionBudgets };
  integration: {
    targetBranch: string;
    mode: IntegrationMode;
    remote: IntegrationRemoteConfig;
  };
  permissions: { mode: PermissionMode };
  frontEnd: FrontEnd;
  maxConcurrent: number;
  /** Required, one entry per stage plus the scribe — there is no global harness. */
  stages: Record<SessionKind, SessionConfig>;
}

export const JFDI_DIRECTORY = ".jfdi";

export function defaultConfig(): JfdiConfig {
  return {
    board: {
      path: `${JFDI_DIRECTORY}/board.md`,
      columns: {
        begin: "Ready",
        inProgress: "In Progress",
        done: "Done",
        blocked: "Blocked",
        readyToMerge: "Ready to Merge",
        inbox: "Inbox",
      },
    },
    ticketsDirectory: `${JFDI_DIRECTORY}/tickets`,
    gate: [],
    pipeline: { maxRejections: { "code-review": 2, qa: 1 } },
    integration: {
      targetBranch: "main",
      mode: "on-approval",
      remote: { fetchBefore: false, pushAfter: false },
    },
    permissions: { mode: "auto" },
    frontEnd: "terminal",
    maxConcurrent: 2,
    stages: {
      implementation: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
      // Deliberately a different provider from implementation: a reviewer that
      // is not the author's own model does not share the author's blind spots.
      "code-review": { harness: "codex", model: "gpt-5.6-sol", effort: "high" },
      qa: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
      // Integration only spawns on merge conflicts, so this prices conflict
      // resolution alone — rare, but its output lands on the target branch
      // where the gate cannot catch silently dropped logic.
      integration: { harness: "claude", model: "claude-opus-4-8", effort: "medium" },
      // The scribe writes commit messages from a diff and a summary the
      // pipeline hands it — a cheap-model task, and one that runs after every
      // code-producing session, so it is priced accordingly.
      "commit-message": { harness: "claude", model: "claude-sonnet-5" },
    },
  };
}

/** Quoted into every `stages` rejection, so the message shows the fix. */
const STAGES_EXAMPLE = `"stages": {
  "implementation": { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
  "code-review":    { "harness": "codex",  "model": "gpt-5.6-sol",   "effort": "high" },
  "qa":             { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
  "integration":    { "harness": "claude", "model": "claude-opus-4-8", "effort": "medium" },
  "commit-message": { "harness": "claude", "model": "claude-sonnet-5" }
}`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LegacyConfigKeyRename {
  legacyKey: string;
  legacyPath: string;
  canonicalPath: string;
}

export interface ConfigKeyMigration {
  raw: unknown;
  renames: LegacyConfigKeyRename[];
  removals: LegacyConfigKeyRemoval[];
}

export interface LegacyConfigKeyRemoval {
  legacyKey: string;
  legacyPath: string;
  replacementPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChoice<Choices extends readonly string[]>(
  value: string,
  choices: Choices,
): value is Choices[number] {
  return choices.some((choice) => choice === value);
}

function keyPath(where: string, key: string): string {
  return where === "config" ? key : `${where}.${key}`;
}

/** Rename one accepted legacy key without changing any other property. */
function renameLegacyKey(
  entry: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string,
  where: string,
): { entry: Record<string, unknown>; renames: LegacyConfigKeyRename[] } {
  if (!Object.hasOwn(entry, legacyKey)) return { entry, renames: [] };
  const canonicalValue = entry[canonicalKey];
  const legacyValue = entry[legacyKey];
  if (Object.hasOwn(entry, canonicalKey) && !Object.is(canonicalValue, legacyValue)) {
    throw new ConfigError(
      `${where} has conflicting "${canonicalKey}" and legacy "${legacyKey}" values: ${JSON.stringify(canonicalValue)} and ${JSON.stringify(legacyValue)}`,
    );
  }
  const migrated = { ...entry };
  if (!Object.hasOwn(entry, canonicalKey)) migrated[canonicalKey] = legacyValue;
  delete migrated[legacyKey];
  return {
    entry: migrated,
    renames: [
      {
        legacyKey,
        legacyPath: keyPath(where, legacyKey),
        canonicalPath: keyPath(where, canonicalKey),
      },
    ],
  };
}

function continueKeyMigration(
  migration: { entry: Record<string, unknown>; renames: LegacyConfigKeyRename[] },
  canonicalKey: string,
  legacyKey: string,
  where: string,
): { entry: Record<string, unknown>; renames: LegacyConfigKeyRename[] } {
  const next = renameLegacyKey(migration.entry, canonicalKey, legacyKey, where);
  return { entry: next.entry, renames: [...migration.renames, ...next.renames] };
}

/**
 * Mechanically rename every accepted legacy spelling in raw parsed JSON.
 * Unknown keys and values are retained; this deliberately does not parse
 * through JfdiConfig, whose typed shape omits them.
 */
export function migrateLegacyConfigKeys(raw: unknown): ConfigKeyMigration {
  if (!isRecord(raw)) return { raw, renames: [], removals: [] };
  let configMigration = renameLegacyKey(raw, "ticketsDirectory", "ticketsDir", "config");
  const removals: LegacyConfigKeyRemoval[] = [];

  if (Array.isArray(configMigration.entry.gate)) {
    const gateMigrations = configMigration.entry.gate.map((entry, index) =>
      isRecord(entry)
        ? renameLegacyKey(entry, "command", "cmd", `gate[${index}]`)
        : { entry, renames: [] },
    );
    configMigration = {
      entry: { ...configMigration.entry, gate: gateMigrations.map(({ entry }) => entry) },
      renames: [...configMigration.renames, ...gateMigrations.flatMap(({ renames }) => renames)],
    };
  }

  if (isRecord(configMigration.entry.pipeline)) {
    const pipeline = { ...configMigration.entry.pipeline };
    for (const legacyKey of ["maxRounds", "max_rounds"]) {
      if (!Object.hasOwn(pipeline, legacyKey)) continue;
      delete pipeline[legacyKey];
      removals.push({
        legacyKey,
        legacyPath: `pipeline.${legacyKey}`,
        replacementPath: "pipeline.maxRejections",
      });
    }
    configMigration = {
      entry: { ...configMigration.entry, pipeline },
      renames: configMigration.renames,
    };
  }

  if (isRecord(configMigration.entry.integration)) {
    let integrationMigration = renameLegacyKey(
      configMigration.entry.integration,
      "targetBranch",
      "target_branch",
      "integration",
    );
    if (isRecord(integrationMigration.entry.remote)) {
      let remoteMigration = renameLegacyKey(
        integrationMigration.entry.remote,
        "fetchBefore",
        "fetch_before",
        "integration.remote",
      );
      remoteMigration = continueKeyMigration(
        remoteMigration,
        "pushAfter",
        "push_after",
        "integration.remote",
      );
      integrationMigration = {
        entry: { ...integrationMigration.entry, remote: remoteMigration.entry },
        renames: [...integrationMigration.renames, ...remoteMigration.renames],
      };
    }
    configMigration = {
      entry: { ...configMigration.entry, integration: integrationMigration.entry },
      renames: [...configMigration.renames, ...integrationMigration.renames],
    };
  }

  configMigration = continueKeyMigration(
    configMigration,
    "maxConcurrent",
    "max_concurrent",
    "config",
  );
  return { raw: configMigration.entry, renames: configMigration.renames, removals };
}

/** Parse config JSON with the path-bearing error shared by load and migration. */
export function parseConfigJson(content: string, file: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
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

function nonNegativeInteger(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new ConfigError(`${where} must be a non-negative integer`);
  return value;
}

function parseRejectionBudgets(raw: unknown, defaults: RejectionBudgets): RejectionBudgets {
  if (raw === undefined) return defaults;
  if (!isRecord(raw)) throw new ConfigError("pipeline.maxRejections must be an object");
  for (const key of Object.keys(raw)) {
    if (!REVIEW_STAGE_NAMES.some((stage) => stage === key))
      throw new ConfigError(
        `pipeline.maxRejections has an unknown reviewer "${key}"; the reviewers are ${REVIEW_STAGE_NAMES.join(", ")}`,
      );
  }
  return {
    "code-review": nonNegativeInteger(
      raw["code-review"],
      defaults["code-review"],
      "pipeline.maxRejections.code-review",
    ),
    qa: nonNegativeInteger(raw.qa, defaults.qa, "pipeline.maxRejections.qa"),
  };
}

/** The explicit round-loop cap derived from the two reviewer rejection budgets. */
export function derivedRoundCeiling(maxRejections: RejectionBudgets): number {
  return 1 + maxRejections["code-review"] + maxRejections.qa;
}

function booleanOrDefault(value: unknown, fallback: boolean, where: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be a boolean`);
  return value;
}

/** Read a canonical key or its legacy alias; loadConfig handles the user-facing notice. */
function aliasedValue(
  entry: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string,
  where: string,
): unknown {
  const canonicalValue = entry[canonicalKey];
  const legacyValue = entry[legacyKey];
  if (
    canonicalValue !== undefined &&
    legacyValue !== undefined &&
    !Object.is(canonicalValue, legacyValue)
  )
    throw new ConfigError(
      `${where} has conflicting "${canonicalKey}" and legacy "${legacyKey}" values: ${JSON.stringify(canonicalValue)} and ${JSON.stringify(legacyValue)}`,
    );
  return canonicalValue !== undefined ? canonicalValue : legacyValue;
}

/** Parse the target, integration mode, and optional remote-operation flags. */
function parseIntegrationConfig(
  raw: unknown,
  defaults: JfdiConfig["integration"],
): JfdiConfig["integration"] {
  const integration = isRecord(raw) ? raw : {};
  if (integration.remote !== undefined && !isRecord(integration.remote))
    throw new ConfigError("integration.remote must be an object");
  const remote = isRecord(integration.remote) ? integration.remote : {};
  const mode = stringOrDefault(integration.mode, defaults.mode, "integration.mode");
  if (!isChoice(mode, INTEGRATION_MODES))
    throw new ConfigError(`integration.mode must be "auto" or "on-approval", got "${mode}"`);
  return {
    targetBranch: stringOrDefault(
      aliasedValue(integration, "targetBranch", "target_branch", "integration"),
      defaults.targetBranch,
      "integration.targetBranch",
    ),
    mode,
    remote: {
      fetchBefore: booleanOrDefault(
        aliasedValue(remote, "fetchBefore", "fetch_before", "integration.remote"),
        defaults.remote.fetchBefore,
        "integration.remote.fetchBefore",
      ),
      pushAfter: booleanOrDefault(
        aliasedValue(remote, "pushAfter", "push_after", "integration.remote"),
        defaults.remote.pushAfter,
        "integration.remote.pushAfter",
      ),
    },
  };
}

/** One `stages.<key>` entry: harness required, model and effort optional. */
function parseSessionConfig(raw: unknown, sessionKind: SessionKind): SessionConfig {
  const where = `stages.${sessionKind}`;
  if (!isRecord(raw)) throw new ConfigError(`${where} must be an object, e.g. ${STAGES_EXAMPLE}`);
  const harness = requiredString(raw.harness, `${where}.harness`);
  if (!isChoice(harness, HARNESS_NAMES))
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
function parseStages(raw: unknown): Record<SessionKind, SessionConfig> {
  if (raw === undefined)
    throw new ConfigError(
      `config is missing the required "stages" section; add it, e.g.\n${STAGES_EXAMPLE}`,
    );
  if (!isRecord(raw)) throw new ConfigError(`stages must be an object, e.g. ${STAGES_EXAMPLE}`);
  for (const key of Object.keys(raw)) {
    if (!SESSION_KINDS.some((sessionKind) => sessionKind === key))
      throw new ConfigError(
        `stages has an unknown entry "${key}"; the entries are ${SESSION_KINDS.join(", ")}`,
      );
  }
  const missing = SESSION_KINDS.filter((stage) => raw[stage] === undefined);
  if (missing.length > 0)
    throw new ConfigError(
      `stages is missing an entry for ${missing.join(", ")}; every stage needs one, and "commit-message" selects the scribe that writes commit messages, e.g.\n${STAGES_EXAMPLE}`,
    );
  return {
    implementation: parseSessionConfig(raw.implementation, "implementation"),
    "code-review": parseSessionConfig(raw["code-review"], "code-review"),
    qa: parseSessionConfig(raw.qa, "qa"),
    integration: parseSessionConfig(raw.integration, "integration"),
    "commit-message": parseSessionConfig(raw["commit-message"], "commit-message"),
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
        command: requiredString(
          aliasedValue(rawGateCommand, "command", "cmd", `gate[${i}]`),
          `gate[${i}].command`,
        ),
      };
    });
  }

  const pipeline = isRecord(raw.pipeline) ? raw.pipeline : {};
  if (Object.hasOwn(pipeline, "maxRounds") || Object.hasOwn(pipeline, "max_rounds"))
    throw new ConfigError(
      "pipeline.maxRounds is no longer supported; run `jfdi update-config` to remove it, then configure pipeline.maxRejections",
    );
  const permissions = isRecord(raw.permissions) ? raw.permissions : {};
  const permissionMode = stringOrDefault(
    permissions.mode,
    defaults.permissions.mode,
    "permissions.mode",
  );
  if (!isChoice(permissionMode, PERMISSION_MODES))
    throw new ConfigError(`permissions.mode must be "auto" or "bypass", got "${permissionMode}"`);
  const frontEnd = stringOrDefault(raw.frontEnd, defaults.frontEnd, "frontEnd");
  if (!isChoice(frontEnd, FRONT_ENDS))
    throw new ConfigError(`frontEnd must be "terminal" or "web", got "${frontEnd}"`);

  return {
    board: { path: stringOrDefault(board.path, defaults.board.path, "board.path"), columns },
    ticketsDirectory: stringOrDefault(
      aliasedValue(raw, "ticketsDirectory", "ticketsDir", "config"),
      defaults.ticketsDirectory,
      "ticketsDirectory",
    ),
    gate,
    pipeline: {
      maxRejections: parseRejectionBudgets(pipeline.maxRejections, defaults.pipeline.maxRejections),
    },
    integration: parseIntegrationConfig(raw.integration, defaults.integration),
    permissions: { mode: permissionMode },
    frontEnd,
    maxConcurrent: positiveInteger(
      aliasedValue(raw, "maxConcurrent", "max_concurrent", "config"),
      defaults.maxConcurrent,
      "maxConcurrent",
    ),
    stages: parseStages(raw.stages),
  };
}

export type LegacyConfigNotice = (legacyKeys: readonly string[], file: string) => void;

export interface LoadConfigOptions {
  onLegacyKeys?: LegacyConfigNotice;
}

export function printLegacyConfigNotice(legacyKeys: readonly string[], file: string): void {
  console.warn(
    `Legacy config ${legacyKeys.length === 1 ? "key" : "keys"} ${legacyKeys.join(", ")} found in ${file}; run \`jfdi update-config\` to use the canonical schema.`,
  );
}

/** Load config from <projectRoot>/.jfdi/config.json; defaults if the file is absent. */
export async function loadConfig(
  projectRoot: string,
  options: LoadConfigOptions = {},
): Promise<JfdiConfig> {
  const file = path.join(projectRoot, JFDI_DIRECTORY, "config.json");
  const content = await readIfExists(file);
  if (content === null) return defaultConfig();
  const raw = parseConfigJson(content, file);
  const config = parseConfig(raw);
  const { renames } = migrateLegacyConfigKeys(raw);
  if (renames.length > 0) {
    const legacyKeys = [...new Set(renames.map((rename) => rename.legacyKey))];
    (options.onLegacyKeys ?? printLegacyConfigNotice)(legacyKeys, file);
  }
  return config;
}
