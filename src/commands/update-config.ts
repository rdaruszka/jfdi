import * as path from "node:path";
import { JFDI_DIRECTORY, migrateLegacyConfigKeys, parseConfigJson } from "../config.js";
import { projectRoot } from "../git.js";
import { atomicWrite, readIfExists } from "../util/fsx.js";

const CONFIG_RELATIVE_PATH = path.join(JFDI_DIRECTORY, "config.json");

/** `jfdi update-config` — mechanically rewrite legacy config keys in place. */
export async function updateConfigCommand(cwd: string = process.cwd()): Promise<number> {
  const resolvedProjectRoot = await projectRoot(cwd);
  const configPath = path.join(resolvedProjectRoot, CONFIG_RELATIVE_PATH);
  const content = await readIfExists(configPath);
  if (content === null) {
    console.log(`${CONFIG_RELATIVE_PATH} does not exist; nothing to update`);
    return 0;
  }

  const raw = parseConfigJson(content, configPath);
  const migration = migrateLegacyConfigKeys(raw);
  if (migration.renames.length === 0 && migration.removals.length === 0) {
    console.log(`${CONFIG_RELATIVE_PATH} already uses canonical config keys; nothing to update`);
    return 0;
  }

  await atomicWrite(configPath, `${JSON.stringify(migration.raw, null, 2)}\n`);
  for (const rename of migration.renames) {
    console.log(`${rename.legacyPath} → ${rename.canonicalPath}`);
  }
  for (const removal of migration.removals) {
    console.log(
      `${removal.legacyPath} removed; configure ${removal.replacementPath} (rounds and rejections do not map)`,
    );
  }
  return 0;
}
