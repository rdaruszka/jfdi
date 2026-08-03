/** Shared test fixtures (excluded from the build). */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig, type JfdiConfig } from "./config.js";
import { EventLog } from "./events.js";
import { git } from "./git.js";
import type { FakeHandler } from "./harness/fake.js";
import { FakeHarness } from "./harness/fake.js";
import { PauseController, type PauseDelays } from "./pause.js";
import type { PipelineContext } from "./pipeline.js";

/**
 * Pause waits, shrunk to the millisecond scale. The real schedule is measured
 * in minutes; a test asserting that a held stage re-runs should not wait one.
 */
export const TEST_PAUSE_DELAYS: PauseDelays = {
  outageStageRetryMs: [5, 10, 20],
  probeMs: [10, 20, 40],
  usageLimitBufferMs: 0,
  maxWaitMs: 60_000,
};

export interface Fixture {
  root: string;
  repo: string;
  jfdiDir: string;
  /** Stand-in for ~/.jfdi/projects/<key>/ — outside the repo, like the real one. */
  stateDir: string;
  ticketsDir: string;
  config: JfdiConfig;
  context: (
    handler: FakeHandler,
    options?: ContextOptions,
  ) => PipelineContext & { harness: FakeHarness };
  cleanup: () => Promise<void>;
}

export interface ContextOptions {
  /** Write events.jsonl/state.json, as a real run does — for cross-process tests. */
  shouldPersistEvents?: boolean;
}

/** Scratch repo under the OS temp dir — never inside a parent git repo. */
export async function makeFixture(configOverrides: Partial<JfdiConfig> = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-pipe-"));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@jfdi.local");
  await git(repo, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(repo, "README.md"), "product\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial");

  const jfdiDir = path.join(repo, ".jfdi");
  const ticketsDir = path.join(jfdiDir, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  const stateDir = path.join(root, "state");
  const config: JfdiConfig = { ...defaultConfig(), gate: [], ...configOverrides };

  return {
    root,
    repo,
    jfdiDir,
    stateDir,
    ticketsDir,
    config,
    context: (handler, options = {}) => {
      const harness = new FakeHarness(handler);
      const log = new EventLog(stateDir, options.shouldPersistEvents ?? false);
      return {
        repoRoot: repo,
        jfdiDir,
        stateDir,
        config,
        // One fake behind every stage, so `harness.calls` sees the whole run.
        // Tests about per-stage routing install distinct fakes themselves.
        harnesses: {
          implementation: harness,
          "code-review": harness,
          qa: harness,
          integration: harness,
        },
        harness,
        log,
        pause: new PauseController(log, TEST_PAUSE_DELAYS),
      };
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** Which pipeline stage a prompt belongs to (matched on each default's task statement). */
export function stageOf(prompt: string): "implementation" | "code-review" | "qa" | "integration" {
  if (prompt.includes("Implement the ticket below completely")) return "implementation";
  if (prompt.includes("Your implementation session is being continued")) return "implementation";
  if (prompt.includes("pure code standpoint")) return "code-review";
  if (prompt.includes("Your code-review session is being continued")) return "code-review";
  if (prompt.includes("Derive your checks from the ticket")) return "qa";
  if (prompt.includes("Your QA session is being continued")) return "qa";
  if (prompt.includes("has hit conflicts")) return "integration";
  throw new Error(`cannot determine stage from prompt: ${prompt.slice(0, 100)}`);
}

/** Pull the verdict file path out of a rendered prompt. */
export function verdictPathOf(prompt: string): string {
  const match = /(\/\S+\.verdict\.json)/.exec(prompt);
  if (!match?.[1]) throw new Error("no verdict path in prompt");
  return match[1];
}

export async function writeVerdict(prompt: string, verdict: object): Promise<void> {
  await fs.writeFile(verdictPathOf(prompt), JSON.stringify(verdict));
}

export async function commitFile(
  cwd: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), content);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}
