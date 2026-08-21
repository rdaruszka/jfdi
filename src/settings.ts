import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  defaultConfig,
  JFDI_DIRECTORY,
  type JfdiConfig,
  migrateLegacyConfigKeys,
  parseConfig,
  parseConfigJson,
} from "./config.js";
import { atomicWrite, readIfExists, withPathLock } from "./util/fsx.js";

export interface SettingsSnapshot {
  config: JfdiConfig;
  editableConfig: Record<string, unknown>;
  revision: string;
}

export class SettingsStaleError extends Error {
  constructor() {
    super(
      "config file changed on disk since these settings were loaded; Reload before saving again",
    );
    this.name = "SettingsStaleError";
  }
}

function configPath(projectRoot: string): string {
  return path.join(projectRoot, JFDI_DIRECTORY, "config.json");
}

function revisionOf(content: string | null): string {
  return createHash("sha256")
    .update(content ?? "\0absent")
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlay effective values while retaining unmodeled keys at every object and array entry. */
function editableValue(raw: unknown, effective: unknown): unknown {
  if (Array.isArray(effective)) {
    const rawEntries = Array.isArray(raw) ? raw : [];
    return effective.map((entry, index) => editableValue(rawEntries[index], entry));
  }
  if (isRecord(effective)) {
    const editable: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
    for (const [key, value] of Object.entries(effective)) {
      editable[key] = editableValue(editable[key], value);
    }
    return editable;
  }
  return effective;
}

function settingsValues(raw: unknown): {
  config: JfdiConfig;
  editableConfig: Record<string, unknown>;
} {
  const config = parseConfig(raw);
  const migrated = migrateLegacyConfigKeys(raw).raw;
  const editableConfig = editableValue(migrated, config);
  if (!isRecord(editableConfig)) throw new Error("effective config must be an object");
  return { config, editableConfig };
}

/** Read every effective config value and bind it to the exact file content read. */
export async function loadSettings(projectRoot: string): Promise<SettingsSnapshot> {
  const filePath = configPath(projectRoot);
  const content = await readIfExists(filePath);
  const raw = content === null ? defaultConfig() : parseConfigJson(content, filePath);
  return { ...settingsValues(raw), revision: revisionOf(content) };
}

/** Validate, reject a stale edit, then atomically replace config.json. */
export function saveSettings(
  projectRoot: string,
  staged: unknown,
  expectedRevision: string,
): Promise<SettingsSnapshot> {
  const filePath = configPath(projectRoot);
  return withPathLock(filePath, async () => {
    const values = settingsValues(staged);
    const content = `${JSON.stringify(values.editableConfig, null, 2)}\n`;
    const loaded = await readIfExists(filePath);
    if (revisionOf(loaded) !== expectedRevision) throw new SettingsStaleError();
    const reread = await readIfExists(filePath);
    if (reread !== loaded) throw new SettingsStaleError();
    await atomicWrite(filePath, content);
    return { ...values, revision: revisionOf(content) };
  });
}
