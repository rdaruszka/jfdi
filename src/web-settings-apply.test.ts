/**
 * The write surface end to end: a Save through the real HTTP settings endpoint
 * flows into `saveSettings` (validate + atomic file rewrite) and then into the
 * live coordinator via `applyConfig` — the exact wiring `startWithWebFrontEnd`
 * composes. The unit tests cover each piece alone (server.test.ts stubs the
 * surface, settings.test.ts drives the file, coordinator.test.ts calls
 * applyConfig directly); nothing else proves the three cooperate over a socket.
 *
 * The acceptance criteria pinned here that the other suites cannot reach
 * together:
 *   - A successful Save rewrites .jfdi/config.json AND the running coordinator
 *     adopts the new values, live, with no restart.
 *   - Raising maxConcurrent fills the new capacity immediately without
 *     interrupting the run already in flight.
 *   - frontEnd is written to the file but never applied to the live instance.
 *   - An invalid staged value is refused with the offending option named, and
 *     nothing is written or applied.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findColumn, parseBoard } from "./board.js";
import { Coordinator } from "./coordinator.js";
import { loadSettings, saveSettings } from "./settings.js";
import {
  commitFile,
  type Fixture,
  makeFixture,
  sessionKindOf,
  writeVerdict,
} from "./test-helpers.js";
import { startWebFrontEnd, type WebFrontEnd } from "./web/server.js";

let fixture: Fixture;
let coordinators: Coordinator[];
let frontEnds: WebFrontEnd[];

const TWO_CARD_BOARD = `---

kanban-plugin: board

---

## Ready

- [ ] Add feature alpha
- [ ] Add feature beta

## In Progress

## Done

`;

const WAIT_ATTEMPTS = 200;
const WAIT_STEP_MS = 20;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntil(isSatisfied: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
    if (isSatisfied()) return;
    await sleep(WAIT_STEP_MS);
  }
  throw new Error(`condition never held after ${WAIT_ATTEMPTS} attempts`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

function featureName(prompt: string): string {
  return /feature (\w+)/.exec(prompt)?.[1] ?? "unknown";
}

async function readBoard(): Promise<ReturnType<typeof parseBoard>> {
  return parseBoard(await fs.readFile(path.join(fixture.jfdiDirectory, "board.md"), "utf8"));
}

/** The settings surface `startWithWebFrontEnd` builds: disk save, then live apply. */
function liveSettings(coordinator: Coordinator, projectRoot: string) {
  return {
    load: () => loadSettings(projectRoot),
    save: async (staged: unknown, revision: string) => {
      const saved = await saveSettings(projectRoot, staged, revision);
      await coordinator.applyConfig(saved.config);
      return saved;
    },
  };
}

beforeEach(async () => {
  coordinators = [];
  frontEnds = [];
  fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.jfdiDirectory, "board.md"), TWO_CARD_BOARD);
});

afterEach(async () => {
  for (const frontEnd of frontEnds) await frontEnd.close();
  for (const coordinator of coordinators) coordinator.stop();
  await fixture.cleanup();
});

describe("web settings save applied to the live coordinator", () => {
  it("raises maxConcurrent over HTTP, filling capacity without interrupting the active run", async () => {
    // Start at capacity 1 on disk and in the coordinator's own config, so only
    // one card dispatches until a Save changes it. Both must agree, or the
    // staleness revision the panel loads would not describe what the run holds.
    fixture.config.maxConcurrent = 1;
    fixture.config.integration.mode = "on-approval";
    await fs.writeFile(
      path.join(fixture.jfdiDirectory, "config.json"),
      `${JSON.stringify(fixture.config, null, 2)}\n`,
    );

    const alphaRelease = deferred();
    const betaRelease = deferred();
    const startedImplementations: string[] = [];
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        const name = featureName(prompt);
        startedImplementations.push(name);
        if (name === "alpha") await alphaRelease.promise;
        if (name === "beta") await betaRelease.promise;
        await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
        await writeVerdict(prompt, { status: "done", summary: `built ${name}` });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    coordinators.push(coordinator);
    const frontEnd = await startWebFrontEnd({
      log: context.log,
      projectRoot: context.projectRoot,
      ticketsDirectory: context.config.ticketsDirectory,
      boardName: "board.md",
      targetBranch: context.config.integration.targetBranch,
      integrationMode: context.config.integration.mode,
      settings: liveSettings(coordinator, context.projectRoot),
    });
    frontEnds.push(frontEnd);
    await coordinator.start();

    try {
      // Capacity 1: only the first card runs, and it is blocked mid-session.
      await waitUntil(() => startedImplementations.length === 1);
      expect(startedImplementations).toEqual(["alpha"]);
      await sleep(WAIT_STEP_MS * 3);
      expect(startedImplementations).toEqual(["alpha"]);
      expect(coordinator.activeCount()).toBe(1);

      // Load the panel's current view, stage maxConcurrent: 2 and frontEnd: web,
      // and Save it over the same HTTP endpoint the browser posts to.
      const loaded = (await (await fetch(new URL("settings", frontEnd.url))).json()) as {
        config: Record<string, unknown>;
        revision: string;
      };
      expect(loaded.config).toMatchObject({ maxConcurrent: 1, frontEnd: "terminal" });

      const response = await fetch(new URL("settings", frontEnd.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...loaded.config, maxConcurrent: 2, frontEnd: "web" },
          revision: loaded.revision,
        }),
      });
      expect(response.status).toBe(200);

      // The live coordinator adopted the raised capacity and dispatched beta,
      // while alpha kept running — raising the ceiling never interrupts work.
      await waitUntil(() => startedImplementations.length === 2);
      expect([...startedImplementations].sort()).toEqual(["alpha", "beta"]);
      expect(coordinator.activeCount()).toBe(2);

      // The file was rewritten with both staged values...
      const onDisk = JSON.parse(
        await fs.readFile(path.join(fixture.jfdiDirectory, "config.json"), "utf8"),
      ) as { maxConcurrent: number; frontEnd: string };
      expect(onDisk.maxConcurrent).toBe(2);
      expect(onDisk.frontEnd).toBe("web");
      // ...but frontEnd never applies live: the running instance keeps terminal.
      expect(context.config.maxConcurrent).toBe(2);
      expect(context.config.frontEnd).toBe("terminal");
    } finally {
      alphaRelease.resolve();
      betaRelease.resolve();
      await coordinator.drain();
    }

    const board = await readBoard();
    expect(
      findColumn(board, "Ready to Merge")
        ?.cards.map((card) => card.text)
        .sort(),
    ).toEqual(["Add feature alpha", "Add feature beta"]);
  });

  it("refuses an invalid Save over HTTP without writing the file or touching the live config", async () => {
    fixture.config.maxConcurrent = 2;
    fixture.config.integration.mode = "on-approval";
    await fs.writeFile(
      path.join(fixture.jfdiDirectory, "config.json"),
      `${JSON.stringify(fixture.config, null, 2)}\n`,
    );

    const release = deferred();
    const context = fixture.context(async (prompt, options) => {
      const stage = sessionKindOf(prompt);
      if (stage === "implementation") {
        await release.promise;
        const name = featureName(prompt);
        await commitFile(options.cwd, `${name}.txt`, `${name}\n`, `implement ${name}`);
        await writeVerdict(prompt, { status: "done", summary: `built ${name}` });
      } else {
        await writeVerdict(prompt, { verdict: "pass" });
      }
      return { ok: true, text: "" };
    });

    const coordinator = new Coordinator(context, { pollMs: 60_000 });
    coordinators.push(coordinator);
    const frontEnd = await startWebFrontEnd({
      log: context.log,
      projectRoot: context.projectRoot,
      ticketsDirectory: context.config.ticketsDirectory,
      boardName: "board.md",
      targetBranch: context.config.integration.targetBranch,
      integrationMode: context.config.integration.mode,
      settings: liveSettings(coordinator, context.projectRoot),
    });
    frontEnds.push(frontEnd);
    await coordinator.start();

    try {
      const configPath = path.join(fixture.jfdiDirectory, "config.json");
      const before = await fs.readFile(configPath, "utf8");
      const loaded = (await (await fetch(new URL("settings", frontEnd.url))).json()) as {
        config: Record<string, unknown>;
        revision: string;
      };

      const response = await fetch(new URL("settings", frontEnd.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...loaded.config, maxConcurrent: 0 },
          revision: loaded.revision,
        }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("maxConcurrent"),
      });

      // Nothing written, nothing applied: the file and the live ceiling stand.
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
      expect(context.config.maxConcurrent).toBe(2);
    } finally {
      release.resolve();
      await coordinator.drain();
    }
  });
});
