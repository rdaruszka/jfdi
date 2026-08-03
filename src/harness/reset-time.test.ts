import { describe, expect, it } from "vitest";
import { parseResetTime } from "./reset-time.js";

/** A fixed local instant to read every relative string against: 2026-08-03 is a Monday. */
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

  it("reads a weekday as the next such day", () => {
    // Today is Monday: "Mon 12:00am" means next Monday, since 00:00 has passed.
    expect(parseResetTime("Mon 12:00am", NOW)).toBe(localTime(2026, 7, 10, 0));
    expect(parseResetTime("Wed 6pm", NOW)).toBe(localTime(2026, 7, 5, 18));
  });

  it("reads a calendar date, ignoring a timezone it cannot honour", () => {
    expect(parseResetTime("May 28 at 7pm (Europe/Madrid)", NOW)).toBe(null);
    expect(parseResetTime("Aug 28 at 7pm (Europe/Madrid)", NOW)).toBe(localTime(2026, 7, 28, 19));
    expect(parseResetTime("Mar 3rd, 2027 3:45 PM", NOW)).toBe(localTime(2027, 2, 3, 15, 45));
  });

  it("refuses a string with no time in it", () => {
    expect(parseResetTime("later", NOW)).toBe(null);
    expect(parseResetTime("", NOW)).toBe(null);
  });

  it("refuses times that are not times", () => {
    expect(parseResetTime("25:00", NOW)).toBe(null);
    expect(parseResetTime("13pm", NOW)).toBe(null);
  });

  it("accepts 24-hour clocks for locales that print them", () => {
    expect(parseResetTime("19:00", NOW)).toBe(localTime(2026, 7, 3, 19));
  });
});
