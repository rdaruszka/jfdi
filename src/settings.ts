import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  defaultConfig,
  JFDI_DIRECTORY,
  type JfdiConfig,
  parseConfig,
  parseConfigJson,
} from "./config.js";
import { atomicWrite, readIfExists, withPathLock } from "./util/fsx.js";

export interface SettingsSnapshot {
  config: JfdiConfig;
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

function parseContent(content: string | null, filePath: string): JfdiConfig {
  if (content === null) return defaultConfig();
  return parseConfig(parseConfigJson(content, filePath));
}

/** Read every effective config value and bind it to the exact file content read. */
export async function loadSettings(projectRoot: string): Promise<SettingsSnapshot> {
  const filePath = configPath(projectRoot);
  const content = await readIfExists(filePath);
  return { config: parseContent(content, filePath), revision: revisionOf(content) };
}

/** Validate, reject a stale edit, then atomically replace config.json. */
export function saveSettings(
  projectRoot: string,
  staged: unknown,
  expectedRevision: string,
): Promise<SettingsSnapshot> {
  const filePath = configPath(projectRoot);
  return withPathLock(filePath, async () => {
    const config = parseConfig(staged);
    const content = `${JSON.stringify(config, null, 2)}\n`;
    const loaded = await readIfExists(filePath);
    if (revisionOf(loaded) !== expectedRevision) throw new SettingsStaleError();
    const reread = await readIfExists(filePath);
    if (reread !== loaded) throw new SettingsStaleError();
    await atomicWrite(filePath, content);
    return { config, revision: revisionOf(content) };
  });
}
