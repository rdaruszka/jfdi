import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { EventLog, TicketState } from "../events.js";
import {
  initialLiveView,
  type PauseBanner,
  reduceLiveView,
  ticketGroups,
} from "../renderers/live-view.js";
import { formatRunningTotals } from "../usage.js";

/** Offsets of `HH:MM:SS` within an ISO-8601 timestamp. */
const ISO_TIME_START = 11;
const ISO_TIME_END = 19;

const STATUS_COLOR: Record<TicketState["status"], string> = {
  running: "cyan",
  waiting: "gray",
  blocked: "red",
  "merge-queued": "yellow",
  merging: "magenta",
  "merge-ready": "green",
  done: "green",
  failed: "red",
};

function TicketRow({ ticket }: { ticket: TicketState }) {
  const stage = ticket.stage ? ` ${ticket.stage}` : "";
  const round = ticket.round > 0 ? ` r${ticket.round}` : "";
  const cost =
    ticket.totalAgentMs > 0
      ? formatRunningTotals(ticket.totalCostUsd, ticket.totalAgentMs, ticket.totalTokens)
      : "";
  return (
    <Box>
      <Box width={30}>
        <Text bold wrap="truncate">
          {ticket.id}
        </Text>
      </Box>
      <Box width={22}>
        <Text color={STATUS_COLOR[ticket.status]}>
          {ticket.status}
          {stage}
          {round}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor wrap="truncate">
          {ticket.lastActivity}
        </Text>
      </Box>
      {cost ? <Text dimColor>{cost}</Text> : null}
    </Box>
  );
}

function pauseBannerText(banner: PauseBanner): string {
  if (banner.resumesAt === null)
    return `Harness needs attention: ${banner.detail} — repair, then press R`;
  const at = new Date(banner.resumesAt).toLocaleTimeString();
  const what = banner.kind === "usage-limit" ? "Usage limit" : `Harness ${banner.kind}`;
  return `${what} — resumes ${at} · R to retry now`;
}

export interface AppProps {
  log: EventLog;
  boardName: string;
  targetBranch: string;
  onQuit: () => void;
  /** The human's "the provider is back / I repaired it" signal. */
  onRetry: () => void;
}

/**
 * The live view for `jfdi start` — a pure renderer over the event stream.
 * It reads nothing from pipeline internals: state snapshots + events only.
 */
export function App({ log, boardName, targetBranch, onQuit, onRetry }: AppProps) {
  const { exit } = useApp();
  const [view, setView] = useState(() => initialLiveView(log.snapshot()));

  useEffect(() => {
    return log.on((event, snapshot) => {
      setView((previous) => reduceLiveView(previous, event, snapshot));
    });
  }, [log]);

  useInput((input) => {
    if (input === "q") {
      onQuit();
      exit();
    }
    if (input === "r" || input === "R") onRetry();
  });

  const { active, waiting, settled } = ticketGroups(view.state);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold inverse>
          {" JFDI "}
        </Text>
        <Text> {boardName} → </Text>
        <Text bold>{targetBranch}</Text>
        <Text dimColor> · q to quit</Text>
      </Box>

      {view.pause !== null && (
        <Box marginBottom={1}>
          <Text bold inverse color="yellow" wrap="truncate">
            {` ${pauseBannerText(view.pause)} `}
          </Text>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>
          Active ({active.length})
        </Text>
        {active.length === 0 ? (
          <Text dimColor>waiting for cards in the begin column…</Text>
        ) : (
          active.map((t) => <TicketRow key={t.id} ticket={t} />)
        )}
      </Box>

      {waiting.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Needs attention / queued
          </Text>
          {waiting.map((t) => (
            <TicketRow key={t.id} ticket={t} />
          ))}
        </Box>
      )}

      {view.state.integrationQueue.length > 0 && (
        <Box marginBottom={1}>
          <Text bold>integration queue: </Text>
          <Text>{view.state.integrationQueue.join(" → ")}</Text>
        </Box>
      )}

      {settled.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Settled
          </Text>
          {settled.map((t) => (
            <TicketRow key={t.id} ticket={t} />
          ))}
        </Box>
      )}

      <Box flexDirection="column">
        <Text bold underline>
          Events
        </Text>
        {view.recent.map(({ sequence, event }) => (
          <Text key={sequence} dimColor wrap="truncate">
            {event.ts.slice(ISO_TIME_START, ISO_TIME_END)}{" "}
            {event.ticketId ? `[${event.ticketId}] ` : ""}
            {event.type}
            {event.data?.stage ? ` ${String(event.data.stage)}` : ""}
            {event.data?.verdict ? ` → ${String(event.data.verdict)}` : ""}
            {event.data?.reason ? `: ${String(event.data.reason)}` : ""}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
