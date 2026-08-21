/** Characters of an ISO-8601 timestamp that make up the `YYYY-MM-DD` date. */
const ISO_DATE_CHARACTERS = 10;

/** Today as `YYYY-MM-DD` (UTC) — the datestamp on every note section JFDI appends. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, ISO_DATE_CHARACTERS);
}
