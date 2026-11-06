import type { MemoryAction, MemoryObjectView } from '@foundry/contracts';

/*
 * Done and Snooze on what is due (the context panel's Due section). Both are ordinary corrections of the item, so
 * they land in its history like any edit and the vEIR reads the new state: an action or a milestone marked done
 * leaves the list, and a snoozed one moves its date a week on (from today when it is already overdue).
 */

/** Days a Snooze moves an item's date. */
export const SNOOZE_DAYS = 7;

/** The date field each kind of due item keeps. */
const DATE_FIELD = { action: 'due', milestone: 'target_date' } as const;

type DueType = keyof typeof DATE_FIELD;

export function isDueType(type: string): type is DueType {
  return type === 'action' || type === 'milestone';
}

/** Today in the person's own time zone, as YYYY-MM-DD. */
export function localIsoDay(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/** `iso` (YYYY-MM-DD) moved by `days`, calendar days in UTC (no time zone can skip or repeat one). */
export function addDays(iso: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** Whether the person can mark it done or snooze it here (a suggestion still waiting is kept first, in Knowledge). */
export function canActOnDue(item: Pick<MemoryObjectView, 'type' | 'status'>): boolean {
  return isDueType(item.type) && item.status !== 'proposed';
}

/** The correction that marks a due item done (its other attributes are kept as they are). */
export function doneAction(item: Pick<MemoryObjectView, 'attributes'>): MemoryAction {
  return {
    action: 'correct',
    patch: { attributes: { ...item.attributes, status: 'done' } },
    reason: 'Marked done',
  };
}

/** The correction that moves a due item's date a week on, from its date or from today if that has passed. */
export function snoozeAction(
  item: Pick<MemoryObjectView, 'type' | 'attributes'>,
  today: string = localIsoDay(),
  days: number = SNOOZE_DAYS,
): MemoryAction | null {
  if (!isDueType(item.type)) return null;
  const field = DATE_FIELD[item.type];
  const current = item.attributes[field];
  const from =
    typeof current === 'string' && /^\d{4}-\d{2}-\d{2}/.test(current) && current >= today ? current : today;
  return {
    action: 'correct',
    patch: { attributes: { ...item.attributes, [field]: addDays(from, days) } },
    reason: `Snoozed ${String(days)} days`,
  };
}

/** The correction that puts a done or snoozed item back as it was (Undo, on the version the change made). */
export function restoreAction(before: Pick<MemoryObjectView, 'attributes'>): MemoryAction {
  return { action: 'correct', patch: { attributes: { ...before.attributes } }, reason: 'Undone' };
}
