/**
 * End-to-end acceptance for the shape integration leaves on the target branch.
 *
 * Derived from the ticket, not the diff: a landed ticket must be one merge
 * commit whose first parent is the target's prior head and whose second parent
 * is the commit the reviews signed off on, so `git log --first-parent` reads
 * one entry per ticket and no sign-off ever leaves reachable history. The
 * target branch is configurable (hard invariant 8), so nothing here uses
 * `main` as the target — `main` is present only to prove it does not move.
 *
 * Everything drives the built CLI (`dist/index.js`) in a scratch repo under the
 * OS temp dir, with stub `claude` and `codex` binaries on PATH.
 * `JFDI_HOME`/`HOME` always point inside the scratch tree — nothing here can
 * reach the real `~/.jfdi`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(repoRoot, "dist", "index.js");

const BUILD_TIMEOUT_MS = 180_000;
const SCENARIO_TIMEOUT_MS = 180_000;

/** The target branch every scenario integrates onto — deliberately not `main`. */
const TARGET_BRANCH = "trunk";

/**
 * The agent both stubbed CLIs play; it never talks to the network. It replays
 * the stream-json lines each parser needs, writes the verdict file its prompt
 * names, and — for the implementation stage — commits the file named in
 * `STUB_FILE` so each ticket touches a different path.
 */
const STUB_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
// Claude passes the prompt after -p; Codex passes it last. One stub
// answers to both names, so a sandbox needs no second script.
const dashP = argv.indexOf("-p");
const prompt = (dashP === -1 ? argv[argv.length - 1] : argv[dashP + 1]) || "";
// Codex reads a thread id (its absence is an outage) and infers success
// from a final agent message; Claude's parser ignores both lines.
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n"));
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  const run = (args) => execFileSync("git", args, { cwd: process.cwd() });
  let verdict;
  if (stage === "implementation") {
    const file = process.env.STUB_FILE;
    fs.writeFileSync(process.cwd() + "/" + file, "built\\n");
    run(["add", "-A"]);
    run(["commit", "-m", "implement " + file]);
    verdict = { status: "done", summary: "implemented " + file };
  } else if (stage === "integration") {
    verdict = { resolution: "clean", notes: "nothing to reconcile" };
  } else {
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
`;

interface Sandbox {
  root: string;
  project: string;
  home: string;
  jfdiHome: string;
  binDir: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-merge-shape-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(binDir);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(binDir, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "test@jfdi.local");
  await git(project, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(project, "README.md"), "product\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", "initial");
  // The ticket branches are cut from the target, so it has to be the checkout.
  await git(project, "checkout", "-b", TARGET_BRANCH);

  return { root, project, home, jfdiHome: path.join(home, ".jfdi"), binDir };
}

function sandboxEnv(sandbox: Sandbox, file: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_FILE: file,
    NO_COLOR: "1",
  };
}

interface CliResult {
  code: number;
  output: string;
}

async function runCli(sandbox: Sandbox, args: string[], file: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.project,
      env: sandboxEnv(sandbox, file),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** Scaffold `.jfdi/`, then point integration at the non-main target. */
async function scaffold(sandbox: Sandbox): Promise<void> {
  const result = await runCli(sandbox, ["init", "--bare"], "unused.txt");
  expect(result.code, result.output).toBe(0);
  const configPath = path.join(sandbox.project, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  config.integration = { target_branch: TARGET_BRANCH, mode: "on-approval" };
  config.gate = [];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

/** `jfdi run` prints the id it minted on its first line. */
function ticketIdOf(output: string): string {
  const match = /^ticket:\s*(\S+)/m.exec(output);
  if (!match?.[1]) throw new Error(`no ticket id in CLI output:\n${output}`);
  return match[1];
}

interface Landed {
  ticketId: string;
  signedOff: string;
  landing: string;
}

/**
 * One ticket, all the way through: pipeline to Ready to Merge, read the commit
 * the reviews bound to while the branch still exists, then approve. Splitting
 * it at the approval is what makes the sign-off sha observable — the branch is
 * deleted once it lands.
 */
async function landOneTicket(sandbox: Sandbox, cardText: string, file: string): Promise<Landed> {
  const run = await runCli(sandbox, ["run", cardText], file);
  expect(run.code, run.output).toBe(0);
  expect(run.output).toContain("ready to merge");
  const ticketId = ticketIdOf(run.output);
  const signedOff = await git(sandbox.project, "rev-parse", `jfdi/${ticketId}`);

  const merge = await runCli(sandbox, ["merge", ticketId], file);
  expect(merge.code, merge.output).toBe(0);
  expect(merge.output).toContain(`Merged into ${TARGET_BRANCH}`);
  return {
    ticketId,
    signedOff,
    landing: await git(sandbox.project, "rev-parse", TARGET_BRANCH),
  };
}

beforeAll(async () => {
  // Always rebuild: a stale dist/ would let these pass against old behavior.
  await execFileAsync("pnpm", ["build"], { cwd: repoRoot });
}, BUILD_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("the shape integration leaves on the target branch", () => {
  it(
    "lands one merge commit per ticket, sign-off second, on a configured non-main target",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox);
      const base = await git(sandbox.project, "rev-parse", TARGET_BRANCH);
      const mainHead = await git(sandbox.project, "rev-parse", "main");

      const first = await landOneTicket(sandbox, "Add the first feature", "first.txt");
      const second = await landOneTicket(sandbox, "Add the second feature", "second.txt");

      // Parentage: target line first, the reviewed commit second.
      expect(await git(sandbox.project, "rev-parse", `${first.landing}^1`)).toBe(base);
      expect(await git(sandbox.project, "rev-parse", `${first.landing}^2`)).toBe(first.signedOff);
      expect(await git(sandbox.project, "rev-parse", `${second.landing}^1`)).toBe(first.landing);
      expect(await git(sandbox.project, "rev-parse", `${second.landing}^2`)).toBe(second.signedOff);

      // Two tickets, two entries on the first-parent line — and it names them.
      const firstParent = await git(
        sandbox.project,
        "log",
        "--first-parent",
        "--format=%s",
        `${base}..${TARGET_BRANCH}`,
      );
      expect(firstParent.split("\n")).toEqual([
        `Merge jfdi/${second.ticketId} into ${TARGET_BRANCH}`,
        `Merge jfdi/${first.ticketId} into ${TARGET_BRANCH}`,
      ]);
      // The work itself is still in the graph underneath that line.
      expect(
        Number(await git(sandbox.project, "rev-list", "--count", `${base}..${TARGET_BRANCH}`)),
      ).toBeGreaterThan(2);

      // Sign-offs stay reachable after their branches are deleted.
      for (const landed of [first, second]) {
        expect(await git(sandbox.project, "branch", "--list", `jfdi/${landed.ticketId}`)).toBe("");
        expect(
          await git(
            sandbox.project,
            "merge-base",
            "--is-ancestor",
            landed.signedOff,
            TARGET_BRANCH,
          ),
        ).toBe("");
      }

      // Both features landed, and the branch that was merely present did not move.
      expect(await git(sandbox.project, "show", `${TARGET_BRANCH}:first.txt`)).toBe("built");
      expect(await git(sandbox.project, "show", `${TARGET_BRANCH}:second.txt`)).toBe("built");
      expect(await git(sandbox.project, "rev-parse", "main")).toBe(mainHead);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "lands a merge commit even when the target could fast-forward",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox);
      const base = await git(sandbox.project, "rev-parse", TARGET_BRANCH);

      // Nothing else touches the target, so a fast-forward is available and
      // deliberately not taken: one uniform shape per ticket.
      const landed = await landOneTicket(sandbox, "The only feature", "solo.txt");

      expect(landed.landing).not.toBe(landed.signedOff);
      expect(await git(sandbox.project, "rev-parse", `${landed.landing}^1`)).toBe(base);
      expect(await git(sandbox.project, "rev-parse", `${landed.landing}^2`)).toBe(landed.signedOff);
      expect(
        await git(
          sandbox.project,
          "rev-list",
          "--count",
          "--first-parent",
          `${base}..${TARGET_BRANCH}`,
        ),
      ).toBe("1");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
