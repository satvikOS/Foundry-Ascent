import { daysUntil } from '@/features/memory/typed/attributes';

/** How a step's date reads beside it. */
export interface DueState {
  readonly text: string;
  readonly overdue: boolean;
}

function dayLabel(iso: string): string {
  const [y = 1970, m = 1, d = 1] = iso.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(y, m - 1, d),
  );
}

/** "By Fri, Dec 5", "Due today", "Due tomorrow", "Overdue · Tue, Dec 2"; null without a date. */
export function dueState(dueOn: string | null, now: Date = new Date()): DueState | null {
  if (dueOn === null || !/^\d{4}-\d{2}-\d{2}/.test(dueOn)) return null;
  const days = daysUntil(dueOn.slice(0, 10), now);
  if (days < 0) return { text: `Overdue · ${dayLabel(dueOn)}`, overdue: true };
  if (days === 0) return { text: 'Due today', overdue: false };
  if (days === 1) return { text: 'Due tomorrow', overdue: false };
  return { text: `By ${dayLabel(dueOn)}`, overdue: false };
}

/** The same inside a sentence: "by Fri, Dec 5", "due today", "overdue since Tue, Dec 2"; null without a date. */
export function dueWords(dueOn: string | null, now: Date = new Date()): string | null {
  const due = dueState(dueOn, now);
  if (due === null || dueOn === null) return null;
  if (due.overdue) return `overdue since ${dayLabel(dueOn)}`;
  return `${due.text.charAt(0).toLowerCase()}${due.text.slice(1)}`;
}

/** A date as the plan and the story say it ("Dec 5, 2026"); the ISO day when it is not one. */
export function longDay(value: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(y, m - 1, d));
}
