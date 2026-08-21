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
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";

const execFileAsync = promisify(execFile);

const projectRoot = path.dirname(import.meta.dirname);
const cliPath = path.join(projectRoot, "dist", "index.js");

const SCENARIO_TIMEOUT_MS = 180_000;

/** The target branch every scenario integrates onto — deliberately not `main`. */
const TARGET_BRANCH = "trunk";

/**
 * The agent both stubbed CLIs play; it never talks to the network. It replays
 * the stream-json lines each parser needs, writes the verdict file its prompt
 * names, and — for the implementation stage — commits the file named in
 * `STUB_FILE` so each ticket touches a different path.
 *
 * With `STUB_ROUNDS` set it commits that many times, so a branch can carry the
 * fix-round history the no-squash rule protects. With `STUB_LEFTOVERS` set it
 * plays the sloppy agent instead: the integration session resolves the conflict
 * and commits it but drops a stray file it never commits, calls the resolution
 * `complicated`, and the re-QA session it triggers writes its regression test
 * without committing that either.
 *
 * Every integration session first appends what it was handed — merge state or
 * rebase state, conflicted paths, the branch head it stands on — to
 * `STUB_SESSION_LOG`, so a test can count the resolutions a merge cost.
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
// The scribe answers in its result text; every other session in a verdict file.
const scribedRound = /round (\\d+) of/.exec(prompt);
const resultText = prompt.includes("Write the commit message") && scribedRound
  ? "scribed round " + scribedRound[1]
  : "done";
process.on("exit", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }) + "\\n"));
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stub" }] } }) + "\\n");
const match = prompt.match(/(\\/\\S+\\.verdict\\.json)/);
if (match) {
  const verdictPath = match[1];
  const stage = verdictPath.split("/").pop().replace(".verdict.json", "");
  const run = (args) => execFileSync("git", args, { cwd: process.cwd() });
  const capture = (args) => execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
  // The verdict path lives in the worktree and no longer encodes the round;
  // read it off the versioned file the implementation sessions write instead:
  // the version already in the tree is the round under review, and one higher
  // is the round the next implementation session is about to write.
  const featureFile = process.cwd() + "/" + process.env.STUB_FILE;
  const featureContent = fs.existsSync(featureFile) ? fs.readFileSync(featureFile, "utf8") : "";
  const featureVersion = Number((/built v(\\d+)/.exec(featureContent) || [])[1] || "1");
  let verdict;
  if (stage === "implementation") {
    // One session, one change: the pipeline commits it. A branch of several
    // commits comes from several rounds, which the review below drives.
    const rounds = Number(process.env.STUB_ROUNDS || "1");
    const round = featureContent === "" ? 1 : featureVersion + 1;
    fs.writeFileSync(featureFile, rounds === 1 ? "built\\n" : "built v" + round + "\\n");
    verdict = { status: "done", summary: "implemented " + process.env.STUB_FILE };
  } else if (stage === "integration") {
    const gitDirectory = capture(["rev-parse", "--absolute-git-dir"]);
    fs.appendFileSync(process.env.STUB_SESSION_LOG, JSON.stringify({
      isMidMerge: fs.existsSync(gitDirectory + "/MERGE_HEAD"),
      isMidRebase: fs.existsSync(gitDirectory + "/rebase-merge") || fs.existsSync(gitDirectory + "/rebase-apply"),
      conflicted: capture(["diff", "--name-only", "--diff-filter=U"]).split("\\n").filter(Boolean),
      head: capture(["rev-parse", "HEAD"]),
    }) + "\\n");
    if (fs.existsSync(gitDirectory + "/MERGE_HEAD")) {
      fs.writeFileSync(process.cwd() + "/" + process.env.STUB_FILE, "reconciled\\n");
      run(["add", process.env.STUB_FILE]);
      run(["commit", "--no-edit"]);
    }
    if (process.env.STUB_LEFTOVERS) {
      fs.writeFileSync(process.cwd() + "/agent-leftover.txt", "stray\\n");
      verdict = { resolution: "complicated", notes: "reworked logic" };
    } else {
      verdict = { resolution: "clean", notes: "took both sides" };
    }
  } else if (stage === "code-review" && featureVersion < Number(process.env.STUB_ROUNDS || "1")) {
    // Fail every round but the last, so the branch ends with one commit per round.
    verdict = { verdict: "fail", feedback: "round " + featureVersion + " is not there yet" };
  } else {
    // The post-merge requalification QA announces itself in its gate summary.
    if (process.env.STUB_LEFTOVERS && prompt.includes("just merged in with conflict resolutions")) {
      fs.writeFileSync(process.cwd() + "/requalify-note.txt", "re-verified\\n");
    }
    verdict = { verdict: "pass" };
  }
  fs.mkdirSync(verdictPath.replace(/\\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify(verdict));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }) + "\\n");
`;

interface Sandbox {
  root: string;
  projectRoot: string;
  home: string;
  jfdiHome: string;
  executableDirectory: string;
}

const sandboxRoots: string[] = [];

async function makeSandbox(): Promise<Sandbox> {
  // Outside any parent git repo: both git and Claude Code walk up the tree.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-merge-shape-"));
  const root = await fs.realpath(created);
  sandboxRoots.push(created);
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const executableDirectory = path.join(root, "bin");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(executableDirectory);
  for (const executable of ["claude", "codex"]) {
    await fs.writeFile(path.join(executableDirectory, executable), STUB_AGENT, { mode: 0o755 });
  }

  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.email", "test@jfdi.local");
  await git(projectRoot, "config", "user.name", "JFDI Test");
  await fs.writeFile(path.join(projectRoot, "README.md"), "product\n");
  await git(projectRoot, "add", "-A");
  await git(projectRoot, "commit", "-m", "initial");
  // The ticket branches are cut from the target, so it has to be the checkout.
  await git(projectRoot, "checkout", "-b", TARGET_BRANCH);

  return { root, projectRoot, home, jfdiHome: path.join(home, ".jfdi"), executableDirectory };
}

/** Which agent the stubs play for one CLI invocation. */
interface StubOptions {
  file: string;
  shouldLeaveLeftovers?: boolean;
  /** Commits the implementation session makes — a branch with fix rounds. */
  rounds?: number;
}

/** Where the stubbed integration sessions record what each was handed. */
function sessionLogPath(sandbox: Sandbox): string {
  return path.join(sandbox.root, "integration-sessions.jsonl");
}

function sandboxEnv(sandbox: Sandbox, stub: StubOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.executableDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: sandbox.home,
    JFDI_HOME: sandbox.jfdiHome,
    STUB_FILE: stub.file,
    STUB_SESSION_LOG: sessionLogPath(sandbox),
    ...(stub.rounds ? { STUB_ROUNDS: String(stub.rounds) } : {}),
    ...(stub.shouldLeaveLeftovers ? { STUB_LEFTOVERS: "1" } : {}),
    NO_COLOR: "1",
  };
}

/** What each Integration agent session was handed, in the order they ran. */
interface IntegrationSession {
  isMidMerge: boolean;
  isMidRebase: boolean;
  conflicted: string[];
  head: string;
}

async function integrationSessions(sandbox: Sandbox): Promise<IntegrationSession[]> {
  const log = await fs.readFile(sessionLogPath(sandbox), "utf8").catch(() => "");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IntegrationSession);
}

interface CliResult {
  code: number;
  output: string;
}

async function runCli(sandbox: Sandbox, args: string[], stub: StubOptions): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: sandbox.projectRoot,
      env: sandboxEnv(sandbox, stub),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** Scaffold `.jfdi/`, then point integration at the non-main target. */
async function scaffold(sandbox: Sandbox, gate: Array<{ name: string; command: string }> = []) {
  const result = await runCli(sandbox, ["init", "--bare"], { file: "unused.txt" });
  expect(result.code, result.output).toBe(0);
  await configure(sandbox, gate);
}

async function configure(
  sandbox: Sandbox,
  gate: Array<{ name: string; command: string }>,
): Promise<void> {
  const configPath = path.join(sandbox.projectRoot, ".jfdi", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  config.integration = {
    targetBranch: TARGET_BRANCH,
    mode: "on-approval",
    remote: { fetchBefore: false, pushAfter: false },
  };
  config.gate = gate;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function ticketNote(sandbox: Sandbox, ticketId: string): Promise<string> {
  return fs.readFile(path.join(sandbox.projectRoot, ".jfdi", "tickets", `${ticketId}.md`), "utf8");
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
 * Take one ticket through the pipeline and stop at the approval, so the commit
 * the reviews bound to is still readable — the branch is deleted once it lands.
 */
async function runToMergeReady(
  sandbox: Sandbox,
  cardText: string,
  file: string,
  rounds?: number,
): Promise<{ ticketId: string; signedOff: string }> {
  const run = await runCli(sandbox, ["run", cardText], {
    file,
    ...(rounds === undefined ? {} : { rounds }),
  });
  expect(run.code, run.output).toBe(0);
  expect(run.output).toContain("ready to merge");
  const ticketId = ticketIdOf(run.output);
  return { ticketId, signedOff: await git(sandbox.projectRoot, "rev-parse", `jfdi/${ticketId}`) };
}

/**
 * One ticket, all the way through: pipeline to Ready to Merge, read the commit
 * the reviews bound to while the branch still exists, then approve. Splitting
 * it at the approval is what makes the sign-off sha observable — the branch is
 * deleted once it lands.
 */
async function landOneTicket(sandbox: Sandbox, cardText: string, file: string): Promise<Landed> {
  const { ticketId, signedOff } = await runToMergeReady(sandbox, cardText, file);
  const merge = await runCli(sandbox, ["merge", ticketId], { file });
  expect(merge.code, merge.output).toBe(0);
  expect(merge.output).toContain(`Merged into ${TARGET_BRANCH}`);
  // Nothing was left uncommitted, so integration must not claim it swept
  // anything — neither while it runs nor in the record the ticket note keeps.
  expect(merge.output).not.toContain("left uncommitted");
  expect(await ticketNote(sandbox, ticketId)).not.toContain("Uncommitted changes");
  return {
    ticketId,
    signedOff,
    landing: await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH),
  };
}

afterEach(async () => {
  await Promise.all(
    sandboxRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("the shape integration leaves on the target branch", () => {
  it(
    "lands one merge commit per ticket, sign-off second, on a configured non-main target",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox);
      const base = await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH);
      const mainHead = await git(sandbox.projectRoot, "rev-parse", "main");

      const first = await landOneTicket(sandbox, "Add the first feature", "first.txt");
      const second = await landOneTicket(sandbox, "Add the second feature", "second.txt");

      // Parentage: target line first, the reviewed commit second.
      expect(await git(sandbox.projectRoot, "rev-parse", `${first.landing}^1`)).toBe(base);
      expect(await git(sandbox.projectRoot, "rev-parse", `${first.landing}^2`)).toBe(
        first.signedOff,
      );
      expect(await git(sandbox.projectRoot, "rev-parse", `${second.landing}^1`)).toBe(
        first.landing,
      );
      expect(await git(sandbox.projectRoot, "rev-parse", `${second.landing}^2`)).toBe(
        second.signedOff,
      );

      // Two tickets, two entries on the first-parent line — and it names them.
      const firstParent = await git(
        sandbox.projectRoot,
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
        Number(await git(sandbox.projectRoot, "rev-list", "--count", `${base}..${TARGET_BRANCH}`)),
      ).toBeGreaterThan(2);

      // Sign-offs stay reachable after their branches are deleted.
      for (const landed of [first, second]) {
        expect(await git(sandbox.projectRoot, "branch", "--list", `jfdi/${landed.ticketId}`)).toBe(
          "",
        );
        expect(
          await git(
            sandbox.projectRoot,
            "merge-base",
            "--is-ancestor",
            landed.signedOff,
            TARGET_BRANCH,
          ),
        ).toBe("");
      }

      // Both features landed, and the branch that was merely present did not move.
      expect(await git(sandbox.projectRoot, "show", `${TARGET_BRANCH}:first.txt`)).toBe("built");
      expect(await git(sandbox.projectRoot, "show", `${TARGET_BRANCH}:second.txt`)).toBe("built");
      expect(await git(sandbox.projectRoot, "rev-parse", "main")).toBe(mainHead);
    },
    SCENARIO_TIMEOUT_MS,
  );

  /**
   * The gate runs against the working tree; the landing commit is built from a
   * git tree. Sessions that leave work uncommitted sit in that gap — and a
   * successful integration removes the worktree, so anything dropped there is
   * gone for good. Both integration sessions are sloppy here: the conflict
   * resolution leaves a stray file, and the re-QA valve leaves the very
   * regression test it exists to produce.
   */
  it(
    "lands everything the pre-land gate saw when sessions leave the worktree dirty",
    async () => {
      const sandbox = await makeSandbox();
      const listingFile = path.join(sandbox.root, "gate-listing.txt");
      await scaffold(sandbox);
      const { ticketId, signedOff } = await runToMergeReady(sandbox, "Add a feature", "gamma.txt");

      // A colliding commit on the target, so approving hits a real conflict.
      await fs.writeFile(path.join(sandbox.projectRoot, "gamma.txt"), "target version\n");
      await git(sandbox.projectRoot, "add", "gamma.txt");
      await git(sandbox.projectRoot, "commit", "-m", "collide on the target");
      const targetHead = await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH);
      // From here the gate records the working tree it actually ran against.
      await configure(sandbox, [{ name: "record-worktree", command: `ls -1 > ${listingFile}` }]);

      const merge = await runCli(sandbox, ["merge", ticketId], {
        file: "gamma.txt",
        shouldLeaveLeftovers: true,
      });

      expect(merge.code, merge.output).toBe(0);
      expect(merge.output).toContain(`Merged into ${TARGET_BRANCH}`);
      // Fail loud: the sweep is reported, not done behind the operator's back.
      expect(merge.output).toContain("left uncommitted");

      const gateSaw = (await fs.readFile(listingFile, "utf8")).split("\n").filter(Boolean);
      const landed = (await git(sandbox.projectRoot, "ls-tree", "--name-only", TARGET_BRANCH))
        .split("\n")
        .filter(Boolean);
      // Both leftovers really were left, and both are in what landed.
      expect(gateSaw).toContain("requalify-note.txt");
      expect(gateSaw).toContain("agent-leftover.txt");
      for (const entry of gateSaw) expect(landed).toContain(entry);
      expect(await git(sandbox.projectRoot, "show", `${TARGET_BRANCH}:requalify-note.txt`)).toBe(
        "re-verified",
      );

      // Sweeping leftovers must not disturb the shape or the sign-off.
      expect(await git(sandbox.projectRoot, "rev-parse", `${TARGET_BRANCH}^1`)).toBe(targetHead);
      expect(await git(sandbox.projectRoot, "rev-parse", `${TARGET_BRANCH}^2`)).toBe(signedOff);
      expect(
        await git(
          sandbox.projectRoot,
          "rev-list",
          "--count",
          "--first-parent",
          `${targetHead}..${TARGET_BRANCH}`,
        ),
      ).toBe("1");

      // ...and the ticket note keeps the durable record of it.
      expect(await ticketNote(sandbox, ticketId)).toContain(
        "Uncommitted changes a session left behind were committed",
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  /**
   * "Conflicts resolve once": the ticket's case against rebase is that a branch
   * of N commits touching one file pays for the same conflict N times, and each
   * replay hands a synthetic, never-gate-tested state to an Integration agent.
   * A three-commit branch colliding with the target must therefore cost exactly
   * one agent session, standing on the signed-off commit itself, inside a merge
   * — and every one of those three commits must survive into the target's graph,
   * because the no-squash rule exists to keep round history readable.
   */
  it(
    "pays for one conflict resolution however many commits the branch holds",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox);
      const { ticketId, signedOff } = await runToMergeReady(
        sandbox,
        "Add a feature over three rounds",
        "delta.txt",
        3,
      );
      const branchCommits = (
        await git(sandbox.projectRoot, "log", "--format=%H %s", "-3", `jfdi/${ticketId}`)
      )
        .split("\n")
        .map((line) => {
          const separator = line.indexOf(" ");
          return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
        });

      // The target changes the same file: one conflict, three times over under
      // a rebase, once under a merge.
      await fs.writeFile(path.join(sandbox.projectRoot, "delta.txt"), "target version\n");
      await git(sandbox.projectRoot, "add", "delta.txt");
      await git(sandbox.projectRoot, "commit", "-m", "collide on the target");
      const targetHead = await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH);

      const merge = await runCli(sandbox, ["merge", ticketId], { file: "delta.txt" });
      expect(merge.code, merge.output).toBe(0);

      const sessions = await integrationSessions(sandbox);
      expect(sessions).toHaveLength(1);
      // What the one session was handed: a merge (not a replay), one conflicted
      // path, standing on the reviewed commit rather than a rewritten copy.
      expect(sessions[0]).toMatchObject({
        isMidMerge: true,
        isMidRebase: false,
        conflicted: ["delta.txt"],
        head: signedOff,
      });

      // The resolution landed under the settled shape, not beside it.
      expect(await git(sandbox.projectRoot, "rev-parse", `${TARGET_BRANCH}^1`)).toBe(targetHead);
      expect(await git(sandbox.projectRoot, "rev-parse", `${TARGET_BRANCH}^2`)).toBe(signedOff);
      expect(
        await git(
          sandbox.projectRoot,
          "rev-list",
          "--count",
          "--first-parent",
          `${targetHead}..${TARGET_BRANCH}`,
        ),
      ).toBe("1");
      expect(await git(sandbox.projectRoot, "show", `${TARGET_BRANCH}:delta.txt`)).toBe(
        "reconciled",
      );

      // Every round the branch recorded is still in the graph, by its own sha.
      expect(branchCommits.map((commit) => commit.subject)).toEqual([
        `${ticketId}: scribed round 3`,
        `${ticketId}: scribed round 2`,
        `${ticketId}: scribed round 1`,
      ]);
      for (const commit of branchCommits) {
        expect(
          await git(sandbox.projectRoot, "merge-base", "--is-ancestor", commit.sha, TARGET_BRANCH),
        ).toBe("");
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  /**
   * A human merging the branch themselves is a supported approval route, and
   * the short-circuit that recognizes it has to survive the design change: a
   * second merge commit for work already on the target would put a ticket on
   * the first-parent line twice.
   */
  it(
    "closes a branch the human already merged without landing a second commit",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox);
      const { ticketId } = await runToMergeReady(sandbox, "Add a feature", "epsilon.txt");

      await git(
        sandbox.projectRoot,
        "merge",
        "--no-ff",
        "-m",
        "merged by hand",
        `jfdi/${ticketId}`,
      );
      const handMerged = await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH);

      const merge = await runCli(sandbox, ["merge", ticketId], { file: "epsilon.txt" });

      expect(merge.code, merge.output).toBe(0);
      expect(merge.output).toContain("already contained in the target");
      // Nothing was merged a second time, and no agent was spent deciding that.
      expect(await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH)).toBe(handMerged);
      expect(await integrationSessions(sandbox)).toEqual([]);
      expect(await ticketNote(sandbox, ticketId)).toContain(
        `Branch already contained in \`${TARGET_BRANCH}\` — closed without re-merging.`,
      );
      expect(
        await fs
          .access(path.join(sandbox.projectRoot, ".jfdi", "worktrees", ticketId))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "lands a merge commit even when the target could fast-forward",
    async () => {
      const sandbox = await makeSandbox();
      await scaffold(sandbox);
      const base = await git(sandbox.projectRoot, "rev-parse", TARGET_BRANCH);

      // Nothing else touches the target, so a fast-forward is available and
      // deliberately not taken: one uniform shape per ticket.
      const landed = await landOneTicket(sandbox, "The only feature", "solo.txt");

      expect(landed.landing).not.toBe(landed.signedOff);
      expect(await git(sandbox.projectRoot, "rev-parse", `${landed.landing}^1`)).toBe(base);
      expect(await git(sandbox.projectRoot, "rev-parse", `${landed.landing}^2`)).toBe(
        landed.signedOff,
      );
      expect(
        await git(
          sandbox.projectRoot,
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
