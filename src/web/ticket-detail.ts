import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StageName, TicketState } from "../events.js";
import { mapClaudeLine } from "../harness/claude.js";
import { mapCodexLine } from "../harness/codex.js";
import type { HarnessEvent } from "../harness/types.js";
import { parseTicketNote } from "../ticket-note.js";
import { resolveTicket } from "../tickets.js";
import { readIfExists } from "../util/fsx.js";

const RUN_DIRECTORY_RE = /^run-(\d+)$/;
const ROUND_DIRECTORY_RE = /^round-(\d+)$/;
const NUMBERED_SESSION_DIRECTORY_RE = /^(gate-fix|verdict-fix)-(\d+)$/;
const TAB_STAGE_ORDER: Record<TabStage, number> = {
  implementation: 0,
  "code-review": 1,
  qa: 2,
};

type TabStage = Exclude<StageName, "integration">;

interface TicketDetailComment {
  timestamp: string;
  label: string;
  body: string;
}

interface TicketDetailSession {
  key: string;
  label: string;
  content: string;
}

interface TicketDetail {
  title: string;
  description: string;
  comments: TicketDetailComment[];
  sessions: TicketDetailSession[];
}

interface SessionLog {
  filePath: string;
  relativePath: string;
  round: number;
  stage: TabStage;
}

interface SessionGroup {
  round: number;
  stage: TabStage;
  logs: SessionLog[];
}

interface ContinuationState {
  round: number;
  groups: ReadonlySet<string>;
  seenGroups: ReadonlySet<string>;
}

/** Read the ticket note and latest run logs without touching live pipeline state. */
export async function loadTicketDetail(
  ticket: TicketState,
  projectRoot: string,
  ticketsDirectory: string,
  stateDirectory: string,
): Promise<TicketDetail> {
  const resolvedTicket = await resolveTicket(
    ticket.title,
    path.join(projectRoot, ticketsDirectory),
  );
  const noteContent =
    resolvedTicket.notePath === null ? null : await readIfExists(resolvedTicket.notePath);
  const note = noteContent === null ? null : parseTicketNote(noteContent);
  return {
    title: note?.title || ticket.title,
    description: note?.description || resolvedTicket.description,
    comments:
      note?.comments.map((comment) => ({
        timestamp: comment.timestamp,
        label: comment.label ?? `${comment.stage} round ${comment.round}`,
        body: comment.body,
      })) ?? [],
    sessions:
      ticket.status === "ready" || ticket.status === "waiting"
        ? []
        : await readTicketSessions(stateDirectory, ticket.id),
  };
}

async function readTicketSessions(
  stateDirectory: string,
  ticketId: string,
): Promise<TicketDetailSession[]> {
  const ticketRunsDirectory = safeTicketRunsDirectory(stateDirectory, ticketId);
  const entries = await readDirectory(ticketRunsDirectory);
  const latestRun = entries
    .flatMap((entry) => {
      const match = RUN_DIRECTORY_RE.exec(entry);
      return match?.[1] === undefined ? [] : [{ name: entry, number: Number(match[1]) }];
    })
    .sort((first, second) => first.number - second.number)
    .at(-1);
  const sessions =
    latestRun === undefined
      ? []
      : await readRoundSessions(
          path.join(ticketRunsDirectory, latestRun.name),
          await continuedStageGroups(stateDirectory, ticketId),
        );
  return [
    ...sessions,
    ...(await readIntegrationSessions(path.join(ticketRunsDirectory, "integration"))),
  ];
}

function safeTicketRunsDirectory(stateDirectory: string, ticketId: string): string {
  const base = path.join(stateDirectory, "runs");
  const candidate = path.resolve(base, ticketId);
  if (path.dirname(candidate) !== path.resolve(base))
    throw new Error(`cannot read run logs for invalid ticket id "${ticketId}"`);
  return candidate;
}

async function readDirectory(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`could not read run log directory ${directory}: ${(error as Error).message}`);
  }
}

async function readRoundSessions(
  runDirectory: string,
  continuedGroups: ReadonlySet<string>,
): Promise<TicketDetailSession[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(runDirectory, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`could not read run directory ${runDirectory}: ${(error as Error).message}`);
  }
  const logs = entries.flatMap((relativePath) => {
    const parts = relativePath.split(path.sep);
    const roundMatch = ROUND_DIRECTORY_RE.exec(parts[0] ?? "");
    const stage = stageFromLogName(parts.at(-1) ?? "");
    if (roundMatch?.[1] === undefined || stage === null) return [];
    return [
      {
        filePath: path.join(runDirectory, relativePath),
        relativePath,
        round: Number(roundMatch[1]),
        stage,
      },
    ];
  });
  const groups = new Map<string, SessionGroup>();
  for (const log of logs) {
    const key = `${log.round}:${log.stage}`;
    const existing = groups.get(key);
    groups.set(
      key,
      existing ? { ...existing, logs: [...existing.logs, log] } : { ...log, logs: [log] },
    );
  }
  const rendered = await Promise.all(
    [...groups.entries()]
      .sort(([, first], [, second]) =>
        first.round === second.round
          ? TAB_STAGE_ORDER[first.stage] - TAB_STAGE_ORDER[second.stage]
          : first.round - second.round,
      )
      .map(([key, group]) => renderSessionGroup(key, group)),
  );
  const sessions: TicketDetailSession[] = [];
  for (const session of rendered) {
    const continuedStage = continuedGroups.has(session.key)
      ? session.key.slice(session.key.indexOf(":") + 1)
      : null;
    const previousIndex =
      continuedStage === null
        ? -1
        : sessions.findLastIndex((candidate) => candidate.key.endsWith(`:${continuedStage}`));
    if (previousIndex === -1) {
      sessions.push(session);
      continue;
    }
    const previous = sessions[previousIndex];
    if (previous === undefined) throw new Error("continued stage has no previous session tab");
    sessions[previousIndex] = {
      ...previous,
      content: [previous.content, session.content].filter((content) => content !== "").join("\n\n"),
    };
  }
  return sessions;
}

async function continuedStageGroups(
  stateDirectory: string,
  ticketId: string,
): Promise<ReadonlySet<string>> {
  const content = await readIfExists(path.join(stateDirectory, "events.jsonl"));
  if (content === null) return new Set();
  let state: ContinuationState = { round: 0, groups: new Set(), seenGroups: new Set() };
  for (const line of content.split("\n")) {
    const event = parsePersistedEvent(line);
    if (event !== null && event.ticketId === ticketId)
      state = updateContinuationState(state, event);
  }
  return state.groups;
}

function parsePersistedEvent(line: string): Record<string, unknown> | null {
  if (line === "") return null;
  try {
    const event: unknown = JSON.parse(line);
    return typeof event === "object" && event !== null ? (event as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function updateContinuationState(
  state: ContinuationState,
  event: Record<string, unknown>,
): ContinuationState {
  if (event.type === "dispatch") return { round: 0, groups: new Set(), seenGroups: new Set() };
  const data = eventData(event);
  if (event.type === "round_start" && typeof data.round === "number")
    return { ...state, round: data.round };
  const stage = typeof data.stage === "string" ? stageFromEvent(data.stage) : null;
  if (event.type !== "stage_start" || stage === null || state.round < 1) return state;
  const key = `${state.round}:${stage}`;
  const isFirstContinuation = !state.seenGroups.has(key) && data.isContinuation === true;
  return {
    ...state,
    groups: isFirstContinuation ? new Set([...state.groups, key]) : state.groups,
    seenGroups: new Set([...state.seenGroups, key]),
  };
}

function eventData(event: Record<string, unknown>): Record<string, unknown> {
  return typeof event.data === "object" && event.data !== null
    ? (event.data as Record<string, unknown>)
    : {};
}

function stageFromEvent(stage: string): TabStage | null {
  switch (stage) {
    case "implementation":
    case "code-review":
    case "qa":
      return stage;
    default:
      return null;
  }
}

function stageFromLogName(fileName: string): TabStage | null {
  switch (fileName) {
    case "implementation.log.jsonl":
      return "implementation";
    case "code-review.log.jsonl":
      return "code-review";
    case "qa.log.jsonl":
      return "qa";
    default:
      return null;
  }
}

async function renderSessionGroup(key: string, group: SessionGroup): Promise<TicketDetailSession> {
  const logs = [...group.logs].sort(compareSessionLogs);
  const sections = await Promise.all(
    logs.map(async (log) => {
      const content = renderHarnessLog(await fs.readFile(log.filePath, "utf8"));
      const heading = nestedLogHeading(log.relativePath);
      return heading === null ? content : `${heading}\n\n${content}`;
    }),
  );
  const stageLabel = stageName(group.stage);
  return {
    key,
    label: group.round === 1 ? stageLabel : `${stageLabel} round ${group.round}`,
    content: sections.filter((section) => section !== "").join("\n\n"),
  };
}

function compareSessionLogs(first: SessionLog, second: SessionLog): number {
  const firstOrder = nestedLogOrder(first.relativePath);
  const secondOrder = nestedLogOrder(second.relativePath);
  return firstOrder[0] - secondOrder[0] || firstOrder[1] - secondOrder[1];
}

function nestedLogOrder(relativePath: string): [number, number] {
  let gateFix = 0;
  let verdictFix = 0;
  for (const part of relativePath.split(path.sep)) {
    const match = NUMBERED_SESSION_DIRECTORY_RE.exec(part);
    if (match?.[1] === "gate-fix") gateFix = Number(match[2]);
    if (match?.[1] === "verdict-fix") verdictFix = Number(match[2]);
  }
  return [gateFix, verdictFix];
}

function nestedLogHeading(relativePath: string): string | null {
  const parts = relativePath.split(path.sep);
  const gateFix = parts.find((part) => part.startsWith("gate-fix-"));
  const verdictFix = parts.find((part) => part.startsWith("verdict-fix-"));
  if (gateFix !== undefined)
    return `— Gate fix ${gateFix.slice("gate-fix-".length)}${verdictFix === undefined ? "" : `, verdict correction ${verdictFix.slice("verdict-fix-".length)}`} —`;
  if (verdictFix !== undefined)
    return `— Verdict correction ${verdictFix.slice("verdict-fix-".length)} —`;
  return null;
}

async function readIntegrationSessions(
  integrationDirectory: string,
): Promise<TicketDetailSession[]> {
  const integrationLog = path.join(integrationDirectory, "integration.log.jsonl");
  const qaLog = path.join(integrationDirectory, "requalify", "qa.log.jsonl");
  const sessions: TicketDetailSession[] = [];
  for (const [filePath, key, label] of [
    [integrationLog, "integration", "Integration"],
    [qaLog, "integration:qa", "QA after Integration"],
  ] as const) {
    const content = await readIfExists(filePath);
    if (content !== null) sessions.push({ key, label, content: renderHarnessLog(content) });
  }
  return sessions;
}

function renderHarnessLog(content: string): string {
  const output: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line === "") continue;
    const events = [...mapClaudeLine(line), ...mapCodexLine(line)];
    if (events.length > 0) {
      for (const event of events) appendHarnessEvent(output, event);
      continue;
    }
    try {
      JSON.parse(line);
    } catch {
      output.push(line);
    }
  }
  return output.join("\n\n");
}

function appendHarnessEvent(output: string[], event: HarnessEvent): void {
  if (event.type === "tool") {
    output.push(`› ${event.name}${event.detail === undefined ? "" : ` ${event.detail}`}`);
    return;
  }
  if (event.type === "text") {
    if (event.text !== "") output.push(event.text);
    return;
  }
  if (event.text !== "" && !output.includes(event.text)) output.push(event.text);
}

function stageName(stage: TabStage): string {
  switch (stage) {
    case "implementation":
      return "Implementation";
    case "code-review":
      return "Code Review";
    case "qa":
      return "QA";
  }
}
