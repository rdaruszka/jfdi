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
});
