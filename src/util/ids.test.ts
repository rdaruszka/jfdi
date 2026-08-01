import { describe, expect, it } from "vitest";
import { extractWikilink, slugify, ticketIdFromCard } from "./ids.js";

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Add User Login!")).toBe("add-user-login");
  });
  it("collapses runs and trims edges", () => {
    expect(slugify("  --Weird__  chars//  ")).toBe("weird-chars");
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
    const a = ticketIdFromCard("Add a --help flag to the CLI");
    const b = ticketIdFromCard("Add a --help flag to the CLI");
    expect(a).toBe(b);
    expect(a).toMatch(/^add-a-help-flag-to-the-[0-9a-f]{6}$/);
  });
  it("distinct bare cards with same prefix get distinct ids", () => {
    const a = ticketIdFromCard("Add a flag to the CLI for verbose output");
    const b = ticketIdFromCard("Add a flag to the CLI for quiet output");
    expect(a).not.toBe(b);
  });
});
