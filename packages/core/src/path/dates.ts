/** Calendar days as `YYYY-MM-DD`; the engine is given today and never reads a clock. */
const DAY_MS = 86_400_000;

const at = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export function addDays(iso: string, days: number): string {
  return new Date(at(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to` (negative: `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((at(to) - at(from)) / DAY_MS);
}

const weekdayOf = (iso: string): number => new Date(at(iso)).getUTCDay();

/** Saturday and Sunday move to Monday. */
export function onWeekday(iso: string): string {
  const day = weekdayOf(iso);
  return day === 6 ? addDays(iso, 2) : day === 0 ? addDays(iso, 1) : iso;
}

/** Saturday and Sunday move back to Friday. */
function backToWeekday(iso: string): string {
  const day = weekdayOf(iso);
  return day === 6 ? addDays(iso, -1) : day === 0 ? addDays(iso, -2) : iso;
}

/**
 * When a step given `today` is due: its play's days later, on a weekday; a deadline the founder set that still lies
 * ahead pulls it in (to the deadline, or the Friday before one on a weekend), never before today.
 */
export function dueOnFor(today: string, days: number, deadline: string | null): string {
  const due = onWeekday(addDays(today, days));
  if (deadline === null || deadline < today || due <= deadline) return due;
  const pulled = backToWeekday(deadline);
  return pulled < today ? today : pulled;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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
];

/** "December 3". */
export function monthDay(iso: string): string {
  const d = new Date(at(iso));
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCDate())}`;
}

export function weekdayName(iso: string): string {
  return WEEKDAYS[weekdayOf(iso)] ?? '';
}

/** A coming date as it is said: "today", "tomorrow", "Friday" (within a week), else "December 3". */
export function sayComing(today: string, iso: string): string {
  const days = daysBetween(today, iso);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days > 1 && days < 7 ? weekdayName(iso) : monthDay(iso);
}

/** A due date as it is said, past or coming: "today", "Friday", "December 3", "last Friday", "on November 3". */
export function sayDue(today: string, iso: string): string {
  return iso < today ? sayPast(today, iso) : sayComing(today, iso);
}

/** A past date as it is said: "yesterday", "last Tuesday" (within a week), else "on November 3". */
export function sayPast(today: string, iso: string): string {
  const days = daysBetween(iso, today);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days < 7 ? `last ${weekdayName(iso)}` : `on ${monthDay(iso)}`;
}

const COUNT_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  ten: 10,
};

/** The coming `weekday` (0 Sunday … 6 Saturday), today counting as a week away. */
function comingWeekday(today: string, weekday: number): string {
  const ahead = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, ahead === 0 ? 7 : ahead);
}

/**
 * The day a founder says something is for ("by Friday", "tomorrow", "this week", "in three days", "by December 3"), as
 * an ISO date from today on; null when they say none.
 */
export function daySaid(text: string, today: string): string | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  if (/\b(?:today|tonight|this (?:afternoon|evening|morning))\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const month = new RegExp(`\\b(${MONTHS.join('|').toLowerCase()})\\.? (\\d{1,2})\\b`).exec(t);
  if (month !== null) {
    const index = MONTHS.findIndex((m) => m.toLowerCase() === month[1]);
    const year = Number(today.slice(0, 4));
    const iso = (y: number): string =>
      `${String(y)}-${String(index + 1).padStart(2, '0')}-${(month[2] ?? '').padStart(2, '0')}`;
    if (!Number.isNaN(at(iso(year))) && addDays(iso(year), 0) === iso(year))
      return iso(year) >= today ? iso(year) : iso(year + 1);
  }
  const inDays =
    /\b(?:in|within) (?:the next )?(an?|one|two|three|four|five|six|seven|ten|\d{1,2}) (days?|weeks?)\b/.exec(
      t,
    );
  if (inDays !== null) {
    const n = COUNT_WORDS[inDays[1] ?? ''] ?? Number(inDays[1]);
    return addDays(today, (inDays[2] ?? '').startsWith('week') ? n * 7 : n);
  }
  const weekday = new RegExp(`\\b(next )?(${WEEKDAYS.join('|').toLowerCase()})\\b`).exec(t);
  if (weekday !== null) {
    const index = WEEKDAYS.findIndex((d) => d.toLowerCase() === weekday[2]);
    const coming = comingWeekday(today, index);
    return weekday[1] !== undefined && daysBetween(today, coming) < 4 ? addDays(coming, 7) : coming;
  }
  if (/\b(?:this week|end of (?:the|this) week|by the weekend)\b/.test(t)) {
    // From Friday on, what is left of the week; on a Sunday, the week ahead.
    const day = weekdayOf(today);
    return day === 5 ? addDays(today, 2) : day === 6 ? addDays(today, 1) : comingWeekday(today, 5);
  }
  if (/\b(?:this|the) weekend\b/.test(t)) return weekdayOf(today) === 0 ? today : comingWeekday(today, 0);
  if (/\bnext week\b/.test(t)) return addDays(comingWeekday(today, 1), 4);
  return null;
}
