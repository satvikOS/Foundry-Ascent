import { describe, expect, it } from 'vitest';

import { makeMemory } from '@/features/knowledge/testing';

import { addDays, canActOnDue, doneAction, localIsoDay, restoreAction, snoozeAction } from './due-actions';

describe('due actions', () => {
  const action = makeMemory({
    type: 'action',
    status: 'confirmed',
    attributes: { owner: 'Maya', due: '2026-10-01', status: 'open' },
  });
  const milestone = makeMemory({
    type: 'milestone',
    status: 'confirmed',
    attributes: { target_date: '2026-12-20', status: 'planned' },
  });

  it('marks an item done and keeps its other attributes', () => {
    expect(doneAction(action)).toEqual({
      action: 'correct',
      patch: { attributes: { owner: 'Maya', due: '2026-10-01', status: 'done' } },
      reason: 'Marked done',
    });
  });

  it('snoozes an overdue action a week from today, and a coming milestone a week from its date', () => {
    expect(snoozeAction(action, '2026-11-06')).toMatchObject({
      patch: { attributes: { owner: 'Maya', due: '2026-11-13', status: 'open' } },
    });
    expect(snoozeAction(milestone, '2026-11-06')).toMatchObject({
      patch: { attributes: { target_date: '2026-12-27', status: 'planned' } },
    });
    // No date yet: from today.
    expect(snoozeAction(makeMemory({ type: 'action', attributes: {} }), '2026-11-06')).toMatchObject({
      patch: { attributes: { due: '2026-11-13' } },
    });
    expect(snoozeAction(makeMemory({ type: 'decision' }), '2026-11-06')).toBeNull();
  });

  it('puts an item back exactly as it was', () => {
    expect(restoreAction(action)).toEqual({
      action: 'correct',
      patch: { attributes: { owner: 'Maya', due: '2026-10-01', status: 'open' } },
      reason: 'Undone',
    });
  });

  it('offers Done and Snooze only on kept actions and milestones', () => {
    expect(canActOnDue(action)).toBe(true);
    expect(canActOnDue(milestone)).toBe(true);
    expect(canActOnDue({ ...action, status: 'proposed' })).toBe(false);
    expect(canActOnDue({ ...action, type: 'decision' })).toBe(false);
  });

  it('counts calendar days across months, years and daylight-saving changes', () => {
    expect(addDays('2026-12-29', 7)).toBe('2027-01-05');
    expect(addDays('2026-03-05', 7)).toBe('2026-03-12');
    expect(addDays('2026-10-30T23:00:00.000Z', 7)).toBe('2026-11-06');
    expect(localIsoDay(new Date(2026, 0, 9, 23, 30))).toBe('2026-01-09');
  });
});
