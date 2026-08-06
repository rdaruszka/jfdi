import { describe, expect, it } from "vitest";
import {
  blockedByCycles,
  blockedByLoop,
  describeBlockers,
  unresolvedBlockers,
} from "./blocking.js";
import type { Board, Card } from "./board.js";
import type { TicketLink } from "./tickets.js";

function card(text: string): Card {
  return { raw: `- [ ] ${text}`, text, checked: false };
}

/** A one-column board — enough for the column lookups these cases make. */
function boardWith(column: string, cardTexts: string[]): Board {
  return { columns: [{ name: column, cards: cardTexts.map(card) }] };
}

function blockedBy(...targets: string[]): TicketLink[] {
  return targets.map((target) => ({ kind: "blocked-by", target, notePath: null }));
}

describe("unresolvedBlockers", () => {
  it("treats a blocker in the done column as resolved", () => {
    const result = unresolvedBlockers(
      blockedBy("blocker"),
      boardWith("Done", ["[[blocker]]"]),
      "Done",
    );
    expect(result.ids).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("reports a blocker parked anywhere but done as unresolved", () => {
    const result = unresolvedBlockers(
      blockedBy("blocker"),
      boardWith("Ready", ["[[blocker]]"]),
      "Done",
    );
    expect(result.ids).toEqual(["blocker"]);
    expect(result.missing).toEqual([]);
  });

  it("reports a blocker with no card at all as unresolved and missing", () => {
    const result = unresolvedBlockers(blockedBy("ghost"), boardWith("Done", []), "Done");
    expect(result.ids).toEqual(["ghost"]);
    expect(result.missing).toEqual(["ghost"]);
  });

  it("ignores blocks-direction links — only blocked-by gates", () => {
    const links: TicketLink[] = [{ kind: "blocks", target: "downstream", notePath: null }];
    expect(unresolvedBlockers(links, boardWith("Ready", ["[[downstream]]"]), "Done").ids).toEqual(
      [],
    );
  });

  it("does not repeat a blocker listed twice", () => {
    const result = unresolvedBlockers(
      blockedBy("blocker", "blocker"),
      boardWith("Ready", ["[[blocker]]"]),
      "Done",
    );
    expect(result.ids).toEqual(["blocker"]);
  });
});

describe("describeBlockers", () => {
  it("flags the dangling blockers among the waiting-on set", () => {
    expect(describeBlockers({ ids: ["here", "ghost"], missing: ["ghost"] })).toBe(
      "here, ghost (no card on the board)",
    );
  });
});

describe("blockedByCycles", () => {
  it("finds a two-ticket cycle and names both members sorted", () => {
    const cycles = blockedByCycles([
      { id: "b", blockedBy: ["a"] },
      { id: "a", blockedBy: ["b"] },
    ]);
    expect(cycles).toEqual([["a", "b"]]);
  });

  it("finds a cycle longer than two", () => {
    const cycles = blockedByCycles([
      { id: "a", blockedBy: ["b"] },
      { id: "b", blockedBy: ["c"] },
      { id: "c", blockedBy: ["a"] },
    ]);
    expect(cycles).toEqual([["a", "b", "c"]]);
  });

  it("reports a self-blocking ticket as a degenerate cycle", () => {
    expect(blockedByCycles([{ id: "a", blockedBy: ["a"] }])).toEqual([["a"]]);
  });

  it("finds nothing in an acyclic chain", () => {
    expect(
      blockedByCycles([
        { id: "a", blockedBy: ["b"] },
        { id: "b", blockedBy: [] },
      ]),
    ).toEqual([]);
  });

  it("ignores edges to tickets outside the begin-column set", () => {
    expect(blockedByCycles([{ id: "a", blockedBy: ["elsewhere"] }])).toEqual([]);
  });
});

describe("blockedByLoop", () => {
  it("follows real blocked-by edges instead of the sorted signature", () => {
    const nodes = [
      { id: "a", blockedBy: ["c"] },
      { id: "b", blockedBy: ["a"] },
      { id: "c", blockedBy: ["b"] },
    ];
    const [cycle] = blockedByCycles(nodes);

    expect(blockedByLoop(cycle ?? [], nodes)).toEqual(["a", "c", "b", "a"]);
  });

  it("uses a closed walk when one simple cycle cannot name every component member", () => {
    const nodes = [
      { id: "a", blockedBy: ["b"] },
      { id: "b", blockedBy: ["a", "c"] },
      { id: "c", blockedBy: ["b"] },
    ];
    const [cycle] = blockedByCycles(nodes);

    expect(blockedByLoop(cycle ?? [], nodes)).toEqual(["a", "b", "c", "b", "a"]);
  });
});
