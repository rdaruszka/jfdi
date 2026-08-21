import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigError, type JfdiConfig } from "../config.js";
import type { EventLog, TicketState } from "../events.js";
import { initialLiveView, type LiveView, reduceLiveView } from "../renderers/live-view.js";
import { type SettingsSnapshot, SettingsStaleError } from "../settings.js";

const LOOPBACK_HOST = "127.0.0.1";
const ASSIGNED_PORT = 0;
const MAX_WEB_CLIENTS = 32;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface WebSettingsSurface {
  load(): Promise<SettingsSnapshot>;
  save(staged: unknown, revision: string): Promise<SettingsSnapshot>;
}

export interface WebFrontEndOptions {
  log: EventLog;
  boardName: string;
  targetBranch: string;
  integrationMode: JfdiConfig["integration"]["mode"];
  settings: WebSettingsSurface;
}

export interface WebFrontEnd {
  url: string;
  close(): Promise<void>;
  waitUntilExit(): Promise<void>;
}

interface KanbanCard {
  id: string;
  title: string;
}

type KanbanColumnName =
  | "Ready"
  | "Implementation"
  | "Code Review"
  | "QA"
  | "Integration"
  | "Blocked"
  | "Ready to Merge"
  | "Done";

interface KanbanColumn {
  name: KanbanColumnName;
  cards: KanbanCard[];
}

const AUTO_COLUMN_NAMES: KanbanColumnName[] = [
  "Ready",
  "Implementation",
  "Code Review",
  "QA",
  "Integration",
  "Blocked",
  "Done",
];

const ON_APPROVAL_COLUMN_NAMES: KanbanColumnName[] = [
  ...AUTO_COLUMN_NAMES.slice(0, -1),
  "Ready to Merge",
  "Done",
];

function runningColumn(ticket: TicketState): KanbanColumnName {
  switch (ticket.stage) {
    case null:
    case "implementation":
      return "Implementation";
    case "code-review":
      return "Code Review";
    case "qa":
      return "QA";
    case "integration":
      return "Integration";
  }
}

function ticketColumn(
  ticket: TicketState,
  integrationMode: JfdiConfig["integration"]["mode"],
): KanbanColumnName {
  switch (ticket.status) {
    case "ready":
    case "waiting":
      return "Ready";
    case "running":
      return runningColumn(ticket);
    case "merge-queued":
    case "merging":
      return "Integration";
    case "blocked":
    case "failed":
      return "Blocked";
    case "merge-ready":
      return integrationMode === "on-approval" ? "Ready to Merge" : "Integration";
    case "done":
      return "Done";
  }
}

function kanbanColumns(
  tickets: Record<string, TicketState>,
  integrationMode: JfdiConfig["integration"]["mode"],
): KanbanColumn[] {
  const names = integrationMode === "auto" ? AUTO_COLUMN_NAMES : ON_APPROVAL_COLUMN_NAMES;
  return names.map((name) => ({
    name,
    cards: Object.values(tickets)
      .filter((ticket) => ticketColumn(ticket, integrationMode) === name)
      .map((ticket) => ({ id: ticket.id, title: ticket.title })),
  }));
}

function payload(
  options: WebFrontEndOptions,
  view: LiveView,
  integrationMode: JfdiConfig["integration"]["mode"],
): string {
  return JSON.stringify({
    boardName: options.boardName,
    targetBranch: options.targetBranch,
    pause: view.pause,
    columns: kanbanColumns(view.state.tickets, integrationMode),
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JFDI runs</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0d10; color: #edf1f7; }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top right, #19243a 0, #0b0d10 36rem); min-height: 100vh; }
    main { width: calc(100% - 2rem); margin: 0 auto; padding: 2rem 0 4rem; }
    header { display: flex; align-items: baseline; gap: .8rem; margin-bottom: 1.5rem; }
    .brand { background: #edf1f7; color: #0b0d10; font-weight: 900; padding: .25rem .55rem; letter-spacing: .08em; }
    .route { color: #aab5c5; }
    .route strong { color: #edf1f7; }
    .live { margin-left: auto; color: #63d392; font-size: .8rem; }
    .live::before { content: ""; display: inline-block; width: .55rem; height: .55rem; margin-right: .45rem; border-radius: 50%; background: currentColor; box-shadow: 0 0 1rem currentColor; }
    button { border: 1px solid #536176; border-radius: .2rem; background: #18202b; color: #edf1f7; font: inherit; padding: .45rem .7rem; cursor: pointer; }
    button:hover { border-color: #78dce8; }
    .settings-button { margin-left: .25rem; }
    .settings-panel { position: fixed; inset: 0; z-index: 5; display: grid; place-items: center; padding: 1rem; background: rgba(4, 6, 9, .78); }
    .settings-card { width: min(780px, 100%); max-height: calc(100vh - 2rem); overflow: auto; padding: 1.2rem; border: 1px solid #3a4657; background: #10141a; box-shadow: 0 1.5rem 5rem #000; }
    .settings-card h2 { color: #edf1f7; font-size: 1rem; }
    .settings-card p { color: #aab5c5; font-size: .85rem; line-height: 1.5; }
    .settings-card label { display: block; margin: 1rem 0 .45rem; color: #cbd3df; font-size: .82rem; }
    #settings-editor { width: 100%; min-height: 24rem; resize: vertical; border: 1px solid #343e4d; background: #090c10; color: #edf1f7; font: inherit; line-height: 1.45; padding: .8rem; tab-size: 2; }
    .settings-actions { display: flex; align-items: center; gap: .6rem; margin-top: .8rem; }
    #settings-save { border-color: #4c9b70; background: #173326; }
    #settings-message { min-height: 1.3rem; margin: .8rem 0 0; color: #e5b567; }
    #settings-message.success { color: #63d392; }
    #pause { display: none; margin-bottom: 1.25rem; padding: .8rem 1rem; border: 1px solid #e5b567; background: #2b2418; color: #ffd58c; }
    h2 { margin: 0 0 .55rem; color: #aab5c5; font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; }
    .kanban { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(15rem, 1fr); gap: .8rem; overflow-x: auto; align-items: start; padding-bottom: 1rem; }
    .column { min-height: 12rem; padding: .75rem; border: 1px solid #29313d; background: rgba(14, 18, 24, .82); }
    .column h2 { display: flex; justify-content: space-between; gap: .5rem; margin-bottom: .75rem; }
    .count { color: #657184; }
    .cards { display: grid; gap: .55rem; }
    .card { min-height: 3.6rem; padding: .75rem; border: 1px solid #343e4d; border-radius: .2rem; background: #171d26; line-height: 1.4; overflow-wrap: anywhere; box-shadow: 0 .2rem .7rem rgba(0, 0, 0, .22); }
    [hidden] { display: none !important; }
    @media (max-width: 760px) { header { flex-wrap: wrap; } .live { margin-left: 0; } .settings-button { margin-left: auto; } }
  </style>
</head>
<body>
  <main>
    <header><span class="brand">JFDI</span><span class="route"><span id="board"></span> → <strong id="branch"></strong></span><span class="live">LIVE STATUS</span><button class="settings-button" id="settings-open" type="button">Settings</button></header>
    <aside id="pause"></aside>
    <div class="kanban" id="kanban" aria-label="Ticket states"></div>
  </main>
  <aside class="settings-panel" id="settings-panel" hidden>
    <div class="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <h2 id="settings-title">Instance settings</h2>
      <p>Edit every value in <code>.jfdi/config.json</code> below. Changes are staged here until Save. The <code>frontEnd</code> value is saved but switching front ends requires a restart.</p>
      <label for="settings-editor">Complete configuration</label>
      <textarea id="settings-editor" spellcheck="false"></textarea>
      <div class="settings-actions">
        <button id="settings-save" type="button">Save</button>
        <button id="settings-cancel" type="button">Cancel</button>
        <button id="settings-reload" type="button">Reload</button>
      </div>
      <p id="settings-message" role="status"></p>
    </div>
  </aside>
  <script>
    const element = (id) => document.getElementById(id);
    const text = (tag, className, value) => { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; };
    function renderColumns(columns) {
      const board = element("kanban"); board.replaceChildren();
      for (const column of columns) {
        const section = document.createElement("section"); section.className = "column";
        const heading = document.createElement("h2"); heading.append(text("span", "", column.name), text("span", "count", String(column.cards.length)));
        const cards = document.createElement("div"); cards.className = "cards";
        for (const card of column.cards) cards.append(text("div", "card", card.title));
        section.append(heading, cards); board.append(section);
      }
    }
    function pauseText(pause) {
      if (pause.resumesAt === null) return "Harness needs attention: " + pause.detail;
      const what = pause.kind === "usage-limit" ? "Usage limit" : "Harness " + pause.kind;
      return what + " — resumes " + new Date(pause.resumesAt).toLocaleTimeString();
    }
    function render(payload) {
      element("board").textContent = payload.boardName; element("branch").textContent = payload.targetBranch;
      renderColumns(payload.columns);
      const pause = element("pause"); pause.style.display = payload.pause === null ? "none" : "block"; pause.textContent = payload.pause === null ? "" : pauseText(payload.pause);
    }
    let settingsRevision = "";
    function settingsMessage(message, isSuccess = false) {
      const output = element("settings-message"); output.textContent = message; output.className = isSuccess ? "success" : "";
    }
    async function loadSettings() {
      settingsRevision = ""; element("settings-editor").value = "";
      settingsMessage("Loading…");
      try {
        const response = await fetch("settings");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load settings");
        settingsRevision = body.revision;
        element("settings-editor").value = JSON.stringify(body.config, null, 2);
        settingsMessage("Loaded from disk.", true);
      } catch (error) { settingsMessage(error.message); }
    }
    async function openSettings() {
      element("settings-panel").hidden = false;
      await loadSettings();
      element("settings-editor").focus();
    }
    function cancelSettings() {
      settingsRevision = ""; element("settings-editor").value = ""; settingsMessage(""); element("settings-panel").hidden = true;
    }
    async function saveSettings() {
      let config;
      try { config = JSON.parse(element("settings-editor").value); }
      catch (error) { settingsMessage("Invalid JSON: " + error.message); return; }
      settingsMessage("Saving…");
      try {
        const response = await fetch("settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, revision: settingsRevision }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not save settings");
        settingsRevision = body.revision;
        element("settings-editor").value = JSON.stringify(body.config, null, 2);
        settingsMessage("Saved and applied. Switching front ends still requires a restart.", true);
      } catch (error) { settingsMessage(error.message); }
    }
    element("settings-open").addEventListener("click", openSettings);
    element("settings-cancel").addEventListener("click", cancelSettings);
    element("settings-reload").addEventListener("click", loadSettings);
    element("settings-save").addEventListener("click", saveSettings);
    new EventSource("events").onmessage = (message) => render(JSON.parse(message.data));
  </script>
</body>
</html>
`;

function commonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'",
  );
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
  isHead = false,
): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(isHead ? undefined : `${JSON.stringify(body)}\n`);
}

async function readSettingsBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`settings request must be valid JSON: ${(error as Error).message}`);
  }
}

function settingsSaveInput(raw: unknown): { staged: unknown; revision: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("settings request must be an object");
  const input = raw as Record<string, unknown>;
  if (typeof input.revision !== "string" || input.revision.length === 0)
    throw new ConfigError("settings revision must be a non-empty string");
  if (!Object.hasOwn(input, "config")) throw new ConfigError("settings config is required");
  return { staged: input.config, revision: input.revision };
}

class RunningWebFrontEnd implements WebFrontEnd {
  readonly url: string;
  private readonly clients = new Set<ServerResponse>();
  private view: LiveView;
  private readonly unsubscribe: () => void;
  private closePromise: Promise<void> | null = null;
  private readonly exitPromise: Promise<void>;
  private integrationMode: JfdiConfig["integration"]["mode"];

  constructor(
    private readonly server: Server,
    private readonly options: WebFrontEndOptions,
    address: AddressInfo,
  ) {
    this.url = `http://${LOOPBACK_HOST}:${address.port}/`;
    this.integrationMode = options.integrationMode;
    this.view = initialLiveView(options.log.snapshot());
    this.unsubscribe = options.log.on((event, state) => {
      this.view = reduceLiveView(this.view, event, state);
      this.broadcast();
    });
    this.exitPromise = new Promise((resolve) => server.once("close", resolve));
  }

  async handle(
    request: IncomingMessage,
    requestPath: string,
    response: ServerResponse,
  ): Promise<void> {
    commonHeaders(response);
    if (requestPath === "/settings") {
      await this.handleSettings(request, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(HTTP_METHOD_NOT_ALLOWED, { allow: "GET, HEAD" });
      response.end("Method not allowed\n");
      return;
    }
    if (requestPath === "/") {
      response.writeHead(HTTP_OK, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : PAGE);
      return;
    }
    if (requestPath === "/events") {
      this.openEventStream(request.method, response);
      return;
    }
    response.writeHead(HTTP_NOT_FOUND, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }

  private async handleSettings(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const isHead = request.method === "HEAD";
    try {
      if (request.method === "GET" || isHead) {
        jsonResponse(response, HTTP_OK, await this.options.settings.load(), isHead);
        return;
      }
      if (request.method === "POST") {
        const { staged, revision } = settingsSaveInput(await readSettingsBody(request));
        const snapshot = await this.options.settings.save(staged, revision);
        this.integrationMode = snapshot.config.integration.mode;
        jsonResponse(response, HTTP_OK, snapshot);
        this.broadcast();
        return;
      }
      response.writeHead(HTTP_METHOD_NOT_ALLOWED, { allow: "GET, HEAD, POST" });
      response.end("Method not allowed\n");
    } catch (error) {
      if (error instanceof SettingsStaleError) {
        jsonResponse(response, HTTP_CONFLICT, { error: error.message });
        return;
      }
      if (error instanceof ConfigError) {
        jsonResponse(response, HTTP_BAD_REQUEST, { error: error.message });
        return;
      }
      jsonResponse(response, HTTP_INTERNAL_SERVER_ERROR, {
        error: `could not access config settings: ${(error as Error).message}`,
      });
    }
  }

  private openEventStream(requestMethod: string, response: ServerResponse): void {
    if (requestMethod === "HEAD") {
      response.writeHead(HTTP_OK, { "Content-Type": "text/event-stream" });
      response.end();
      return;
    }
    if (this.clients.size >= MAX_WEB_CLIENTS) {
      response.writeHead(HTTP_SERVICE_UNAVAILABLE, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Too many web front end clients\n");
      return;
    }
    response.writeHead(HTTP_OK, {
      "Content-Type": "text/event-stream",
      connection: "keep-alive",
    });
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
    this.writePayload(response);
  }

  private writePayload(response: ServerResponse): void {
    if (!response.write(`data: ${payload(this.options, this.view, this.integrationMode)}\n\n`))
      response.end();
  }

  private broadcast(): void {
    for (const response of this.clients) this.writePayload(response);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.unsubscribe();
    for (const response of this.clients) response.end();
    this.clients.clear();
    this.closePromise = new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    return this.closePromise;
  }

  waitUntilExit(): Promise<void> {
    return this.exitPromise;
  }
}

export async function startWebFrontEnd(options: WebFrontEndOptions): Promise<WebFrontEnd> {
  let running: RunningWebFrontEnd | null = null;
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
    if (running === null) {
      response.writeHead(HTTP_SERVICE_UNAVAILABLE, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Web front end is starting\n");
      return;
    }
    void running.handle(request, requestPath, response);
  });
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ASSIGNED_PORT, LOOPBACK_HOST, () => {
      server.off("error", reject);
      const boundAddress = server.address();
      if (boundAddress === null || typeof boundAddress === "string") {
        server.close(() => reject(new Error("web front end started without a TCP address")));
        return;
      }
      resolve(boundAddress);
    });
  });
  running = new RunningWebFrontEnd(server, options, address);
  return running;
}
