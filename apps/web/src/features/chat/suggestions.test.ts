import { describe, expect, it } from 'vitest';

import { makeMemory } from '@/features/coach/testing';

import { newChatSuggestions } from './suggestions';

const EMPTY = {
  pendingMemoryCount: 0,
  overdueActions: [],
  currentGoal: null,
  openAssumptions: [],
  openEscalations: 0,
};

describe('newChatSuggestions', () => {
  it('falls back to general openers without venture data', () => {
    const items = newChatSuggestions(null);
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.kind === 'prompt')).toBe(true);
  });

  it('leads with what needs the founder, capped at four', () => {
    const items = newChatSuggestions({
      pendingMemoryCount: 2,
      overdueActions: [makeMemory({ title: 'Book five library-staff interviews', type: 'action' })],
      currentGoal: 'Validate exam-week demand with 300 students',
      openAssumptions: [makeMemory({ title: 'Students will pay for guaranteed seats', type: 'hypothesis' })],
      openEscalations: 1,
    });
    expect(items.map((item) => item.kind)).toEqual(['review', 'prompt', 'prompt', 'prompt']);
    expect(items[0]?.label).toBe('Review 2 memory suggestions');
    expect(items[1]?.label).toBe('Overdue: Book five library-staff interviews');
    const goal = items[2];
    expect(goal?.kind === 'prompt' ? goal.prompt : '').toContain(
      'Validate exam-week demand with 300 students',
    );
    const test = items[3];
    expect(test?.kind === 'prompt' ? test.mode : undefined).toBe('challenge');
  });

  it('uses singular wording and tops up with openers', () => {
    const items = newChatSuggestions({ ...EMPTY, pendingMemoryCount: 1, openEscalations: 1 });
    expect(items.map((item) => item.label).slice(0, 2)).toEqual([
      'Review 1 memory suggestion',
      '1 open help request',
    ]);
    expect(items).toHaveLength(3);
  });
});
