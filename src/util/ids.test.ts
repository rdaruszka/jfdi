import { describe, expect, it } from "vitest";
import { extractWikilink, slugify, ticketIdFromCard } from "./ids.js";

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Add User Login!")).toBe("add-user-login");
  });
  it("collapses runs and trims edges", () => {
    expect(slugify("  --Weird__  chars//  ")).toBe("weird-chars");
  });
  it("never emits consecutive dashes — the invariant the removed collapse pass guarded", () => {
    // Inputs engineered to try to force a "--" past the non-alphanumeric
    // collapse: adjacent brackets, dashes, and other punctuation runs.
    const adversarial = [
      "[[a]]-[[b]]",
      "[[a]]--[[b]]",
      "a -- b",
      "a__--__b",
      "]]--[[",
      "--a--b--",
      "a - - b",
      "[[ - ]] [[ - ]]",
      "!!--!!",
      "a]]-[[b",
    ];
    for (const input of adversarial) {
      expect(slugify(input)).not.toMatch(/--/);
    }
  });
});

// Reference implementation exactly as it stood BEFORE this ticket deleted the
// trailing `.replace(/-{2,}/g, "-")` collapse pass. Kept here only to prove the
// removal is behavior-preserving for every input — if any string slugified
// differently under the two, the pass was reachable and the change wrong.
function slugifyWithDeadCollapse(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\[|\]\]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// Deterministic PRNG (mulberry32) — the guidelines ban Math.random in tests.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("slugify removal is behavior-preserving (fuzz equivalence)", () => {
  it("matches the pre-removal three-pass+collapse version for every fuzzed input", () => {
    const random = makeRandom(0x9e3779b9);
    // Alphabet skewed toward the characters that could plausibly produce a
    // "--" — brackets, dashes, underscores, spaces, punctuation — plus letters
    // and digits, so slugs are non-trivial.
    const alphabet = [
      ..."abcxyzABC012",
      " ",
      " ",
      "-",
      "-",
      "_",
      "[",
      "]",
      "!",
      "/",
      ".",
      "\t",
      "é",
      "—",
    ];
    const iterations = 50_000;
    for (let i = 0; i < iterations; i++) {
      const length = Math.floor(random() * 16);
      let input = "";
      for (let j = 0; j < length; j++) {
        input += alphabet[Math.floor(random() * alphabet.length)];
      }
      expect(slugify(input)).toBe(slugifyWithDeadCollapse(input));
    }
  });
});

describe("extractWikilink", () => {
  it("extracts a plain wikilink", () => {
    expect(extractWikilink("Fix the thing [[fix-thing]]")).toBe("fix-thing");
  });
  it("handles aliased wikilinks", () => {
    expect(extractWikilink("[[fix-thing|Fix it]]")).toBe("fix-thing");
  });
  it("returns null when absent", () => {
    expect(extractWikilink("no link here")).toBeNull();
  });
});

describe("ticketIdFromCard", () => {
  it("uses the wikilink target when present", () => {
    expect(ticketIdFromCard("Do stuff [[My Ticket]]")).toBe("my-ticket");
  });
  it("derives slug+hash for bare cards, stable across calls", () => {
    const firstId = ticketIdFromCard("Add a --help flag to the CLI");
    const secondId = ticketIdFromCard("Add a --help flag to the CLI");
    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^add-a-help-flag-to-the-[0-9a-f]{6}$/);
  });
  it("distinct bare cards with same prefix get distinct ids", () => {
    const firstId = ticketIdFromCard("Add a flag to the CLI for verbose output");
    const secondId = ticketIdFromCard("Add a flag to the CLI for quiet output");
    expect(firstId).not.toBe(secondId);
  });
});
