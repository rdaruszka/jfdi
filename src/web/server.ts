import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventLog, TicketState } from "../events.js";
import {
  initialLiveView,
  type LiveView,
  reduceLiveView,
  ticketGroups,
} from "../renderers/live-view.js";
import { formatRunningTotals } from "../usage.js";

const LOOPBACK_HOST = "127.0.0.1";
const ASSIGNED_PORT = 0;
const MAX_WEB_CLIENTS = 32;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface WebFrontEndOptions {
  log: EventLog;
  boardName: string;
  targetBranch: string;
}

export interface WebFrontEnd {
  url: string;
  close(): Promise<void>;
  waitUntilExit(): Promise<void>;
}

interface WebTicket extends TicketState {
  runningTotals: string;
}

function webTicket(ticket: TicketState): WebTicket {
  return {
    ...ticket,
    runningTotals:
      ticket.totalAgentMs > 0
        ? formatRunningTotals(ticket.totalCostUsd, ticket.totalAgentMs, ticket.totalTokens)
        : "",
  };
}

function payload(options: WebFrontEndOptions, view: LiveView): string {
  const groups = ticketGroups(view.state);
  return JSON.stringify({
    boardName: options.boardName,
    targetBranch: options.targetBranch,
    view,
    groups: {
      active: groups.active.map(webTicket),
      waiting: groups.waiting.map(webTicket),
      settled: groups.settled.map(webTicket),
    },
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
    main { width: min(1100px, calc(100% - 2rem)); margin: 0 auto; padding: 2rem 0 4rem; }
    header { display: flex; align-items: baseline; gap: .8rem; margin-bottom: 1.5rem; }
    .brand { background: #edf1f7; color: #0b0d10; font-weight: 900; padding: .25rem .55rem; letter-spacing: .08em; }
    .route { color: #aab5c5; }
    .route strong { color: #edf1f7; }
    .live { margin-left: auto; color: #63d392; font-size: .8rem; }
    .live::before { content: ""; display: inline-block; width: .55rem; height: .55rem; margin-right: .45rem; border-radius: 50%; background: currentColor; box-shadow: 0 0 1rem currentColor; }
    #pause { display: none; margin-bottom: 1.25rem; padding: .8rem 1rem; border: 1px solid #e5b567; background: #2b2418; color: #ffd58c; }
    section { margin: 0 0 1.35rem; }
    h2 { margin: 0 0 .55rem; color: #aab5c5; font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; }
    .ticket { display: grid; grid-template-columns: minmax(12rem, 1.2fr) minmax(12rem, 1fr) minmax(10rem, 2fr) auto; gap: .8rem; align-items: baseline; padding: .7rem .8rem; border-top: 1px solid #252b34; background: rgba(18, 22, 28, .78); }
    .ticket:last-child { border-bottom: 1px solid #252b34; }
    .ticket-id { font-weight: 700; overflow-wrap: anywhere; }
    .status { color: #78dce8; }
    .status.blocked, .status.failed { color: #ff6188; }
    .status.done, .status.merge-ready { color: #63d392; }
    .status.merge-queued, .status.waiting { color: #e5b567; }
    .status.merging { color: #ab9df2; }
    .activity, .totals, .empty, .event { color: #8893a3; }
    .totals { white-space: nowrap; font-size: .82rem; }
    .queue { padding: .7rem .8rem; border: 1px solid #3b3349; color: #c6b7ef; }
    .event { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .7rem; padding: .22rem 0; font-size: .86rem; }
    .event span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [hidden] { display: none !important; }
    @media (max-width: 760px) { .ticket { grid-template-columns: 1fr; gap: .25rem; } .totals { white-space: normal; } header { flex-wrap: wrap; } .live { margin-left: 0; width: 100%; } }
  </style>
</head>
<body>
  <main>
    <header><span class="brand">JFDI</span><span class="route"><span id="board"></span> → <strong id="branch"></strong></span><span class="live">LIVE · READ ONLY</span></header>
    <aside id="pause"></aside>
    <section><h2 id="active-title">Active (0)</h2><div id="active"><div class="empty">waiting for cards in the begin column…</div></div></section>
    <section id="waiting-section" hidden><h2>Needs attention / queued</h2><div id="waiting"></div></section>
    <section id="queue-section" hidden><h2>Integration queue</h2><div class="queue" id="queue"></div></section>
    <section id="settled-section" hidden><h2>Settled</h2><div id="settled"></div></section>
    <section><h2>Events</h2><div id="events"><div class="empty">No recent events.</div></div></section>
  </main>
  <script>
    const element = (id) => document.getElementById(id);
    const text = (tag, className, value) => { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; };
    function ticketRow(ticket) {
      const row = document.createElement("div"); row.className = "ticket";
      const progress = ticket.status + (ticket.stage ? " " + ticket.stage : "") + (ticket.round > 0 ? " r" + ticket.round : "");
      row.append(text("span", "ticket-id", ticket.id), text("span", "status " + ticket.status, progress), text("span", "activity", ticket.lastActivity), text("span", "totals", ticket.runningTotals));
      return row;
    }
    function ticketList(id, tickets, emptyText) {
      const container = element(id); container.replaceChildren();
      if (tickets.length === 0 && emptyText) container.append(text("div", "empty", emptyText));
      for (const ticket of tickets) container.append(ticketRow(ticket));
    }
    function eventText(event) {
      return (event.ticketId ? "[" + event.ticketId + "] " : "") + event.type + (event.data?.stage ? " " + event.data.stage : "") + (event.data?.verdict ? " → " + event.data.verdict : "") + (event.data?.reason ? ": " + event.data.reason : "");
    }
    function renderEvents(recent) {
      const container = element("events"); container.replaceChildren();
      if (recent.length === 0) container.append(text("div", "empty", "No recent events."));
      for (const entry of recent) { const row = document.createElement("div"); row.className = "event"; row.append(text("span", "", entry.event.ts.slice(11, 19)), text("span", "", eventText(entry.event))); container.append(row); }
    }
    function pauseText(pause) {
      if (pause.resumesAt === null) return "Harness needs attention: " + pause.detail;
      const what = pause.kind === "usage-limit" ? "Usage limit" : "Harness " + pause.kind;
      return what + " — resumes " + new Date(pause.resumesAt).toLocaleTimeString();
    }
    function render(payload) {
      element("board").textContent = payload.boardName; element("branch").textContent = payload.targetBranch;
      element("active-title").textContent = "Active (" + payload.groups.active.length + ")";
      ticketList("active", payload.groups.active, "waiting for cards in the begin column…");
      ticketList("waiting", payload.groups.waiting, ""); element("waiting-section").hidden = payload.groups.waiting.length === 0;
      ticketList("settled", payload.groups.settled, ""); element("settled-section").hidden = payload.groups.settled.length === 0;
      element("queue").textContent = payload.view.state.integrationQueue.join(" → "); element("queue-section").hidden = payload.view.state.integrationQueue.length === 0;
      const pause = element("pause"); pause.style.display = payload.view.pause === null ? "none" : "block"; pause.textContent = payload.view.pause === null ? "" : pauseText(payload.view.pause);
      renderEvents(payload.view.recent);
    }
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

class RunningWebFrontEnd implements WebFrontEnd {
  readonly url: string;
  private readonly clients = new Set<ServerResponse>();
  private view: LiveView;
  private readonly unsubscribe: () => void;
  private closePromise: Promise<void> | null = null;
  private readonly exitPromise: Promise<void>;

  constructor(
    private readonly server: Server,
    private readonly options: WebFrontEndOptions,
    address: AddressInfo,
  ) {
    this.url = `http://${LOOPBACK_HOST}:${address.port}/`;
    this.view = initialLiveView(options.log.snapshot());
    this.unsubscribe = options.log.on((event, state) => {
      this.view = reduceLiveView(this.view, event, state);
      this.broadcast();
    });
    this.exitPromise = new Promise((resolve) => server.once("close", resolve));
  }

  handle(requestMethod: string | undefined, requestPath: string, response: ServerResponse): void {
    commonHeaders(response);
    if (requestMethod !== "GET" && requestMethod !== "HEAD") {
      response.writeHead(HTTP_METHOD_NOT_ALLOWED, { allow: "GET, HEAD" });
      response.end("Method not allowed\n");
      return;
    }
    if (requestPath === "/") {
      response.writeHead(HTTP_OK, { "Content-Type": "text/html; charset=utf-8" });
      response.end(requestMethod === "HEAD" ? undefined : PAGE);
      return;
    }
    if (requestPath === "/events") {
      this.openEventStream(requestMethod, response);
      return;
    }
    response.writeHead(HTTP_NOT_FOUND, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
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
    if (!response.write(`data: ${payload(this.options, this.view)}\n\n`)) response.end();
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
    running.handle(request.method, requestPath, response);
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
