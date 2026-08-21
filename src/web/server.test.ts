import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../events.js";
import { startWebFrontEnd, type WebFrontEnd } from "./server.js";

let frontEnd: WebFrontEnd | null = null;

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
  it("serves a read-only page from loopback and streams the same live view", async () => {
    const log = new EventLog("unused", false);
    frontEnd = await startWebFrontEnd({
      log,
      boardName: "board.md",
      targetBranch: "main",
    });

    expect(new URL(frontEnd.url).hostname).toBe("127.0.0.1");
    const page = await fetch(frontEnd.url);
    expect(page.status).toBe(200);
    const pageMarkup = await page.text();
    expect(pageMarkup).toContain("JFDI");
    expect(pageMarkup).not.toMatch(/<(?:button|form|input)\b/);

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

  it("frees its assigned port when closed", async () => {
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      boardName: "board.md",
      targetBranch: "main",
    });
    const port = Number(new URL(frontEnd.url).port);

    await frontEnd.close();
    frontEnd = null;

    await expect(bindPort(port)).resolves.toBeUndefined();
  });
});
