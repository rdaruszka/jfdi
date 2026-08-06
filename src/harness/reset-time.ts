/**
 * Reading the instant a usage limit lifts out of the 12-hour clock prose a
 * provider printed for a human. This is the one observed prose form; an
 * unrecognized shape returns null and the caller falls back to its probe
 * backoff, which is always safe because a limit self-expires.
 *
 * Reading it *early* is safe too — the retry fails, gets classified again, and
 * re-pauses on the fresh reset time. That is why an unreadable timezone is not
 * a reason to give up on the rest of the string.
 */

const HOURS_PER_HALF_DAY = 12;
const MAX_MINUTE = 59;

/** `7pm`, `3:45 PM`, `12:00am` — the only prose form either provider prints. */
const CLOCK_12_HOUR = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i;
/** `(Europe/Madrid)` — a timezone we cannot honour; see the file comment. */
const PARENTHESIZED = /\([^)]*\)/g;

interface ClockTime {
  hours: number;
  minutes: number;
}

function parseClock(text: string): ClockTime | null {
  const twelve = CLOCK_12_HOUR.exec(text);
  if (twelve?.[1] === undefined || twelve[3] === undefined) return null;
  const rawHours = Number(twelve[1]);
  const minutes = Number(twelve[2] ?? "0");
  if (rawHours < 1 || rawHours > HOURS_PER_HALF_DAY || minutes > MAX_MINUTE) return null;
  const isAfternoon = twelve[3].toLowerCase() === "pm";
  const hours = (rawHours % HOURS_PER_HALF_DAY) + (isAfternoon ? HOURS_PER_HALF_DAY : 0);
  return { hours, minutes };
}

/**
 * The epoch-ms instant `text` names, read in local time, or null when nothing
 * in it is the exact 12-hour clock form we recognize. The clock means the next
 * time that clock reads so.
 */
export function parseResetTime(text: string, nowMs: number): number | null {
  const cleaned = text.replace(PARENTHESIZED, " ");
  const clock = parseClock(cleaned);
  if (clock === null) return null;
  const now = new Date(nowMs);

  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hours, clock.minutes);
  if (at.getTime() <= nowMs) {
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}
