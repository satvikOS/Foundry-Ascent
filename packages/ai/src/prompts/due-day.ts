/** Dates of the path as a person says them, worked out by code: the model never computes a weekday or a date. */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAY_MS = 86_400_000;

function utc(iso: string): Date | null {
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date;
}

/** Whole days from `from` to `to` (both ISO dates; negative when `to` is earlier), or null when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const a = utc(from);
  const b = utc(to);
  return a === null || b === null ? null : Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** The weekday of an ISO date ("Thursday"), or null. */
export function weekdayOf(iso: string): string | null {
  const date = utc(iso);
  return date === null ? null : (WEEKDAYS[date.getUTCDay()] ?? null);
}

/** An ISO date with its weekday and month ("Thursday, December 4"), or null. */
export function longDay(iso: string): string | null {
  const date = utc(iso);
  if (date === null) return null;
  return `${WEEKDAYS[date.getUTCDay()] ?? ''}, ${MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
}

/**
 * A date the way a person says it from `today`: "today", "tomorrow", the weekday within six days ("Thursday"), else the
 * weekday and date ("Thursday, December 4"). Without `today`, the weekday and date. Null when it is not a date.
 */
export function sayDay(iso: string | null | undefined, today?: string | null): string | null {
  if (iso === null || iso === undefined) return null;
  const long = longDay(iso);
  if (long === null) return null;
  const days = today === null || today === undefined ? null : daysBetween(today, iso);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days !== null && days > 1 && days <= 6) return weekdayOf(iso);
  return long;
}

/** A past date the way a person says it: "yesterday", "on Tuesday" within six days, else "on Tuesday, November 18". */
export function sayPastDay(iso: string | null | undefined, today: string): string | null {
  if (iso === null || iso === undefined) return null;
  const days = daysBetween(iso, today);
  if (days === null) return null;
  if (days === 1) return 'yesterday';
  if (days === 0) return 'today';
  const day = days > 1 && days <= 6 ? weekdayOf(iso) : longDay(iso);
  return day === null ? null : `on ${day}`;
}
