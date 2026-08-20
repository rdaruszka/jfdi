/**
 * Adversarial QA coverage for the opt-in remote fetch/push integration, aimed
 * at gaps the implementation's own suite and integrate-remote.qa.test.ts leave:
 *   - push is gated behind a *landed* merge: a gate failure at integration must
 *     block with zero push attempts and zero remote retries (acceptance:
 *     "gate failures and merge conflicts retry zero times");
 *   - pushAfter also fires on the conflict-resolution path, not just clean
 *     merges (the other suites only push clean merges);
 *   - fetch-fast-forward and push cooperate inside a single integration, so the
 *     remote ends at a landing commit that already carries the fetched work.
 * All against real git and real bare remotes, the shape the product runs in.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JfdiEvent } from "./events.js";
import { git, revParse } from "./git.js";
import { integrateTicket } from "./integrate.js";
import { runPipeline } from "./pipeline.js";
import {
  commitFile,
  type Fixture,
  makeFixture,
  sessionKindOf,
  writeVerdict,
} from "./test-helpers.js";
import { resolveTicket } from "./tickets.js";

let fixture: Fixture;

/** A bare origin whose main starts at the fixture's target, with upstream set. */
async function addOrigin(): Promise<string> {
  const remote = path.join(fixture.root, "origin.git");
  await fs.mkdir(remote);
  await git(remote, "init", "--bare", "--initial-branch=main");
  await git(fixture.repo, "remote", "add", "origin", remote);
  await git(fixture.repo, "push", "-u", "origin", "main");
  return remote;
}

/** Clone origin as a separate collaborator with its own identity. */
async function clonePublisher(remote: string): Promise<string> {
  const publisher = path.join(fixture.root, "publisher");
  await git(fixture.root, "clone", remote, publisher);
  await git(publisher, "config", "user.email", "publisher@jfdi.local");
  await git(publisher, "config", "user.name", "JFDI Publisher Test");
  return publisher;
}

/** Sails a clean ticket through the pipeline; the integration agent never runs. */
function passingHandler(file: string) {
  return async (prompt: string, options: { cwd: string }) => {
    const stage = sessionKindOf(prompt);
    if (stage === "implementation") {
      await commitFile(options.cwd, file, "feature\n", `implement ${file}`);
      await writeVerdict(prompt, { status: "done", summary: `built ${file}` });
    } else if (stage === "integration") {
      throw new Error("integration agent should not run for clean merges");
    } else {
      await writeVerdict(prompt, { verdict: "pass" });
    }
    return { ok: true, text: "" };
  };
}

beforeEach(async () => {
  fixture = await makeFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("remote integration — adversarial QA", () => {
  /**
   * Push is defined as "after the merge commit lands." A gate failure at
   * integration lands nothing, so with pushAfter on there must be no push at
   * all — not a rejected push, not a retried one. This pins that a gate failure
   * short-circuits before the remote machinery, keeping "gate failures retry
   * zero times" honest even when a push is configured.
   */
  it("never pushes when the post-merge gate fails, and does not retry", async () => {
    // A gate that only fails once the target's poison file is merged in: the
    // pipeline's own gate runs pass (the worktree lacks the file), and the
    // failure appears only at integration, after target is merged into branch.
    const gated = await makeFixture({
      gate: [{ name: "reject-poison", command: "test ! -f integration-poison.txt" }],
    });
    fixture = gated;
    const remote = await addOrigin();
    const remoteHead = await revParse(remote, "refs/heads/main");
    const context = gated.context(passingHandler("clean-feature.txt"));
    context.config.integration.remote.pushAfter = true;
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));
    const ticket = await resolveTicket("Gate fails at integration", gated.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass before integration");

    // Target moves with a file the gate rejects — merged in, not conflicting.
    await commitFile(gated.repo, "integration-poison.txt", "boom\n", "add poison to target");
    const preIntegrationLocal = await revParse(gated.repo, "main");

    const result = await integrateTicket(context, ticket, outcome.worktree);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.reason).toContain("gate failed");
    // The local target never advanced past its pre-integration head, and the
    // remote was never touched: no push attempt, no retry, no success.
    expect(await revParse(gated.repo, "main")).toBe(preIntegrationLocal);
    expect(await revParse(remote, "refs/heads/main")).toBe(remoteHead);
    const pushActivity = events.filter(
      (event) => event.type === "integration_activity" && event.data?.operation === "push",
    );
    expect(pushActivity).toHaveLength(0);
  });

  /**
   * The other suites only push after a clean merge (their integration agent
   * throws). Push must equally follow a conflict that the Integration agent
   * resolves — the merge still lands, so the target still gets pushed.
   */
  it("pushes the landed target after a conflict-resolved merge", async () => {
    const remote = await addOrigin();
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await commitFile(options.cwd, "README.md", "branch version\n", "edit readme");
        await writeVerdict(prompt, { status: "done" });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });
    context.config.integration.remote.pushAfter = true;
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));
    const ticket = await resolveTicket("Conflict then push", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    // Conflicting change on the target so integration must resolve it.
    await commitFile(fixture.repo, "README.md", "main version\n", "conflicting main edit");

    const integrationContext = fixture.context(async (prompt, options) => {
      expect(sessionKindOf(prompt)).toBe("integration");
      await fs.writeFile(path.join(options.cwd, "README.md"), "merged version\n");
      await git(options.cwd, "add", "README.md");
      await git(options.cwd, "commit", "--no-edit");
      await writeVerdict(prompt, { resolution: "clean", notes: "kept both edits" });
      return { ok: true, text: "" };
    });
    integrationContext.config.integration.remote.pushAfter = true;
    integrationContext.log.on((event) => events.push(event));

    const result = await integrateTicket(integrationContext, ticket, outcome.worktree);

    expect(result).toEqual({ status: "merged" });
    // The remote's target now equals the local landing commit — the conflict
    // resolution reached the remote, not just the local branch.
    expect(await revParse(remote, "refs/heads/main")).toBe(await revParse(fixture.repo, "main"));
    expect(await git(remote, "show", "main:README.md")).toBe("merged version");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "integration_activity",
        data: expect.objectContaining({ operation: "push", status: "succeeded" }),
      }),
    );
  });

  /**
   * fetchBefore and pushAfter in one integration: the remote moved (so the
   * local target must fast-forward first), then the landed merge is pushed. The
   * remote must end at the landing commit, and that commit must contain both the
   * fetched remote work and the ticket's own work.
   */
  it("fast-forwards to fetched work and pushes the landing commit in one integration", async () => {
    const remote = await addOrigin();
    const context = fixture.context(passingHandler("ticket-work.txt"));
    context.config.integration.remote.fetchBefore = true;
    context.config.integration.remote.pushAfter = true;
    const ticket = await resolveTicket("Fetch and push", fixture.ticketsDirectory);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    // A collaborator advances the remote target after the branch was cut.
    const publisher = await clonePublisher(remote);
    await commitFile(publisher, "remote-work.txt", "remote\n", "remote target work");
    await git(publisher, "push", "origin", "main");
    const remoteCommitBeforeLanding = await revParse(remote, "refs/heads/main");

    const result = await integrateTicket(context, ticket, outcome.worktree);

    expect(result).toEqual({ status: "merged" });
    const landing = await revParse(fixture.repo, "main");
    // Remote ends exactly at the local landing commit.
    expect(await revParse(remote, "refs/heads/main")).toBe(landing);
    // The landing's first parent is the fetched remote commit — the target was
    // fast-forwarded onto the remote work before the merge was built.
    expect(await git(fixture.repo, "rev-parse", "main^1")).toBe(remoteCommitBeforeLanding);
    // Both the fetched remote work and the ticket work are in what the remote holds.
    expect(await git(remote, "show", "main:remote-work.txt")).toBe("remote");
    expect(await git(remote, "show", "main:ticket-work.txt")).toBe("feature");
  });
});
