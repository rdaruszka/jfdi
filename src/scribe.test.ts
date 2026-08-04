import { describe, expect, it } from "vitest";
import { assembleCommitMessage, type SessionHandoff, scribeVariables } from "./scribe.js";

const HANDOFF: SessionHandoff = {
  stage: "implementation",
  round: 2,
  maxRounds: 3,
  outcome: "complete",
  routing: "moving to the mechanical gate",
  summary: "Taught the parser to accept sha256 object names.",
  isInterrupted: false,
};

describe("assembleCommitMessage", () => {
  it("puts the scribe's subject and body under the shape the pipeline owns", () => {
    const message = assembleCommitMessage(
      "Accept sha256 object names\n\nThe repository may be sha256, where a commit name is 64 hex\ndigits rather than 40.",
      "fix-object-names",
      HANDOFF,
    );
    expect(message).toBe(
      [
        "fix-object-names: Accept sha256 object names",
        "",
        "The repository may be sha256, where a commit name is 64 hex",
        "digits rather than 40.",
        "",
        "JFDI Implementation complete — moving to the mechanical gate",
        "JFDI-Round: 2/3",
        "",
      ].join("\n"),
    );
  });

  it("marks an interrupted session's partial work in the subject", () => {
    const message = assembleCommitMessage("Half of the parser", "fix-object-names", {
      ...HANDOFF,
      outcome: "interrupted: the session crashed",
      routing: "returning to Implementation for round 3",
      isInterrupted: true,
    });
    expect(message.split("\n")[0]).toBe("fix-object-names: WIP — Half of the parser");
    expect(message).toContain(
      "JFDI Implementation interrupted: the session crashed — returning to Implementation for round 3",
    );
  });

  it("does not repeat a ticket id the scribe already wrote", () => {
    const message = assembleCommitMessage(
      "fix-object-names: Accept sha256 object names",
      "fix-object-names",
      HANDOFF,
    );
    expect(message.split("\n")[0]).toBe("fix-object-names: Accept sha256 object names");
  });

  it("drops a status line or trailer the scribe wrote despite the instruction", () => {
    const message = assembleCommitMessage(
      [
        "Accept sha256 object names",
        "",
        "Widen the check.",
        "",
        "JFDI Implementation complete — moving to Code Review",
        "JFDI-Round: 9/9",
      ].join("\n"),
      "fix-object-names",
      HANDOFF,
    );
    // Exactly one of each, and the pipeline's own — not the routing the scribe
    // guessed at, which is the reason the pipeline owns these two lines.
    expect(message.match(/^JFDI-Round:/gm)).toHaveLength(1);
    expect(message).toContain("JFDI-Round: 2/3");
    expect(message).not.toContain("moving to Code Review");
    expect(message).toContain("Widen the check.");
  });

  it("keeps body prose that merely opens with the tool's name", () => {
    const message = assembleCommitMessage(
      "Rename the harness\n\nJFDI spawns one session per stage.",
      "rename-harness",
      HANDOFF,
    );
    expect(message).toContain("JFDI spawns one session per stage.");
  });

  it("strips a code fence the scribe wrapped its answer in", () => {
    const message = assembleCommitMessage(
      "```\nAccept sha256 object names\n\nWiden the check.\n```",
      "fix-object-names",
      HANDOFF,
    );
    expect(message.split("\n")[0]).toBe("fix-object-names: Accept sha256 object names");
    expect(message).not.toContain("```");
  });

  it("falls back to the stage's own summary when the scribe wrote nothing", () => {
    const message = assembleCommitMessage("", "fix-object-names", HANDOFF);
    expect(message.split("\n")[0]).toBe("fix-object-names: Implementation round 2");
    expect(message).toContain("Taught the parser to accept sha256 object names.");
    expect(message).toContain("JFDI-Round: 2/3");
  });
});

describe("scribeVariables", () => {
  it("hands the scribe the diff, the ticket, the summary and the status line", () => {
    const variables = scribeVariables(
      "fix-object-names",
      "# Fix object names\n\nsha256 repos.",
      {
        ...HANDOFF,
        stage: "qa",
        outcome: "PASSED",
        routing: "re-running the mechanical gate over the tests it wrote",
        summary: "one regression test",
      },
      {
        stagedDiff: "diff --git a/src/git.ts b/src/git.ts",
        recentLog: "Accept sha256 object names",
      },
    );
    expect(variables.SPEC).toContain("sha256 repos.");
    expect(variables.STAGED_DIFF).toContain("diff --git");
    expect(variables.STAGE_SUMMARY).toBe("one regression test");
    expect(variables.RECENT_LOG).toBe("Accept sha256 object names");
    expect(variables.STAGE).toBe("QA");
    expect(variables.STATUS_LINE).toBe(
      "JFDI QA PASSED — re-running the mechanical gate over the tests it wrote",
    );
    expect(variables.ROUND).toBe("2");
    expect(variables.MAX_ROUNDS).toBe("3");
  });

  it("says so plainly when the session recorded no summary", () => {
    const variables = scribeVariables(
      "fix-object-names",
      "spec",
      { ...HANDOFF, summary: "" },
      {
        stagedDiff: "",
        recentLog: "",
      },
    );
    expect(variables.STAGE_SUMMARY).toBe("(the session recorded none)");
  });
});
