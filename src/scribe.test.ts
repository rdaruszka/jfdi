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
  usage: {
    durationMs: 7 * 60 * 1_000,
    costUsd: 1.87,
    inputTokens: 120_000,
    cachedInputTokens: 0,
    outputTokens: 8_000,
    reasoningTokens: 0,
  },
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
        "",
        "JFDI-Round: 2/3",
        "JFDI-Duration: 7m",
        "JFDI-Cost: $1.87",
        "",
      ].join("\n"),
    );
  });

  it("renders a known cost as dollars and an unknown one as a token count in the trailer", () => {
    const known = assembleCommitMessage("Body", "fix-object-names", HANDOFF);
    expect(known).toContain("JFDI-Cost: $1.87");
    expect(known).toContain("JFDI-Duration: 7m");

    // A Codex model the price table does not carry: costUsd null → tokens shown,
    // never a fabricated dollar figure.
    const unknown = assembleCommitMessage("Body", "fix-object-names", {
      ...HANDOFF,
      usage: {
        durationMs: 90_000,
        costUsd: null,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000,
        reasoningTokens: 50_000,
      },
    });
    expect(unknown).toContain("JFDI-Cost: 1.2M tokens, price unavailable");
    expect(unknown).toContain("JFDI-Duration: 2m");
  });

  it("marks a Codex table cost as an estimate, but leaves a provider-reported one alone", () => {
    // Claude's cost is exact — no qualifier.
    expect(assembleCommitMessage("Body", "fix-object-names", HANDOFF)).toContain(
      "JFDI-Cost: $1.87\n",
    );
    // A Codex figure is a table estimate that runs low, and says so.
    const estimated = assembleCommitMessage("Body", "fix-object-names", {
      ...HANDOFF,
      usage: { ...HANDOFF.usage, costUsd: 1.5, isCostEstimated: true },
    });
    expect(estimated).toContain("JFDI-Cost: $1.50 (estimate, runs low)");
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

/**
 * The scribe's answer is subprocess output on its way into permanent repository
 * history: a trust boundary, and the shipped contract's limits are enforced
 * here rather than asked for in the prompt. These are the shapes a session that
 * ignores its instructions — or is having a bad day — actually produces.
 */
describe("assembleCommitMessage against hostile scribe output", () => {
  /** The contract's bound, as the prompt states it. */
  const MaxSubjectSummaryChars = 72;

  const subjectOf = (message: string) => message.split("\n")[0] ?? "";

  /** Anything git or a terminal would choke on; tabs and newlines are text. */
  const hasControlCharacters = (text: string) =>
    [...text].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 0x20 && character !== "\n" && character !== "\t") || code === 0x7f;
    });

  it("never lets a subject past the contract's bound, however long the first line", () => {
    const overrun = `Rework ${"the object-name pattern ".repeat(20)}everywhere`;
    expect(overrun.length).toBeGreaterThan(MaxSubjectSummaryChars);
    const message = assembleCommitMessage(`${overrun}\n\nAnd some body.`, "fix-names", HANDOFF);

    // The subject is the pipeline's own, inside the bound; the overrun line is
    // kept as body rather than thrown away or silently chopped mid-word.
    expect(subjectOf(message)).toBe("fix-names: Implementation round 2");
    expect(subjectOf(message).length).toBeLessThanOrEqual(
      "fix-names: ".length + MaxSubjectSummaryChars,
    );
    expect(message).toContain(overrun);
    expect(message).toContain("And some body.");
    expect(message).toContain("JFDI-Round: 2/3");
  });

  it("keeps a summary that sits exactly on the bound, and rejects one character more", () => {
    const exact = "x".repeat(MaxSubjectSummaryChars);
    expect(subjectOf(assembleCommitMessage(exact, "fix-names", HANDOFF))).toBe(
      `fix-names: ${exact}`,
    );
    expect(subjectOf(assembleCommitMessage(`${exact}y`, "fix-names", HANDOFF))).toBe(
      "fix-names: Implementation round 2",
    );
  });

  it("bounds the whole body when the scribe echoes its input back", () => {
    const echoed = "diff --git a/src/git.ts b/src/git.ts\n".repeat(2_000);
    const message = assembleCommitMessage(`Widen the pattern\n\n${echoed}`, "fix-names", HANDOFF);
    expect(message.length).toBeLessThan(echoed.length);
    // Cut loudly: a reader can tell the message is not all there.
    expect(message).toContain("[commit message truncated by JFDI]");
    expect(message).toContain("JFDI-Round: 2/3");
  });

  it("strips control characters that git or a terminal would choke on", () => {
    const message = assembleCommitMessage(
      "Widen the\u0000 pattern\r\n\r\nEscape: \u001b[31mred\u001b[0m, bell \u0007.",
      "fix-names",
      HANDOFF,
    );
    expect(hasControlCharacters(message)).toBe(false);
    expect(subjectOf(message)).toBe("fix-names: Widen the pattern");
    expect(message).toContain("Escape: [31mred[0m, bell .");
  });

  it("survives an answer that is nothing but the metadata the pipeline owns", () => {
    const message = assembleCommitMessage(
      "JFDI Implementation complete — moving to Code Review\nJFDI-Round: 9/9",
      "fix-names",
      HANDOFF,
    );
    expect(subjectOf(message)).toBe("fix-names: Implementation round 2");
    // The stage's own summary carries the message instead, and the round is ours.
    expect(message).toContain("Taught the parser to accept sha256 object names.");
    expect(message).toContain("JFDI-Round: 2/3");
    expect(message).not.toContain("9/9");
  });

  it("survives an answer that is only whitespace, or only the ticket id", () => {
    for (const hostile of ["   \n\n\t\n", "fix-names:", "fix-names:    "]) {
      const message = assembleCommitMessage(hostile, "fix-names", HANDOFF);
      expect(subjectOf(message)).toBe("fix-names: Implementation round 2");
      expect(message).toContain("JFDI-Round: 2/3");
    }
  });

  it("takes the subject from the first line even when the answer starts blank", () => {
    const message = assembleCommitMessage("\n\nWiden the pattern\n\nBecause sha256.", "fix-names", {
      ...HANDOFF,
      isInterrupted: true,
    });
    // Leading blank lines are the scribe's formatting, not an empty subject —
    // and an interrupted session still gets its WIP marker.
    expect(subjectOf(message)).toBe("fix-names: WIP — Widen the pattern");
    expect(message).toContain("Because sha256.");
  });

  it("scrubs the stage's own summary before it stands in for a missing answer", () => {
    // The summary comes out of an agent's verdict JSON: external text, and the
    // path an empty scribe answer falls back to.
    const hostileSummary =
      "Widened the\u0000 pattern\r\nEscape: \u001b[31mred\u001b[0m, bell \u0007";
    for (const noAnswer of ["", "   \n\t ", "JFDI-Round: 9/9"]) {
      const message = assembleCommitMessage(noAnswer, "fix-names", {
        ...HANDOFF,
        summary: hostileSummary,
      });
      expect(hasControlCharacters(message)).toBe(false);
      // Scrubbed, not dropped: what the session said still reaches the reader.
      expect(message).toContain("Widened the pattern");
      expect(message).toContain("Escape: [31mred[0m, bell");
      expect(subjectOf(message)).toBe("fix-names: Implementation round 2");
      expect(message).toContain("JFDI-Round: 2/3");
    }
  });

  it("scrubs and flattens an interrupted session's outcome into one status line", () => {
    // `outcome` quotes the dead session's own output — subprocess text, and it
    // has to stay on one line or the trailer below it stops being a trailer.
    const message = assembleCommitMessage("", "fix-names", {
      ...HANDOFF,
      isInterrupted: true,
      outcome: "interrupted: killed\u0000 mid-edit\nsecond line\u001b[0m",
      routing: "returning to\nImplementation for round 3",
      summary: "Half a parser\u0007",
    });
    expect(hasControlCharacters(message)).toBe(false);
    const messageLines = message.trimEnd().split("\n");
    expect(messageLines[0]).toBe("fix-names: WIP — Implementation round 2");
    // One line for the status, then the trailer alone in its own paragraph —
    // git only parses an all-trailer last paragraph as a trailer block.
    expect(messageLines.slice(-5)).toEqual([
      "JFDI Implementation interrupted: killed mid-edit second line[0m — returning to Implementation for round 3",
      "",
      "JFDI-Round: 2/3",
      "JFDI-Duration: 7m",
      "JFDI-Cost: $1.87",
    ]);
  });

  it("still produces a well-formed message when every external fragment is hostile", () => {
    const message = assembleCommitMessage("\u0000\u0007\u001b", "fix-names", {
      ...HANDOFF,
      outcome: "\u0000complete",
      routing: "\u0007moving on",
      summary: "\u0000\u0007",
    });
    expect(hasControlCharacters(message)).toBe(false);
    // A summary that scrubs away to nothing leaves subject and trailers only.
    expect(message).toBe(
      [
        "fix-names: Implementation round 2",
        "",
        "JFDI Implementation complete — moving on",
        "",
        "JFDI-Round: 2/3",
        "JFDI-Duration: 7m",
        "JFDI-Cost: $1.87",
        "",
      ].join("\n"),
    );
  });

  it("always ends with the status line and the round trailer, whatever came back", () => {
    const hostile = [
      "",
      '```json\n{"subject": "not a message"}\n```',
      "x".repeat(500),
      "\u0000\u0007",
      "JFDI-Round: 1/1",
    ];
    for (const text of hostile) {
      const message = assembleCommitMessage(text, "fix-names", HANDOFF);
      expect(message.startsWith("fix-names: ")).toBe(true);
      expect(message.trimEnd().split("\n").slice(-5)).toEqual([
        "JFDI Implementation complete — moving to the mechanical gate",
        "",
        "JFDI-Round: 2/3",
        "JFDI-Duration: 7m",
        "JFDI-Cost: $1.87",
      ]);
      expect(message.endsWith("\n")).toBe(true);
    }
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
