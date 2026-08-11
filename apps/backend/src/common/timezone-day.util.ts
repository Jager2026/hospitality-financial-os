/** Computes the UTC instant range [start, end) for "today" as a calendar day in a given IANA
 * timezone (Restaurant.timezone) — dependency-free, using only the platform Intl APIs already
 * available in Node, rather than pulling in date-fns-tz/luxon for one calculation. Needed because
 * naive UTC "today" is wrong for any restaurant not on UTC: a restaurant in Europe/Vilnius doing
 * evening business would see its own late-evening sales counted as "tomorrow" until well past
 * local midnight.
 *
 * Known, accepted MVP-scale limitation: on the two days per year a timezone's DST offset actually
 * changes, the offset used for `start`/`end` is evaluated at UTC-midnight-of-that-calendar-date,
 * not at the exact (unknown in advance) instant of local midnight — so a window boundary can be
 * off by the DST delta (typically one hour) specifically on those two days. Every other day of
 * the year is exact. Not a forgotten edge case; revisit only if this ever shows up in practice
 * (ADR-012 confines launch to a single timezone for now). */

export interface DayWindow {
  /** The restaurant's own local calendar date this window represents, e.g. "2026-08-10". */
  date: string;
  start: Date;
  end: Date;
}

/** `daysAgo=0` is today, `daysAgo=1` is yesterday, etc. — relative to `referenceUtc`'s own local
 * calendar date in `timezone`. */
export function getLocalDayWindow(
  timezone: string,
  daysAgo: number,
  referenceUtc: Date = new Date(),
): DayWindow {
  const today = getLocalDateParts(timezone, referenceUtc);
  const target = addCalendarDays(today, -daysAgo);
  const next = addCalendarDays(target, 1);

  const start = localMidnightUtc(timezone, target);
  const end = localMidnightUtc(timezone, next);
  const date = `${target.year}-${pad(target.month)}-${pad(target.day)}`;

  return { date, start, end };
}

/** Sprint 10 (Analytics): every calendar date from `from` to `to`, inclusive, as "YYYY-MM-DD"
 * strings — pure calendar arithmetic, no timezone involved (same reasoning as `addCalendarDays`
 * itself). The caller's own Zod schema is responsible for capping the range before this runs. */
export function enumerateDates(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const dates: string[] = [];
  let cursor: DateParts = { year: fy, month: fm, day: fd };
  const end: DateParts = { year: ty, month: tm, day: td };
  while (
    Date.UTC(cursor.year, cursor.month - 1, cursor.day) <=
    Date.UTC(end.year, end.month - 1, end.day)
  ) {
    dates.push(`${cursor.year}-${pad(cursor.month)}-${pad(cursor.day)}`);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

/** Sprint 10 (Analytics): the window for an EXPLICIT calendar date (not relative to "today") —
 * `dateStr` a plain "YYYY-MM-DD", already validated by the caller's own Zod schema. Shares the
 * exact same offset/DST reasoning as `getLocalDayWindow` above (see this module's own doc
 * comment) — a date range query is just this function called once per day in the range. */
export function getDayWindowForDate(timezone: string, dateStr: string): DayWindow {
  const [year, month, day] = dateStr.split("-").map(Number);
  const target: DateParts = { year, month, day };
  const next = addCalendarDays(target, 1);

  const start = localMidnightUtc(timezone, target);
  const end = localMidnightUtc(timezone, next);

  return { date: dateStr, start, end };
}

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Pure Gregorian calendar arithmetic — no timezone involved, `Date.UTC`'s own field
 * normalization does the month/year rollover correctly for any overflow/underflow of `day`. */
function addCalendarDays(parts: DateParts, n: number): DateParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function getLocalDateParts(timezone: string, instant: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/** The UTC instant of local midnight for the given calendar date in `timezone`. Evaluates the
 * timezone's offset at UTC-midnight-of-that-date as a stand-in for the (not yet known) instant of
 * local midnight itself — exact except on a DST-transition day, see module doc comment. */
function localMidnightUtc(timezone: string, parts: DateParts): Date {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const offsetMinutes = getTimezoneOffsetMinutes(timezone, guess);
  return new Date(guess.getTime() - offsetMinutes * 60_000);
}

/** How far `timezone`'s local clock is ahead of UTC, in minutes, at `instant` — e.g. +180 for
 * Europe/Vilnius in summer (UTC+3). Computed by formatting `instant` in the target timezone and
 * diffing against its own UTC fields — the standard dependency-free technique. */
function getTimezoneOffsetMinutes(timezone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}
