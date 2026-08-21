import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig } from "../config.js";
import { EventLog } from "../events.js";
import type { SettingsSnapshot } from "../settings.js";
import { startWebFrontEnd, type WebFrontEnd, type WebSettingsSurface } from "./server.js";

let frontEnd: WebFrontEnd | null = null;
let projectRoot: string | null = null;

async function makeProjectRoot(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "jfdi-web-detail-"));
  projectRoot = created;
  return created;
}

function memorySettings(): WebSettingsSurface {
  let snapshot: SettingsSnapshot = {
    config: defaultConfig(),
    editableConfig: { ...defaultConfig() },
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
  if (projectRoot !== null) await fs.rm(projectRoot, { recursive: true, force: true });
  projectRoot = null;
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
      projectRoot: "unused",
      ticketsDirectory: ".jfdi/tickets",
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
    expect(pageMarkup).toContain(
      'data-config-path="pipeline.maxRejections.code-review" type="number"',
    );
    expect(pageMarkup).toContain('data-config-path="pipeline.maxRejections.qa" type="number"');
    expect(pageMarkup).toContain(
      'data-config-path="integration.remote.fetchBefore" type="checkbox"',
    );
    expect(pageMarkup).toContain('data-config-path="integration.mode"');
    expect(pageMarkup).toContain('id="settings-gate-add"');
    expect(pageMarkup).toContain('settingsChoices = {"integrationModes":["auto","on-approval"]');
    expect(pageMarkup).toContain('"harnessNames":["claude","codex"]');
    expect(pageMarkup).toContain("pointAtSettingsField(body.field, body.error)");
    expect(pageMarkup).toContain('id="kanban"');
    expect(pageMarkup).toContain('id="ticket-detail"');
    expect(pageMarkup).toContain('id="board-return"');
    expect(pageMarkup).toContain('id="session-tabs"');
    expect(pageMarkup).toContain('id="feed-output"');
    expect(pageMarkup).toContain("isFeedAtBottom(feed)");
    expect(pageMarkup).toContain(
      "feed.scrollTop = shouldFollow ? feed.scrollHeight : previousScrollTop",
    );
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
      projectRoot: "unused",
      ticketsDirectory: ".jfdi/tickets",
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

  it("serves current ticket content and folds the latest run logs into stage tabs", async () => {
    const root = await makeProjectRoot();
    const stateDirectory = path.join(root, "state");
    const ticketsDirectory = path.join(root, ".jfdi", "tickets");
    await fs.mkdir(ticketsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(ticketsDirectory, "detail-ticket.md"),
      [
        "# Detail ticket",
        "",
        "Explain the change.",
        "",
        "## Acceptance criteria",
        "",
        "- It works.",
        "",
        "## Comments",
        "",
        "### 2026-08-20T12:00:00.000Z — JFDI started",
        "",
        "> Starting the run.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(ticketsDirectory, "ready-ticket.md"),
      "# Ready ticket\n\nNothing has run.\n",
    );
    const latestRun = path.join(stateDirectory, "runs", "detail-ticket", "run-2");
    await fs.mkdir(path.join(latestRun, "round-1", "gate-fix-1"), { recursive: true });
    await fs.mkdir(path.join(latestRun, "round-1", "verdict-fix-1"), { recursive: true });
    await fs.mkdir(path.join(latestRun, "round-2"), { recursive: true });
    await fs.mkdir(path.join(stateDirectory, "runs", "detail-ticket", "run-1", "round-1"), {
      recursive: true,
    });
    const claudeLine = (text: string) =>
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
    const codexLine = (text: string) =>
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`;
    await fs.writeFile(
      path.join(latestRun, "round-1", "implementation.log.jsonl"),
      claudeLine("implementation history\nsecond line"),
    );
    await fs.writeFile(
      path.join(latestRun, "round-1", "verdict-fix-1", "implementation.log.jsonl"),
      codexLine("corrected verdict"),
    );
    await fs.writeFile(
      path.join(latestRun, "round-1", "gate-fix-1", "implementation.log.jsonl"),
      codexLine("fixed the gate"),
    );
    await fs.writeFile(
      path.join(latestRun, "round-1", "code-review.log.jsonl"),
      codexLine("review history"),
    );
    await fs.writeFile(
      path.join(latestRun, "round-1", "implementation.commit-message.log.jsonl"),
      claudeLine("scribe output"),
    );
    await fs.writeFile(
      path.join(latestRun, "round-2", "implementation.log.jsonl"),
      claudeLine("round two history"),
    );
    await fs.writeFile(
      path.join(latestRun, "round-2", "qa.log.jsonl"),
      codexLine("fresh round two QA"),
    );
    await fs.writeFile(
      path.join(stateDirectory, "runs", "detail-ticket", "run-1", "round-1", "qa.log.jsonl"),
      codexLine("stale run"),
    );
    await fs.mkdir(path.join(stateDirectory, "runs", "ready-ticket", "run-1", "round-1"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(stateDirectory, "runs", "ready-ticket", "run-1", "round-1", "qa.log.jsonl"),
      codexLine("old ready history"),
    );

    const log = new EventLog(stateDirectory);
    log.emit("dispatch", "detail-ticket", {
      title: "Detail card [[detail-ticket]]",
      branch: "jfdi/detail-ticket",
    });
    log.emit("round_start", "detail-ticket", { round: 1 });
    log.emit("stage_start", "detail-ticket", { stage: "implementation" });
    log.emit("stage_start", "detail-ticket", { stage: "code-review" });
    log.emit("round_start", "detail-ticket", { round: 2 });
    log.emit("stage_start", "detail-ticket", { stage: "implementation", isContinuation: true });
    log.emit("stage_start", "detail-ticket", { stage: "qa" });
    log.emit("ready", "ready-ticket", { title: "Ready card [[ready-ticket]]" });
    await log.flush();
    frontEnd = await startWebFrontEnd({
      log,
      projectRoot: root,
      ticketsDirectory: ".jfdi/tickets",
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: memorySettings(),
    });

    const response = await fetch(new URL("ticket-detail?ticketId=detail-ticket", frontEnd.url));
    expect(response.status).toBe(200);
    const detail = (await response.json()) as {
      title: string;
      description: string;
      comments: Array<{ label: string; body: string }>;
      sessions: Array<{ key: string; label: string; content: string }>;
    };
    expect(detail).toMatchObject({
      title: "Detail ticket",
      description: "Explain the change.\n\n## Acceptance criteria\n\n- It works.",
      comments: [{ label: "JFDI started", body: "Starting the run." }],
    });
    expect(detail.sessions.map(({ label }) => label)).toEqual([
      "Implementation",
      "Code Review",
      "QA round 2",
    ]);
    expect(detail.sessions[0]?.content).toContain("implementation history\nsecond line");
    expect(detail.sessions[0]?.content).toContain("corrected verdict");
    expect(detail.sessions[0]?.content).toContain("fixed the gate");
    expect(detail.sessions[0]?.content).toContain("round two history");
    expect(detail.sessions[2]?.content).toContain("fresh round two QA");
    expect(JSON.stringify(detail.sessions)).not.toContain("scribe output");
    expect(JSON.stringify(detail.sessions)).not.toContain("stale run");

    const readyResponse = await fetch(new URL("ticket-detail?ticketId=ready-ticket", frontEnd.url));
    expect(await readyResponse.json()).toMatchObject({
      title: "Ready ticket",
      description: "Nothing has run.",
      sessions: [],
    });

    await fs.appendFile(
      path.join(ticketsDirectory, "detail-ticket.md"),
      "\n### 2026-08-20T12:01:00.000Z — Implementation round 1 complete\n\n> Comment arrived.\n",
    );
    const updatedTicket = await fetch(
      new URL("ticket-detail?ticketId=detail-ticket", frontEnd.url),
    );
    expect(await updatedTicket.json()).toMatchObject({
      comments: [
        { label: "JFDI started", body: "Starting the run." },
        { label: "Implementation round 1 complete", body: "Comment arrived." },
      ],
    });

    await fs.appendFile(
      path.join(latestRun, "round-2", "implementation.log.jsonl"),
      codexLine("live output arrived"),
    );
    const live = await fetch(new URL("ticket-detail?ticketId=detail-ticket", frontEnd.url));
    expect(JSON.stringify((await live.json()) as unknown)).toContain("live output arrived");
  });

  it("loads settings and sends staged values only on Save", async () => {
    const saves: unknown[] = [];
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      projectRoot: "unused",
      ticketsDirectory: ".jfdi/tickets",
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: {
        load: () =>
          Promise.resolve({
            config: defaultConfig(),
            editableConfig: { ...defaultConfig() },
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
      projectRoot: "unused",
      ticketsDirectory: ".jfdi/tickets",
      boardName: "board.md",
      targetBranch: "main",
      integrationMode: "auto",
      settings: {
        load: () =>
          Promise.resolve({
            config: defaultConfig(),
            editableConfig: { ...defaultConfig() },
            revision: "disk-version",
          }),
        save: () =>
          Promise.reject(
            new ConfigError("pipeline.maxRejections.qa must be a non-negative integer"),
          ),
      },
    });

    const response = await fetch(new URL("settings", frontEnd.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: defaultConfig(), revision: "disk-version" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "pipeline.maxRejections.qa must be a non-negative integer",
      field: "pipeline.maxRejections.qa",
    });
  });

  it("frees its assigned port when closed", async () => {
    frontEnd = await startWebFrontEnd({
      log: new EventLog("unused", false),
      projectRoot: "unused",
      ticketsDirectory: ".jfdi/tickets",
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
