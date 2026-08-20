import * as path from "node:path";
import { JFDI_DIR, migrateLegacyConfigKeys, parseConfigJson } from "../config.js";
import { repoRoot } from "../git.js";
import { atomicWrite, readIfExists } from "../util/fsx.js";

const CONFIG_RELATIVE_PATH = path.join(JFDI_DIR, "config.json");

/** `jfdi update-config` — mechanically rewrite legacy config keys in place. */
export async function updateConfigCommand(cwd: string = process.cwd()): Promise<number> {
  const root = await repoRoot(cwd);
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  const content = await readIfExists(configPath);
  if (content === null) {
    console.log(`${CONFIG_RELATIVE_PATH} does not exist; nothing to update`);
    return 0;
  }

  const raw = parseConfigJson(content, configPath);
  const migration = migrateLegacyConfigKeys(raw);
  if (migration.renames.length === 0) {
    console.log(`${CONFIG_RELATIVE_PATH} already uses canonical config keys; nothing to update`);
    return 0;
  }

  await atomicWrite(configPath, `${JSON.stringify(migration.raw, null, 2)}\n`);
  for (const rename of migration.renames) {
    console.log(`${rename.legacyPath} → ${rename.canonicalPath}`);
  }
  return 0;
}
