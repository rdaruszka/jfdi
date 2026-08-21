import { describe, expect, it } from "vitest";
import { emptyState, type JfdiEvent, reduceEvent } from "../events.js";
import { initialLiveView, reduceLiveView, ticketGroups } from "./live-view.js";

function event(type: JfdiEvent["type"], data?: Record<string, unknown>): JfdiEvent {
  return { ts: "2026-08-20T12:34:56.000Z", type, ticketId: "watch-runs", data };
}

describe("live renderer view", () => {
  it("groups the same ticket statuses presented by the renderers", () => {
    let state = emptyState();
    state = reduceEvent(state, event("dispatch", { title: "Watch runs" }));
    const groups = ticketGroups(state);

    expect(groups.active.map((ticket) => ticket.id)).toEqual(["watch-runs"]);
    expect(groups.waiting).toEqual([]);
    expect(groups.settled).toEqual([]);
  });

  it("keeps a bounded event tail and omits chatty activity and card moves", () => {
    let view = initialLiveView(emptyState());
    for (let index = 0; index < 10; index += 1) {
      const nextEvent = event("round_start", { round: index + 1 });
      view = reduceLiveView(view, nextEvent, reduceEvent(view.state, nextEvent));
    }
    const activity = event("session_activity", { text: "still working" });
    view = reduceLiveView(view, activity, reduceEvent(view.state, activity));
    const cardMove = event("card_moved");
    view = reduceLiveView(view, cardMove, reduceEvent(view.state, cardMove));

    expect(view.recent).toHaveLength(8);
    expect(view.recent[0]?.event.data?.round).toBe(3);
    expect(view.recent.every((entry) => entry.event.type === "round_start")).toBe(true);
  });

  it("tracks tool-wide pause and resume without changing ticket state", () => {
    let view = initialLiveView(emptyState());
    const paused = event("harness_paused", {
      kind: "usage-limit",
      detail: "allowance exhausted",
      resumesAt: "2026-08-20T13:00:00.000Z",
    });
    view = reduceLiveView(view, paused, reduceEvent(view.state, paused));

    expect(view.pause).toEqual({
      kind: "usage-limit",
      detail: "allowance exhausted",
      resumesAt: "2026-08-20T13:00:00.000Z",
    });

    const resumed = event("harness_resumed", { trigger: "timer" });
    view = reduceLiveView(view, resumed, reduceEvent(view.state, resumed));
    expect(view.pause).toBeNull();
  });
});
