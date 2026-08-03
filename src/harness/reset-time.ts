/**
 * Reading the instant a usage limit lifts out of the sentence a provider
 * printed for a human. Neither CLI exposes it as data, so this is best-effort
 * by construction: an unrecognized shape returns null and the caller falls
 * back to its probe backoff, which is always safe because a limit self-expires.
 *
 * Reading it *early* is safe too — the retry fails, gets classified again, and
 * re-pauses on the fresh reset time. That is why an unreadable timezone is not
 * a reason to give up on the rest of the string.
 */

const MONTH_PREFIXES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

const WEEKDAY_PREFIXES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const DAYS_PER_WEEK = 7;
const HOURS_PER_HALF_DAY = 12;
const MAX_HOUR_24 = 23;
const MAX_MINUTE = 59;

/** `7pm`, `3:45 PM`, `12:00am` — the only forms either provider prints. */
const CLOCK_12_HOUR = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
/** `19:00` — accepted as a fallback for locales that print 24-hour time. */
const CLOCK_24_HOUR = /\b(\d{1,2}):(\d{2})\b/;
/** `May 28`, `Mar 3rd, 2027`, `Sep. 1 2026`. */
const MONTH_DAY = new RegExp(
  `\\b(${MONTH_PREFIXES.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`,
  "i",
);
const WEEKDAY = new RegExp(`\\b(${WEEKDAY_PREFIXES.join("|")})[a-z]*\\b`, "i");
/** `(Europe/Madrid)` — a timezone we cannot honour; see the file comment. */
const PARENTHESIZED = /\([^)]*\)/g;

interface ClockTime {
  hours: number;
  minutes: number;
}

function parseClock(text: string): ClockTime | null {
  const twelve = CLOCK_12_HOUR.exec(text);
  if (twelve?.[1] !== undefined && twelve[3] !== undefined) {
    const rawHours = Number(twelve[1]);
    const minutes = Number(twelve[2] ?? "0");
    if (rawHours < 1 || rawHours > HOURS_PER_HALF_DAY || minutes > MAX_MINUTE) return null;
    const isAfternoon = twelve[3].toLowerCase() === "pm";
    const hours = (rawHours % HOURS_PER_HALF_DAY) + (isAfternoon ? HOURS_PER_HALF_DAY : 0);
    return { hours, minutes };
  }
  const twentyFour = CLOCK_24_HOUR.exec(text);
  if (twentyFour?.[1] === undefined || twentyFour[2] === undefined) return null;
  const hours = Number(twentyFour[1]);
  const minutes = Number(twentyFour[2]);
  if (hours > MAX_HOUR_24 || minutes > MAX_MINUTE) return null;
  return { hours, minutes };
}

interface MonthDay {
  monthIndex: number;
  day: number;
  year: number | null;
}

function parseMonthDay(text: string): MonthDay | null {
  const match = MONTH_DAY.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const monthIndex = MONTH_PREFIXES.indexOf(
    match[1].toLowerCase() as (typeof MONTH_PREFIXES)[number],
  );
  return {
    monthIndex,
    day: Number(match[2]),
    year: match[3] === undefined ? null : Number(match[3]),
  };
}

function parseWeekdayIndex(text: string): number | null {
  const match = WEEKDAY.exec(text);
  if (match?.[1] === undefined) return null;
  return WEEKDAY_PREFIXES.indexOf(match[1].toLowerCase() as (typeof WEEKDAY_PREFIXES)[number]);
}

/**
 * The epoch-ms instant `text` names, read in local time, or null when nothing
 * in it is a time we recognize. A bare clock time means the next time that
 * clock reads so; a weekday means the next such weekday; a calendar date
 * already behind us is stale text rather than a wait, and yields null.
 */
export function parseResetTime(text: string, nowMs: number): number | null {
  const cleaned = text.replace(PARENTHESIZED, " ");
  const clock = parseClock(cleaned);
  if (clock === null) return null;
  const now = new Date(nowMs);

  const monthDay = parseMonthDay(cleaned);
  if (monthDay !== null) {
    const dated = new Date(
      monthDay.year ?? now.getFullYear(),
      monthDay.monthIndex,
      monthDay.day,
      clock.hours,
      clock.minutes,
    );
    return dated.getTime() > nowMs ? dated.getTime() : null;
  }

  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hours, clock.minutes);
  const weekdayIndex = parseWeekdayIndex(cleaned);
  if (weekdayIndex !== null) {
    at.setDate(at.getDate() + ((weekdayIndex - at.getDay() + DAYS_PER_WEEK) % DAYS_PER_WEEK));
  }
  if (at.getTime() <= nowMs) {
    at.setDate(at.getDate() + (weekdayIndex === null ? 1 : DAYS_PER_WEEK));
  }
  return at.getTime();
}
