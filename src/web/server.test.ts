import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig } from "../config.js";
import { EventLog } from "../events.js";
import type { SettingsSnapshot } from "../settings.js";
import { startWebFrontEnd, type WebFrontEnd, type WebSettingsSurface } from "./server.js";

let frontEnd: WebFrontEnd | null = null;

function memorySettings(): WebSettingsSurface {
  let snapshot: SettingsSnapshot = {
    config: defaultConfig(),
    editableConfig: defaultConfig(),
    revision: "initial",
  };
  return {
    load: () => Promise.resolve(snapshot),
    save: (staged) => {
      snapshot = {
        config: staged as SettingsSnapshot["config"],
        editableConfig: staged as SettingsSnapshot["editableConfig"],
        revision: "saved",
      };
      return Promise.resolve(snapshot);
    },
  };
}

afterEach(async () => {
  await frontEnd?.close();
  frontEnd = null;
});

async function readEventPayload(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let text = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await reader.read();
    if (result.done) throw new Error("web event stream ended before a payload arrived");
    text += decoder.decode(result.value, { stream: true });
    const boundary = text.indexOf("\n\n");
    if (boundary !== -1) {
      const line = text
        .slice(0, boundary)
        .split("\n")
        .find((entry) => entry.startsWith("data: "));
      if (line === undefined) throw new Error(`web event payload has no data line: ${text}`);
      return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
    }
  }
  throw new Error("web event stream produced no complete payload within 20 reads");
}

function cardsIn(payload: Record<string, unknown>, columnName: string): unknown[] | undefined {
  return (payload.columns as Array<{ name: string; cards: unknown[] }>).find(
    (column) => column.name === columnName,
  )?.cards;
}

async function bindPort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("web front end", () => {
  it("serves the live view and a settings panel from loopback", async () => {
    const log = new EventLog("unused", false);
    frontEnd = await startWebFrontEnd({
      log,
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "on-approval",
      settings: memorySettings(),
    });

    expect(new URL(frontEnd.url).hostname).toBe("127.0.0.1");
    const page = await fetch(frontEnd.url);
    expect(page.status).toBe(200);
    const pageMarkup = await page.text();
    expect(pageMarkup).toContain("JFDI");
    expect(pageMarkup).toContain('id="settings-open"');
    expect(pageMarkup).toContain('id="settings-save"');
    expect(pageMarkup).toContain('id="settings-cancel"');
    expect(pageMarkup).toContain('id="settings-reload"');
    expect(pageMarkup).toContain("switching front ends requires a restart");
    expect(pageMarkup).not.toContain("<textarea");
    expect(pageMarkup).toContain('data-config-path="pipeline.maxRounds" type="number"');
    expect(pageMarkup).toContain(
      'data-config-path="integration.remote.fetchBefore" type="checkbox"',
    );
    expect(pageMarkup).toContain('data-config-path="integration.mode"');
    expect(pageMarkup).toContain('id="settings-gate-add"');
    expect(pageMarkup).toContain('settingsChoices = {"integrationModes":["auto","on-approval"]');
    expect(pageMarkup).toContain('"harnessNames":["claude","codex"]');
    expect(pageMarkup).toContain("pointAtSettingsField(body.field, body.error)");
    expect(pageMarkup).toContain('id="kanban"');
    expect(pageMarkup).not.toContain("Active (0)");
    expect(pageMarkup).not.toContain(">Events<");
    expect(pageMarkup).not.toContain("lastActivity");

    const writeAttempt = await fetch(frontEnd.url, { method: "POST" });
    expect(writeAttempt.status).toBe(405);
    expect(writeAttempt.headers.get("allow")).toBe("GET, HEAD");

    const stream = await fetch(new URL("events", frontEnd.url));
    if (stream.body === null) throw new Error("web event stream has no response body");
    const reader = stream.body.getReader();
    const initial = await readEventPayload(reader);
    expect(initial.boardName).toBe("board.md");
    expect(initial.targetBranch).toBe("main");
    expect((initial.columns as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "Ready",
      "Implementation",
      "Code Review",
      "QA",
      "Integration",
      "Blocked",
      "Ready to Merge",
      "Done",
    ]);

    log.emit("ready", "waiting-card", { title: "Waiting card [[waiting-card]]" });
    const ready = await readEventPayload(reader);
    expect(
      (ready.columns as Array<{ name: string; cards: unknown[] }>).find(
        (column) => column.name === "Ready",
      )?.cards,
    ).toEqual([{ id: "waiting-card", title: "Waiting card [[waiting-card]]" }]);

    log.emit("dispatch", "watch-runs", { title: "Watch runs", branch: "jfdi/watch-runs" });
    await readEventPayload(reader);
    log.emit("round_start", "watch-runs", { round: 2 });
    await readEventPayload(reader);
    log.emit("stage_start", "watch-runs", { stage: "code-review" });
    const codeReview = await readEventPayload(reader);
    expect(cardsIn(codeReview, "Code Review")).toEqual([{ id: "watch-runs", title: "Watch runs" }]);
    log.emit("stage_start", "watch-runs", { stage: "qa" });
    await readEventPayload(reader);
    log.emit("harness_paused", undefined, {
      kind: "usage-limit",
      detail: "allowance exhausted",
      resumesAt: "2026-08-20T13:00:00.000Z",
    });

    const update = await readEventPayload(reader);
    expect(update).toMatchObject({
      pause: { kind: "usage-limit", detail: "allowance exhausted" },
    });
    expect(update.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "QA",
          cards: [{ id: "watch-runs", title: "Watch runs" }],
        }),
      ]),
    );

    log.emit("merge_queued", "watch-runs");
    expect(cardsIn(await readEventPayload(reader), "Integration")).toEqual([
      { id: "watch-runs", title: "Watch runs" },
    ]);
    log.emit("blocked", "watch-runs", { reason: "needs attention" });
    expect(cardsIn(await readEventPayload(reader), "Blocked")).toEqual([
      { id: "watch-runs", title: "Watch runs" },
    ]);
    log.emit("merge_ready", "watch-runs");
    expect(cardsIn(await readEventPayload(reader), "Ready to Merge")).toEqual([
      { id: "watch-runs", title: "Watch runs" },
    ]);
    log.emit("merged", "watch-runs");
    expect(cardsIn(await readEventPayload(reader), "Done")).toEqual([
      { id: "watch-runs", title: "Watch runs" },
    ]);
    await reader.cancel();
  });

  it("omits Ready to Merge in auto mode and streams feedback movement", async () => {
    const log = new EventLog("unused", false);
    frontEnd = await startWebFrontEnd({
      log,
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: memorySettings(),
    });

    const stream = await fetch(new URL("events", frontEnd.url));
    if (stream.body === null) throw new Error("web event stream has no response body");
    const reader = stream.body.getReader();
    const initial = await readEventPayload(reader);
    expect((initial.columns as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "Ready",
      "Implementation",
      "Code Review",
      "QA",
      "Integration",
      "Blocked",
      "Done",
    ]);

    log.emit("dispatch", "feedback", { title: "Fix feedback [[feedback]]" });
    await readEventPayload(reader);
    log.emit("stage_start", "feedback", { stage: "qa" });
    const qa = await readEventPayload(reader);
    expect(
      (qa.columns as Array<{ name: string; cards: unknown[] }>).find(
        (column) => column.name === "QA",
      )?.cards,
    ).toEqual([{ id: "feedback", title: "Fix feedback [[feedback]]" }]);

    log.emit("round_start", "feedback", { round: 2 });
    await readEventPayload(reader);
    log.emit("stage_start", "feedback", { stage: "implementation" });
    const implementation = await readEventPayload(reader);
    expect(
      (implementation.columns as Array<{ name: string; cards: unknown[] }>).find(
        (column) => column.name === "Implementation",
      )?.cards,
    ).toEqual([{ id: "feedback", title: "Fix feedback [[feedback]]" }]);
    await reader.cancel();
  });

  it("loads settings and sends staged values only on Save", async () => {
    const saves: unknown[] = [];
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: {
        load: () =>
          Promise.resolve({
            config: defaultConfig(),
            editableConfig: defaultConfig(),
            revision: "disk-version",
          }),
        save: (staged, revision) => {
          saves.push({ staged, revision });
          return Promise.resolve({
            config: staged as SettingsSnapshot["config"],
            editableConfig: staged as SettingsSnapshot["editableConfig"],
            revision: "saved-version",
          });
        },
      },
    });

    const stream = await fetch(new URL("events", frontEnd.url));
    if (stream.body === null) throw new Error("web event stream has no response body");
    const reader = stream.body.getReader();
    const initial = await readEventPayload(reader);
    expect((initial.columns as Array<{ name: string }>).map((column) => column.name)).not.toContain(
      "Ready to Merge",
    );

    const loaded = await fetch(new URL("settings", frontEnd.url));
    expect(await loaded.json()).toMatchObject({
      config: { maxConcurrent: 2, frontEnd: "terminal" },
      editableConfig: { maxConcurrent: 2, frontEnd: "terminal" },
      revision: "disk-version",
    });
    expect(saves).toEqual([]);

    const staged = { ...defaultConfig(), maxConcurrent: 4 };
    const saved = await fetch(new URL("settings", frontEnd.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: staged, revision: "disk-version" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: "saved-version" });
    expect(saves).toEqual([{ staged, revision: "disk-version" }]);
    const updated = await readEventPayload(reader);
    expect((updated.columns as Array<{ name: string }>).map((column) => column.name)).toContain(
      "Ready to Merge",
    );
    await reader.cancel();
  });

  it("returns the offending field with a configuration refusal", async () => {
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: {
        load: () =>
          Promise.resolve({
            config: defaultConfig(),
            editableConfig: defaultConfig(),
            revision: "disk-version",
          }),
        save: () =>
          Promise.reject(new ConfigError("pipeline.maxRounds must be a positive integer")),
      },
    });

    const response = await fetch(new URL("settings", frontEnd.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: defaultConfig(), revision: "disk-version" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "pipeline.maxRounds must be a positive integer",
      field: "pipeline.maxRounds",
    });
  });

  it("frees its assigned port when closed", async () => {
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: memorySettings(),
    });
    const port = Number(new URL(frontEnd.url).port);

    await frontEnd.close();
    frontEnd = null;

    await expect(bindPort(port)).resolves.toBeUndefined();
  });
});
