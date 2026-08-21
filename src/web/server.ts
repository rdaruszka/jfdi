import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import {
  ConfigError,
  FRONT_ENDS,
  HARNESS_NAMES,
  INTEGRATION_MODES,
  type JfdiConfig,
  PERMISSION_MODES,
  SESSION_KINDS,
} from "../config.js";
import type { EventLog, TicketState } from "../events.js";
import { EFFORT_LEVELS_BY_HARNESS } from "../harness/index.js";
import { initialLiveView, type LiveView, reduceLiveView } from "../renderers/live-view.js";
import { type SettingsSnapshot, SettingsStaleError } from "../settings.js";
import { loadTicketDetail } from "./ticket-detail.js";

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
  frontEndInEffect(): JfdiConfig["frontEnd"];
  load(): Promise<SettingsSnapshot>;
  save(staged: unknown, revision: string): Promise<SettingsSnapshot>;
}

export interface WebFrontEndOptions {
  log: EventLog;
  projectRoot: string;
  ticketsDirectory: string;
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

const SETTINGS_CHOICES = JSON.stringify({
  integrationModes: INTEGRATION_MODES,
  permissionModes: PERMISSION_MODES,
  frontEnds: FRONT_ENDS,
  harnessNames: HARNESS_NAMES,
  sessionKinds: SESSION_KINDS,
  effortLevelsByHarness: EFFORT_LEVELS_BY_HARNESS,
});

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
    .settings-card { width: min(920px, 100%); max-height: calc(100vh - 2rem); overflow: auto; padding: 1.2rem; border: 1px solid #3a4657; background: #10141a; box-shadow: 0 1.5rem 5rem #000; }
    .settings-card h2 { color: #edf1f7; font-size: 1rem; }
    .settings-card p { color: #aab5c5; font-size: .85rem; line-height: 1.5; }
    .settings-card fieldset { margin: 1rem 0; padding: .8rem; border: 1px solid #29313d; }
    .settings-card legend { padding: 0 .35rem; color: #78dce8; font-size: .82rem; }
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .8rem; }
    .settings-field { display: grid; align-content: start; gap: .35rem; color: #cbd3df; font-size: .82rem; }
    .settings-field input:not([type="checkbox"]), .settings-field select { width: 100%; min-width: 0; border: 1px solid #343e4d; border-radius: .2rem; background: #090c10; color: #edf1f7; font: inherit; padding: .5rem; }
    .settings-field input[aria-invalid="true"], .settings-field select[aria-invalid="true"] { border-color: #ff6b6b; outline: 1px solid #ff6b6b; }
    .boolean-field { display: flex; align-items: center; gap: .55rem; min-height: 2.4rem; }
    .boolean-field input { width: 1.1rem; height: 1.1rem; accent-color: #63d392; }
    .settings-list { display: grid; gap: .65rem; }
    .settings-list-row { display: grid; grid-template-columns: minmax(10rem, .7fr) minmax(16rem, 1.5fr) auto; gap: .65rem; align-items: end; padding: .65rem; border: 1px solid #29313d; }
    .settings-stage { padding: .65rem; border: 1px solid #29313d; }
    .settings-stage h3 { margin: 0 0 .65rem; color: #cbd3df; font-size: .82rem; }
    .remove-button { border-color: #70434a; background: #321d21; }
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
    .card { width: 100%; min-height: 3.6rem; padding: .75rem; border: 1px solid #343e4d; border-radius: .2rem; background: #171d26; text-align: left; line-height: 1.4; overflow-wrap: anywhere; box-shadow: 0 .2rem .7rem rgba(0, 0, 0, .22); }
    .detail-toolbar { display: flex; align-items: center; gap: .8rem; margin-bottom: .8rem; }
    .detail-toolbar h1 { margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
    .detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: .8rem; height: calc(100vh - 8rem); min-height: 28rem; }
    .ticket-pane, .feed-pane { min-width: 0; min-height: 0; border: 1px solid #29313d; background: rgba(14, 18, 24, .9); }
    .ticket-pane { overflow-y: auto; padding: 1rem; }
    .ticket-description, .comment-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.55; }
    .comment-trail { display: grid; gap: .7rem; margin-top: 1.5rem; }
    .comment { padding: .8rem; border-left: .2rem solid #536176; background: #111720; }
    .comment-heading { margin: 0 0 .55rem; color: #78dce8; font-size: .78rem; line-height: 1.4; }
    .feed-pane { display: flex; flex-direction: column; }
    .session-tabs { display: flex; flex-wrap: wrap; gap: .35rem; min-height: 3.2rem; padding: .6rem; border-bottom: 1px solid #29313d; }
    .session-tab[aria-selected="true"] { border-color: #78dce8; background: #233040; }
    .feed-output { flex: 1; min-height: 0; margin: 0; overflow: auto; padding: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.45; }
    [hidden] { display: none !important; }
    @media (max-width: 760px) { header { flex-wrap: wrap; } .live { margin-left: 0; } .settings-button { margin-left: auto; } .settings-list-row { grid-template-columns: 1fr; } .detail { grid-template-columns: 1fr; height: auto; } .ticket-pane, .feed-pane { height: 60vh; } }
  </style>
</head>
<body>
  <main>
    <header><span class="brand">JFDI</span><span class="route"><span id="board"></span> → <strong id="branch"></strong></span><span class="live">LIVE STATUS</span><button class="settings-button" id="settings-open" type="button">Settings</button></header>
    <aside id="pause"></aside>
    <section id="board-view"><div class="kanban" id="kanban" aria-label="Ticket states"></div></section>
    <section id="ticket-detail" hidden>
      <div class="detail-toolbar"><button id="board-return" type="button">← Board</button><h1 id="ticket-title"></h1></div>
      <div class="detail">
        <article class="ticket-pane" aria-label="Ticket content">
          <h2>Description and acceptance criteria</h2>
          <pre class="ticket-description" id="ticket-description"></pre>
          <section class="comment-trail" id="comment-trail" aria-label="Comment trail"></section>
        </article>
        <section class="feed-pane" aria-label="Agent feed">
          <div class="session-tabs" id="session-tabs" role="tablist" aria-label="Agent sessions"></div>
          <pre class="feed-output" id="feed-output" tabindex="0"></pre>
        </section>
      </div>
    </section>
  </main>
  <aside class="settings-panel" id="settings-panel" hidden>
    <div class="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <h2 id="settings-title">Instance settings</h2>
      <p>Edit each value in <code>.jfdi/config.json</code>. Changes are staged here until Save. The <code>frontEnd</code> value is saved but switching front ends requires a restart.</p>
      <form id="settings-form">
        <fieldset>
          <legend>Board and tickets</legend>
          <div class="settings-grid">
            <label class="settings-field">Board path<input data-config-path="board.path" type="text" required></label>
            <label class="settings-field">Tickets directory<input data-config-path="ticketsDirectory" type="text" required></label>
            <label class="settings-field">Begin column<input data-config-path="board.columns.begin" type="text" required></label>
            <label class="settings-field">In progress column<input data-config-path="board.columns.inProgress" type="text" required></label>
            <label class="settings-field">Done column<input data-config-path="board.columns.done" type="text" required></label>
            <label class="settings-field">Blocked column<input data-config-path="board.columns.blocked" type="text" required></label>
            <label class="settings-field">Ready to merge column<input data-config-path="board.columns.readyToMerge" type="text" required></label>
            <label class="settings-field">Inbox column<input data-config-path="board.columns.inbox" type="text" required></label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Pipeline and integration</legend>
          <div class="settings-grid">
            <label class="settings-field">Code Review rejection budget<input data-config-path="pipeline.maxRejections.code-review" type="number" min="0" step="1" required></label>
            <label class="settings-field">QA rejection budget<input data-config-path="pipeline.maxRejections.qa" type="number" min="0" step="1" required></label>
            <label class="settings-field">Maximum concurrent runs<input data-config-path="maxConcurrent" type="number" min="1" step="1" required></label>
            <label class="settings-field">Target branch<input data-config-path="integration.targetBranch" type="text" required></label>
            <label class="settings-field">Integration mode<select data-config-path="integration.mode"></select></label>
            <label class="settings-field">Permission mode<select data-config-path="permissions.mode"></select></label>
            <label class="settings-field">Front end<select data-config-path="frontEnd"></select></label>
            <label class="settings-field boolean-field"><input data-config-path="integration.remote.fetchBefore" type="checkbox"><span>Fetch before integration</span></label>
            <label class="settings-field boolean-field"><input data-config-path="integration.remote.pushAfter" type="checkbox"><span>Push after integration</span></label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Gate commands</legend>
          <div class="settings-list" id="settings-gate"></div>
          <button id="settings-gate-add" type="button">Add gate command</button>
        </fieldset>
        <fieldset>
          <legend>Stages and scribe</legend>
          <div class="settings-list" id="settings-stages"></div>
        </fieldset>
        <div class="settings-actions">
          <button id="settings-save" type="submit">Save</button>
          <button id="settings-cancel" type="button">Cancel</button>
          <button id="settings-reload" type="button">Reload</button>
        </div>
        <p id="settings-message" role="status"></p>
      </form>
    </div>
  </aside>
  <script>
    const DETAIL_REFRESH_MS = 1000;
    const BOTTOM_TOLERANCE_PX = 8;
    const element = (id) => document.getElementById(id);
    const text = (tag, className, value) => { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; };
    let selectedTicketId = null;
    let selectedSessionKey = null;
    let sessionKeys = [];
    let detailSessions = [];
    let detailRequest = 0;
    function renderColumns(columns) {
      const board = element("kanban"); board.replaceChildren();
      for (const column of columns) {
        const section = document.createElement("section"); section.className = "column";
        const heading = document.createElement("h2"); heading.append(text("span", "", column.name), text("span", "count", String(column.cards.length)));
        const cards = document.createElement("div"); cards.className = "cards";
        for (const card of column.cards) {
          const button = text("button", "card", card.title); button.type = "button";
          button.addEventListener("click", () => { location.hash = "ticket/" + encodeURIComponent(card.id); });
          cards.append(button);
        }
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
      if (selectedTicketId !== null) refreshTicketDetail();
    }
    function ticketIdFromHash() {
      const prefix = "#ticket/";
      if (!location.hash.startsWith(prefix)) return null;
      try { return decodeURIComponent(location.hash.slice(prefix.length)); } catch { return null; }
    }
    function renderRoute() {
      selectedTicketId = ticketIdFromHash();
      element("board-view").hidden = selectedTicketId !== null;
      element("ticket-detail").hidden = selectedTicketId === null;
      element("settings-open").hidden = selectedTicketId !== null;
      if (selectedTicketId === null) {
        detailRequest += 1; selectedSessionKey = null; sessionKeys = []; detailSessions = [];
        return;
      }
      element("ticket-title").textContent = selectedTicketId;
      refreshTicketDetail();
    }
    function isFeedAtBottom(feed) {
      return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= BOTTOM_TOLERANCE_PX;
    }
    function showSelectedSession(shouldScrollToBottom = false) {
      const feed = element("feed-output");
      const previousScrollTop = feed.scrollTop;
      const shouldFollow = shouldScrollToBottom || isFeedAtBottom(feed);
      const selected = detailSessions.find((session) => session.key === selectedSessionKey);
      const content = selected?.content || "";
      if (feed.textContent !== content) {
        feed.textContent = content;
        feed.scrollTop = shouldFollow ? feed.scrollHeight : previousScrollTop;
      }
    }
    function renderSessionTabs(sessions) {
      const tabs = element("session-tabs"); tabs.replaceChildren();
      for (const session of sessions) {
        const tab = text("button", "session-tab", session.label); tab.type = "button"; tab.role = "tab";
        tab.setAttribute("aria-selected", String(session.key === selectedSessionKey));
        tab.addEventListener("click", () => {
          selectedSessionKey = session.key; renderSessionTabs(detailSessions); showSelectedSession(true);
        });
        tabs.append(tab);
      }
    }
    function renderTicketDetail(detail) {
      element("ticket-title").textContent = detail.title;
      element("ticket-description").textContent = detail.description;
      const comments = element("comment-trail"); comments.replaceChildren();
      if (detail.comments.length > 0) comments.append(text("h2", "", "Comment trail"));
      for (const comment of detail.comments) {
        const article = document.createElement("article"); article.className = "comment";
        article.append(text("h3", "comment-heading", comment.label + " · " + comment.timestamp), text("pre", "comment-body", comment.body));
        comments.append(article);
      }
      const priorLatest = sessionKeys.at(-1);
      const wasLatest = selectedSessionKey === null || selectedSessionKey === priorLatest;
      const wasFollowingLatest = wasLatest && isFeedAtBottom(element("feed-output"));
      const nextKeys = detail.sessions.map((session) => session.key);
      const nextLatest = nextKeys.at(-1) || null;
      if (!nextKeys.includes(selectedSessionKey) || (wasFollowingLatest && nextLatest !== priorLatest)) selectedSessionKey = nextLatest;
      const didSwitch = !sessionKeys.includes(selectedSessionKey);
      sessionKeys = nextKeys; detailSessions = detail.sessions;
      renderSessionTabs(detailSessions); showSelectedSession(didSwitch);
    }
    async function refreshTicketDetail() {
      const ticketId = selectedTicketId;
      if (ticketId === null) return;
      const request = ++detailRequest;
      try {
        const response = await fetch("ticket-detail?ticketId=" + encodeURIComponent(ticketId));
        const body = await response.json();
        if (request !== detailRequest || ticketId !== selectedTicketId) return;
        if (!response.ok) throw new Error(body.error || "Could not read ticket");
        renderTicketDetail(body);
      } catch (error) {
        if (request === detailRequest && ticketId === selectedTicketId) element("feed-output").textContent = error.message;
      }
    }
    const settingsChoices = ${SETTINGS_CHOICES};
    let settingsRevision = "";
    let settingsBaseConfig = null;
    const settingsControls = () => Array.from(document.querySelectorAll("[data-config-path]"));
    const settingsField = (path) => settingsControls().find((control) => control.dataset.configPath === path);
    function option(value, label = value) {
      const choice = document.createElement("option"); choice.value = value; choice.textContent = label; return choice;
    }
    function setSelectOptions(control, values, emptyLabel) {
      const selected = control.value; control.replaceChildren();
      if (emptyLabel !== undefined) control.append(option("", emptyLabel));
      for (const value of values) control.append(option(value));
      control.value = selected;
    }
    function labeledField(labelText, control) {
      const label = document.createElement("label"); label.className = "settings-field"; label.append(labelText, control); return label;
    }
    function settingsInput(path, value, type = "text") {
      const control = document.createElement("input"); control.type = type; control.value = value; control.required = true; control.dataset.configPath = path; return control;
    }
    function clearFieldErrors() {
      for (const control of settingsControls()) { control.setCustomValidity(""); control.removeAttribute("aria-invalid"); }
    }
    function pointAtSettingsField(path, message) {
      const controls = settingsControls();
      const control = controls.find((candidate) => candidate.dataset.configPath === path)
        || controls.find((candidate) => candidate.dataset.configPath.startsWith(path + ".") || candidate.dataset.configPath.startsWith(path + "["));
      if (control === undefined) return;
      control.setCustomValidity(message); control.setAttribute("aria-invalid", "true"); control.focus(); control.reportValidity();
    }
    function settingsMessage(message, isSuccess = false) {
      const output = element("settings-message"); output.textContent = message; output.className = isSuccess ? "success" : "";
    }
    function updateGatePaths() {
      const rows = Array.from(element("settings-gate").children);
      rows.forEach((row, index) => {
        row.querySelector('[data-gate-part="name"]').dataset.configPath = "gate[" + index + "].name";
        row.querySelector('[data-gate-part="command"]').dataset.configPath = "gate[" + index + "].command";
      });
    }
    function addGateRow(entry = {}, sourceIndex = "", shouldFocus = false) {
      const row = document.createElement("div"); row.className = "settings-list-row"; row.dataset.sourceIndex = sourceIndex;
      const name = settingsInput("", entry.name || ""); name.dataset.gatePart = "name";
      const command = settingsInput("", entry.command || ""); command.dataset.gatePart = "command";
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-button"; remove.textContent = "Remove";
      remove.addEventListener("click", () => { row.remove(); updateGatePaths(); });
      row.append(labeledField("Name", name), labeledField("Command", command), remove);
      element("settings-gate").append(row); updateGatePaths(); if (shouldFocus) name.focus();
    }
    function renderGate(entries) {
      element("settings-gate").replaceChildren();
      entries.forEach((entry, index) => addGateRow(entry, String(index)));
    }
    function renderStages(stages) {
      const output = element("settings-stages"); output.replaceChildren();
      for (const sessionKind of settingsChoices.sessionKinds) {
        const entry = stages[sessionKind];
        const section = document.createElement("section"); section.className = "settings-stage";
        const heading = document.createElement("h3"); heading.textContent = sessionKind;
        const fields = document.createElement("div"); fields.className = "settings-grid";
        const harness = document.createElement("select"); harness.dataset.configPath = "stages." + sessionKind + ".harness";
        setSelectOptions(harness, settingsChoices.harnessNames); harness.value = entry.harness;
        const model = settingsInput("stages." + sessionKind + ".model", entry.model || ""); model.required = false;
        const effort = document.createElement("select"); effort.dataset.configPath = "stages." + sessionKind + ".effort";
        const renderEffort = () => { setSelectOptions(effort, settingsChoices.effortLevelsByHarness[harness.value], "Provider default"); };
        renderEffort(); effort.value = entry.effort || "";
        harness.addEventListener("change", () => { const previous = effort.value; renderEffort(); effort.value = settingsChoices.effortLevelsByHarness[harness.value].includes(previous) ? previous : ""; });
        fields.append(labeledField("Harness", harness), labeledField("Model", model), labeledField("Effort", effort));
        section.append(heading, fields); output.append(section);
      }
    }
    function setSettingsValue(path, value) {
      const control = settingsField(path);
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
    }
    function renderSettings(config) {
      settingsBaseConfig = structuredClone(config); clearFieldErrors();
      setSettingsValue("board.path", config.board.path);
      setSettingsValue("ticketsDirectory", config.ticketsDirectory);
      for (const name of ["begin", "inProgress", "done", "blocked", "readyToMerge", "inbox"])
        setSettingsValue("board.columns." + name, config.board.columns[name]);
      setSettingsValue("pipeline.maxRejections.code-review", config.pipeline.maxRejections["code-review"]);
      setSettingsValue("pipeline.maxRejections.qa", config.pipeline.maxRejections.qa);
      setSettingsValue("maxConcurrent", config.maxConcurrent);
      setSettingsValue("integration.targetBranch", config.integration.targetBranch);
      setSettingsValue("integration.mode", config.integration.mode);
      setSettingsValue("permissions.mode", config.permissions.mode);
      setSettingsValue("frontEnd", config.frontEnd);
      setSettingsValue("integration.remote.fetchBefore", config.integration.remote.fetchBefore);
      setSettingsValue("integration.remote.pushAfter", config.integration.remote.pushAfter);
      renderGate(config.gate); renderStages(config.stages);
    }
    function collectSettings() {
      const config = structuredClone(settingsBaseConfig);
      config.board.path = settingsField("board.path").value;
      config.ticketsDirectory = settingsField("ticketsDirectory").value;
      for (const name of ["begin", "inProgress", "done", "blocked", "readyToMerge", "inbox"])
        config.board.columns[name] = settingsField("board.columns." + name).value;
      config.pipeline.maxRejections["code-review"] = settingsField("pipeline.maxRejections.code-review").valueAsNumber;
      config.pipeline.maxRejections.qa = settingsField("pipeline.maxRejections.qa").valueAsNumber;
      config.maxConcurrent = settingsField("maxConcurrent").valueAsNumber;
      config.integration.targetBranch = settingsField("integration.targetBranch").value;
      config.integration.mode = settingsField("integration.mode").value;
      config.permissions.mode = settingsField("permissions.mode").value;
      config.frontEnd = settingsField("frontEnd").value;
      config.integration.remote.fetchBefore = settingsField("integration.remote.fetchBefore").checked;
      config.integration.remote.pushAfter = settingsField("integration.remote.pushAfter").checked;
      config.gate = Array.from(element("settings-gate").children).map((row) => {
        const sourceIndex = Number(row.dataset.sourceIndex);
        const source = row.dataset.sourceIndex !== "" && Number.isInteger(sourceIndex) && settingsBaseConfig.gate[sourceIndex] !== undefined ? settingsBaseConfig.gate[sourceIndex] : {};
        return { ...source, name: row.querySelector('[data-gate-part="name"]').value, command: row.querySelector('[data-gate-part="command"]').value };
      });
      for (const sessionKind of settingsChoices.sessionKinds) {
        const entry = config.stages[sessionKind];
        entry.harness = settingsField("stages." + sessionKind + ".harness").value;
        const model = settingsField("stages." + sessionKind + ".model").value;
        const effort = settingsField("stages." + sessionKind + ".effort").value;
        if (model === "") delete entry.model; else entry.model = model;
        if (effort === "") delete entry.effort; else entry.effort = effort;
      }
      return config;
    }
    async function loadSettings() {
      settingsRevision = ""; settingsBaseConfig = null; element("settings-gate").replaceChildren(); element("settings-stages").replaceChildren();
      settingsMessage("Loading…");
      try {
        const response = await fetch("settings");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load settings");
        settingsRevision = body.revision;
        renderSettings(body.editableConfig);
        settingsMessage("Loaded from disk.", true);
      } catch (error) { settingsMessage(error.message); }
    }
    async function openSettings() {
      element("settings-panel").hidden = false;
      await loadSettings();
      settingsField("board.path")?.focus();
    }
    function cancelSettings() {
      settingsRevision = ""; settingsBaseConfig = null; element("settings-gate").replaceChildren(); element("settings-stages").replaceChildren(); settingsMessage(""); element("settings-panel").hidden = true;
    }
    async function saveSettings(event) {
      event.preventDefault(); clearFieldErrors();
      if (!element("settings-form").reportValidity()) return;
      const config = collectSettings();
      settingsMessage("Saving…");
      try {
        const response = await fetch("settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, revision: settingsRevision }) });
        const body = await response.json();
        if (!response.ok) { if (body.field) pointAtSettingsField(body.field, body.error); throw new Error(body.error || "Could not save settings"); }
        settingsRevision = body.revision;
        renderSettings(body.editableConfig);
        settingsMessage(body.hasPendingFrontEndChange ? "Saved and applied. The new front end takes effect only after restarting jfdi start." : "Saved and applied.", true);
      } catch (error) { settingsMessage(error.message); }
    }
    setSelectOptions(settingsField("integration.mode"), settingsChoices.integrationModes);
    setSelectOptions(settingsField("permissions.mode"), settingsChoices.permissionModes);
    setSelectOptions(settingsField("frontEnd"), settingsChoices.frontEnds);
    element("settings-open").addEventListener("click", openSettings);
    element("settings-cancel").addEventListener("click", cancelSettings);
    element("settings-reload").addEventListener("click", loadSettings);
    element("settings-gate-add").addEventListener("click", () => addGateRow({}, "", true));
    element("settings-form").addEventListener("submit", saveSettings);
    element("settings-form").addEventListener("input", (event) => { event.target.setCustomValidity(""); event.target.removeAttribute("aria-invalid"); });
    element("board-return").addEventListener("click", () => { location.hash = ""; });
    window.addEventListener("hashchange", renderRoute);
    renderRoute();
    setInterval(() => { if (selectedTicketId !== null) refreshTicketDetail(); }, DETAIL_REFRESH_MS);
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

function configErrorField(message: string): string | undefined {
  return /^(board(?:\.columns\.[A-Za-z]+|\.path)?|ticketsDirectory|gate(?:\[\d+\])?(?:\.[A-Za-z]+)?|pipeline(?:\.[A-Za-z-]+)*|integration(?:\.[A-Za-z]+)*|permissions(?:\.[A-Za-z]+)?|frontEnd|maxConcurrent|stages(?:\.[A-Za-z-]+)*)/.exec(
    message,
  )?.[1];
}

class RunningWebFrontEnd implements WebFrontEnd {
  readonly url: string;
  private readonly clients = new Set<ServerResponse>();
  private view: LiveView;
  private readonly unsubscribe: () => void;
  private closePromise: Promise<void> | null = null;
  private readonly exitPromise: Promise<void>;
  private integrationMode: JfdiConfig["integration"]["mode"];
  private ticketsDirectory: string;

  constructor(
    private readonly server: Server,
    private readonly options: WebFrontEndOptions,
    address: AddressInfo,
  ) {
    this.url = `http://${LOOPBACK_HOST}:${address.port}/`;
    this.integrationMode = options.integrationMode;
    this.ticketsDirectory = options.ticketsDirectory;
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
    if (requestPath === "/ticket-detail") {
      await this.handleTicketDetail(request, response);
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
        const frontEndBeforeSave = this.options.settings.frontEndInEffect();
        const snapshot = await this.options.settings.save(staged, revision);
        this.integrationMode = snapshot.config.integration.mode;
        this.ticketsDirectory = snapshot.config.ticketsDirectory;
        jsonResponse(response, HTTP_OK, {
          ...snapshot,
          hasPendingFrontEndChange: snapshot.config.frontEnd !== frontEndBeforeSave,
        });
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
        jsonResponse(response, HTTP_BAD_REQUEST, {
          error: error.message,
          field: configErrorField(error.message),
        });
        return;
      }
      jsonResponse(response, HTTP_INTERNAL_SERVER_ERROR, {
        error: `could not access config settings: ${(error as Error).message}`,
      });
    }
  }

  private async handleTicketDetail(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const ticketId = new URL(request.url ?? "/", "http://localhost").searchParams.get("ticketId");
    if (ticketId === null || ticketId === "") {
      jsonResponse(response, HTTP_BAD_REQUEST, { error: "ticketId is required" });
      return;
    }
    const ticket = this.view.state.tickets[ticketId];
    if (ticket === undefined) {
      jsonResponse(response, HTTP_NOT_FOUND, { error: `ticket "${ticketId}" is not on the board` });
      return;
    }
    try {
      jsonResponse(
        response,
        HTTP_OK,
        await loadTicketDetail(
          ticket,
          this.options.projectRoot,
          this.ticketsDirectory,
          path.dirname(this.options.log.eventsPath),
        ),
        request.method === "HEAD",
      );
    } catch (error) {
      jsonResponse(response, HTTP_INTERNAL_SERVER_ERROR, {
        error: `could not read ticket "${ticketId}": ${(error as Error).message}`,
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
