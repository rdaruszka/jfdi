/**
 * QA regression coverage for the opt-in remote fetch/push integration surface.
 * Derived from the ticket's acceptance criteria and its explicitly out-of-scope
 * list, exercised against real git and real bare remotes — the same shape the
 * product runs in. These sit alongside the implementation's own tests in
 * integrate.test.ts and target gaps in that suite plus the ticket's boundaries:
 * push via a non-origin upstream, the fetch-scope guarantee (only the target
 * branch), the strictly-ahead-target edge, and the recovery affordances a
 * rejected push must leave behind.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLog, JfdiEvent } from "./events.js";
import { git, isAncestor, revParse } from "./git.js";
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

/** Sails a ticket through the pipeline (no gate configured); no conflicts. */
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

/** A bare origin whose main starts at the fixture's target, with upstream set. */
async function addOrigin(): Promise<string> {
  const remote = path.join(fixture.root, "origin.git");
  await fs.mkdir(remote);
  await git(remote, "init", "--bare", "--initial-branch=main");
  await git(fixture.repo, "remote", "add", "origin", remote);
  await git(fixture.repo, "push", "-u", "origin", "main");
  return remote;
}

/** Clone origin as a separate human collaborator with its own identity. */
async function clonePublisher(remote: string): Promise<string> {
  const publisher = path.join(fixture.root, "publisher");
  await git(fixture.root, "clone", remote, publisher);
  await git(publisher, "config", "user.email", "publisher@jfdi.local");
  await git(publisher, "config", "user.name", "JFDI Publisher Test");
  return publisher;
}

/** Resolve when the remote-operation stream reaches a status count. */
function waitForRemoteEventCount(
  events: JfdiEvent[],
  log: Pick<EventLog, "on">,
  status: string,
  count: number,
): Promise<void> {
  const matchingCount = () => events.filter((event) => event.data?.status === status).length;
  if (matchingCount() >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = log.on(() => {
      if (matchingCount() < count) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Advance fake time once for each of the four fixed remote-retry delays. */
async function driveRemoteRetries(events: JfdiEvent[], log: Pick<EventLog, "on">): Promise<void> {
  const delaysMs = [30_000, 60_000, 120_000, 240_000];
  for (let retryIndex = 0; retryIndex < delaysMs.length; retryIndex += 1) {
    await waitForRemoteEventCount(events, log, "retry", retryIndex + 1);
    await vi.advanceTimersByTimeAsync(delaysMs[retryIndex] as number);
  }
}

beforeEach(async () => {
  fixture = await makeFixture();
});

afterEach(async () => {
  vi.useRealTimers();
  await fixture.cleanup();
});

describe("remote integration — QA regression", () => {
  /**
   * The remote is "the target branch's configured upstream if it has one, else
   * origin" — with no remote_name option. So a target tracking a remote that is
   * not named "origin" must push to that upstream, proving resolution reads the
   * upstream rather than assuming origin.
   */
  it("pushes the landed target to a non-origin configured upstream", async () => {
    const remote = await addOrigin();
    await git(fixture.repo, "remote", "rename", "origin", "central");
    const context = fixture.context(passingHandler("upstream-push.txt"));
    context.config.integration.remote.push_after = true;
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));
    const ticket = await resolveTicket("Push via upstream", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    expect(await integrateTicket(context, ticket, outcome.worktree)).toEqual({ status: "merged" });
    // The remote's target now equals the local landing commit — pushed via
    // "central", the resolved upstream, never a hard-coded "origin".
    expect(await revParse(remote, "refs/heads/main")).toBe(await revParse(fixture.repo, "main"));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "integration_activity",
        data: expect.objectContaining({
          operation: "push",
          status: "succeeded",
          remote: "central",
        }),
      }),
    );
  });

  /**
   * Out of scope: "Fetching or pulling anything other than the target branch."
   * A remote carrying an unrelated branch must not have that branch fetched —
   * only the target's remote-tracking ref may appear after integration.
   */
  it("fetches only the target branch, never a sibling branch on the same remote", async () => {
    const remote = await addOrigin();
    const publisher = await clonePublisher(remote);
    // A branch JFDI must never touch.
    await git(publisher, "checkout", "-b", "sidebranch");
    await commitFile(publisher, "side.txt", "side\n", "side work");
    await git(publisher, "push", "origin", "sidebranch");
    // Real target movement so the fetch has something legitimate to fast-forward.
    await git(publisher, "checkout", "main");
    await commitFile(publisher, "remote-main.txt", "remote\n", "remote target work");
    await git(publisher, "push", "origin", "main");

    const context = fixture.context(passingHandler("scoped-fetch.txt"));
    context.config.integration.remote.fetch_before = true;
    const ticket = await resolveTicket("Scoped fetch", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    expect(await integrateTicket(context, ticket, outcome.worktree)).toEqual({ status: "merged" });
    const trackingRefs = (
      await git(fixture.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/")
    )
      .split("\n")
      .filter(Boolean);
    expect(trackingRefs).toContain("refs/remotes/origin/main");
    expect(trackingRefs).not.toContain("refs/remotes/origin/sidebranch");
    // The remote target's work still made it into the landed merge.
    expect(await fs.readFile(path.join(fixture.repo, "remote-main.txt"), "utf8")).toBe("remote\n");
  });

  /**
   * A local target strictly ahead of the fetched ref — the fetched ref is an
   * ancestor of local, no remote-only commits — is not a divergence: there is
   * nothing to sync, and a plain push would fast-forward the remote. The
   * original implementation blocked here and called the target "diverged",
   * which froze self-hosted integration the first time a landing went unpushed
   * ([[ahead-is-not-divergence]]). Only true divergence may block.
   */
  it("proceeds when the local target is strictly ahead of the fetched ref", async () => {
    const remote = await addOrigin();
    // Local main advances past the remote without any diverging remote commit.
    await commitFile(fixture.repo, "unpushed-landing.txt", "local\n", "unpushed local work");
    const remoteHead = await revParse(remote, "refs/heads/main");
    // This is the ahead case, not a true divergence: remote is an ancestor of local.
    expect(await isAncestor(fixture.repo, remoteHead, "main")).toBe(true);

    const context = fixture.context(passingHandler("ahead-ticket.txt"));
    context.config.integration.remote.fetch_before = true;
    const ticket = await resolveTicket("Ahead target", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");

    expect(await integrateTicket(context, ticket, outcome.worktree)).toEqual({ status: "merged" });
    // The landing built on top of the ahead local history, and the fetch-only
    // config never touched the remote.
    expect(await isAncestor(fixture.repo, remoteHead, "main")).toBe(true);
    expect(await revParse(remote, "refs/heads/main")).toBe(remoteHead);
  });

  /**
   * With push_after ALSO on, each landing is pushed, so remote and local stay
   * in lockstep across several tickets — the both-flags config the ticket's
   * example shows stays green with no drift in either direction.
   */
  it("keeps both flags green across multiple tickets, remote and local in lockstep", async () => {
    const remote = await addOrigin();
    for (const file of ["one.txt", "two.txt", "three.txt"]) {
      const context = fixture.context(passingHandler(file));
      context.config.integration.remote.fetch_before = true;
      context.config.integration.remote.push_after = true;
      const ticket = await resolveTicket(`Ship ${file}`, fixture.ticketsDir);
      const outcome = await runPipeline(context, ticket);
      if (outcome.status !== "passed") throw new Error(`pipeline should pass for ${file}`);
      expect(await integrateTicket(context, ticket, outcome.worktree)).toEqual({
        status: "merged",
      });
      // After every ticket the remote target equals the local target.
      expect(await revParse(remote, "refs/heads/main")).toBe(await revParse(fixture.repo, "main"));
    }
    // All three landings reached the remote target's first-parent line.
    expect(await git(remote, "rev-list", "--count", "--first-parent", "refs/heads/main")).not.toBe(
      "1",
    );
  });

  /**
   * Point 3 again, from the recovery side: a rejected push is reported and the
   * local merge stands, but the run must also leave the branch and worktree in
   * place so a human can push by hand and re-dispatch — a block that deleted the
   * branch would strand the landed-but-unpushed commit.
   */
  it("preserves the ticket branch and worktree after a rejected push blocks", async () => {
    const remote = await addOrigin();
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\necho 'remote refuses this push' >&2\nexit 1\n");
    await fs.chmod(hook, 0o755);
    const context = fixture.context(passingHandler("blocked-push.txt"));
    context.config.integration.remote.push_after = true;
    const events: JfdiEvent[] = [];
    context.log.on((event) => events.push(event));
    const ticket = await resolveTicket("Rejected push recovery", fixture.ticketsDir);
    const outcome = await runPipeline(context, ticket);
    if (outcome.status !== "passed") throw new Error("pipeline should pass");
    const branch = outcome.worktree.branch;
    const preLandingHead = await revParse(fixture.repo, "main");
    const remoteHead = await revParse(remote, "refs/heads/main");

    vi.useFakeTimers();
    const integration = integrateTicket(context, ticket, outcome.worktree);
    await driveRemoteRetries(events, context.log);
    const result = await integration;
    vi.useRealTimers();

    expect(result.status).toBe("blocked");
    // The local merge stands: main advanced to the landing commit and was NOT
    // rolled back despite the push failure.
    const landedLocally = await revParse(fixture.repo, "main");
    expect(landedLocally).not.toBe(preLandingHead);
    // The branch carrying the sign-off is still present for a manual push +
    // re-dispatch, and it is reachable from the landed merge.
    expect(await git(fixture.repo, "branch", "--list", branch)).not.toBe("");
    expect(await isAncestor(fixture.repo, branch, "main")).toBe(true);
    // The worktree is kept for inspection rather than force-removed.
    await expect(fs.access(outcome.worktree.path)).resolves.toBeUndefined();
    // Five attempts, and the remote never advanced past where it began.
    expect(events.filter((event) => event.data?.status === "attempt")).toHaveLength(5);
    expect(await revParse(remote, "refs/heads/main")).toBe(remoteHead);
  });
});
