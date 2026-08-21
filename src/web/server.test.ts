import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { EventLog } from "../events.js";
import type { SettingsSnapshot } from "../settings.js";
import { startWebFrontEnd, type WebFrontEnd, type WebSettingsSurface } from "./server.js";

let frontEnd: WebFrontEnd | null = null;

function memorySettings(): WebSettingsSurface {
  let snapshot: SettingsSnapshot = { config: defaultConfig(), revision: "initial" };
  return {
    load: () => Promise.resolve(snapshot),
    save: (staged) => {
      snapshot = { config: staged as SettingsSnapshot["config"], revision: "saved" };
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

    const writeAttempt = await fetch(frontEnd.url, { method: "POST" });
    expect(writeAttempt.status).toBe(405);
    expect(writeAttempt.headers.get("allow")).toBe("GET, HEAD");

    const stream = await fetch(new URL("events", frontEnd.url));
    if (stream.body === null) throw new Error("web event stream has no response body");
    const reader = stream.body.getReader();
    const initial = await readEventPayload(reader);
    expect(initial.boardName).toBe("board.md");
    expect(initial.targetBranch).toBe("main");

    log.emit("dispatch", "watch-runs", { title: "Watch runs", branch: "jfdi/watch-runs" });
    await readEventPayload(reader);
    log.emit("round_start", "watch-runs", { round: 2 });
    await readEventPayload(reader);
    log.emit("stage_start", "watch-runs", { stage: "qa" });
    await readEventPayload(reader);
    log.emit("harness_paused", undefined, {
      kind: "usage-limit",
      detail: "allowance exhausted",
      resumesAt: "2026-08-20T13:00:00.000Z",
    });

    const update = await readEventPayload(reader);
    expect(update).toMatchObject({
      view: {
        pause: { kind: "usage-limit", detail: "allowance exhausted" },
        state: {
          tickets: {
            "watch-runs": { status: "running", stage: "qa", round: 2 },
          },
        },
      },
    });
    await reader.cancel();
  });

  it("loads settings and sends staged values only on Save", async () => {
    const saves: unknown[] = [];
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      boardName: "board.md",
      targetBranch: "main",
      settings: {
        load: () => Promise.resolve({ config: defaultConfig(), revision: "disk-version" }),
        save: (staged, revision) => {
          saves.push({ staged, revision });
          return Promise.resolve({
            config: staged as SettingsSnapshot["config"],
            revision: "saved-version",
          });
        },
      },
    });

    const loaded = await fetch(new URL("settings", frontEnd.url));
    expect(await loaded.json()).toMatchObject({
      config: { maxConcurrent: 2, frontEnd: "terminal" },
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
  });

  it("frees its assigned port when closed", async () => {
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      boardName: "board.md",
      targetBranch: "main",
      settings: memorySettings(),
    });
    const port = Number(new URL(frontEnd.url).port);

    await frontEnd.close();
    frontEnd = null;

    await expect(bindPort(port)).resolves.toBeUndefined();
  });
});
