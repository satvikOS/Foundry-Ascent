import { describe, expect, it } from 'vitest';

import { makeMemory } from '@/features/coach/testing';

import { newChatSuggestions } from './suggestions';

const EMPTY = {
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
      ...EMPTY,
      overdueActions: [makeMemory({ title: 'Book five library-staff interviews', type: 'action' })],
      currentGoal: 'Validate exam-week demand with 300 students',
      openAssumptions: [makeMemory({ title: 'Students will pay for guaranteed seats', type: 'hypothesis' })],
      openEscalations: 1,
    });
    expect(items.map((item) => item.kind)).toEqual(['prompt', 'prompt', 'prompt', 'help']);
    expect(items[0]?.label).toBe('Overdue: Book five library-staff interviews');
    const goal = items[1];
    expect(goal?.kind === 'prompt' ? goal.prompt : '').toContain(
      'Validate exam-week demand with 300 students',
    );
    const test = items[2];
    expect(test?.kind === 'prompt' ? test.mode : undefined).toBe('challenge');
  });

  it('never offers memory to review: what the vEIR learns is kept without asking', () => {
    // An overview from an API that still counts memory suggestions: none becomes a chip.
    const overview = { ...EMPTY, pendingMemoryCount: 3 };
    const items = newChatSuggestions(overview);
    expect(items.map((item) => item.kind)).toEqual(['prompt', 'prompt', 'prompt']);
    expect(items.some((item) => /memory|review|remember/i.test(item.label))).toBe(false);
  });

  it('uses singular wording and tops up with openers', () => {
    const items = newChatSuggestions({ ...EMPTY, openEscalations: 1 });
    expect(items[0]?.label).toBe('1 open help request');
    expect(items).toHaveLength(3);
  });
});
