import type { CoordinatorState, JfdiEvent, TicketState } from "../events.js";

/** The event tail both live front ends retain for the coordinator's lifetime. */
export const MAX_RECENT_EVENTS = 8;

export interface RecentEvent {
  sequence: number;
  event: JfdiEvent;
}

/** What a `harness_paused` event says, kept only until its `harness_resumed`. */
export interface PauseBanner {
  kind: string;
  detail: string;
  resumesAt: string | null;
}

export interface LiveView {
  state: CoordinatorState;
  recent: RecentEvent[];
  pause: PauseBanner | null;
  nextSequence: number;
}

export interface TicketGroups {
  active: TicketState[];
  waiting: TicketState[];
  settled: TicketState[];
}

export function initialLiveView(state: CoordinatorState): LiveView {
  return { state, recent: [], pause: null, nextSequence: 1 };
}

function pauseBannerFrom(data: Record<string, unknown> | undefined): PauseBanner {
  const resumesAt = data?.resumesAt;
  return {
    kind: typeof data?.kind === "string" ? data.kind : "harness failure",
    detail: typeof data?.detail === "string" ? data.detail : "no detail given",
    resumesAt: typeof resumesAt === "string" ? resumesAt : null,
  };
}

/** Pure fold shared by the TUI and web front end. */
export function reduceLiveView(
  view: LiveView,
  event: JfdiEvent,
  state: CoordinatorState,
): LiveView {
  let pause = view.pause;
  if (event.type === "harness_paused") pause = pauseBannerFrom(event.data);
  if (event.type === "harness_resumed") pause = null;
  if (event.type === "session_activity" || event.type === "card_moved") {
    return { ...view, state, pause };
  }
  return {
    state,
    pause,
    recent: [
      ...view.recent.slice(-(MAX_RECENT_EVENTS - 1)),
      { sequence: view.nextSequence, event },
    ],
    nextSequence: view.nextSequence + 1,
  };
}

export function ticketGroups(state: CoordinatorState): TicketGroups {
  const tickets = Object.values(state.tickets);
  return {
    active: tickets.filter((ticket) => ticket.status === "running" || ticket.status === "merging"),
    waiting: tickets.filter(
      (ticket) =>
        ticket.status === "merge-ready" ||
        ticket.status === "merge-queued" ||
        ticket.status === "blocked" ||
        ticket.status === "waiting",
    ),
    settled: tickets.filter((ticket) => ticket.status === "done" || ticket.status === "failed"),
  };
}
