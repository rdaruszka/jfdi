import { describe, expect, it } from "vitest";
import { parseResetTime } from "./reset-time.js";

/** A fixed local instant to read every relative string against. */
const NOW = new Date(2026, 7, 3, 9, 30).getTime();

function localTime(
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes = 0,
): number {
  return new Date(year, monthIndex, day, hours, minutes).getTime();
}

describe("parseResetTime", () => {
  it("refuses a calendar date rather than misreading its clock at a year boundary", () => {
    const newYearsDay = new Date(2026, 0, 1, 9, 30).getTime();
    expect(parseResetTime("Dec 31 at 7pm", newYearsDay)).toBe(null);
  });

  it("reads a bare clock time as later today", () => {
    expect(parseResetTime("3:45pm", NOW)).toBe(localTime(2026, 7, 3, 15, 45));
    expect(parseResetTime("7pm", NOW)).toBe(localTime(2026, 7, 3, 19));
  });

  it("rolls a clock time that has already passed today over to tomorrow", () => {
    expect(parseResetTime("8:00am", NOW)).toBe(localTime(2026, 7, 4, 8));
  });

  it("reads midnight as 12am, not noon", () => {
    expect(parseResetTime("12:00am", NOW)).toBe(localTime(2026, 7, 4, 0));
    expect(parseResetTime("12:00pm", NOW)).toBe(localTime(2026, 7, 3, 12));
  });

  it("ignores a parenthesized timezone it cannot honour", () => {
    expect(parseResetTime("7pm (Europe/Madrid)", NOW)).toBe(localTime(2026, 7, 3, 19));
  });

  it("refuses a string with no time in it", () => {
    expect(parseResetTime("later", NOW)).toBe(null);
    expect(parseResetTime("", NOW)).toBe(null);
  });

  it("refuses times that are not times", () => {
    expect(parseResetTime("25:00", NOW)).toBe(null);
    expect(parseResetTime("13pm", NOW)).toBe(null);
  });

  // Regression: three prose shapes the parser once accepted on speculation were
  // deleted — a 24-hour clock, a calendar date, and a weekday. Each is now
  // unreadable, so the caller falls back to probe-with-backoff instead of
  // reading (and mis-reading) a time no provider has ever been seen to print.
  it("refuses the deleted 24-hour clock form", () => {
    expect(parseResetTime("19:00", NOW)).toBe(null);
    expect(parseResetTime("07:30", NOW)).toBe(null);
  });

  it("refuses the deleted calendar-date form even when it carries a valid clock", () => {
    expect(parseResetTime("May 28 at 7pm", NOW)).toBe(null);
    expect(parseResetTime("Aug 28 at 7pm (Europe/Madrid)", NOW)).toBe(null);
    expect(parseResetTime("Mar 3rd, 2027 3:45 PM", NOW)).toBe(null);
  });

  it("refuses the deleted weekday form even when it carries a valid clock", () => {
    expect(parseResetTime("Mon 12:00am", NOW)).toBe(null);
    expect(parseResetTime("Wed 6pm", NOW)).toBe(null);
  });

  // The regex anchors the whole string to the clock, so a clock riding along
  // with any other text — a bare timezone abbreviation, surrounding words — is
  // not the observed bare form and reads as null, not as an embedded time.
  it("refuses a clock embedded in surrounding text", () => {
    expect(parseResetTime("3:45pm ET", NOW)).toBe(null);
    expect(parseResetTime("at 3:45pm today", NOW)).toBe(null);
  });
});
