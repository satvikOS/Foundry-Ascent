import { describe, expect, it } from 'vitest';

import { assumptionPrompt, milestonePrompt, overduePrompt, quickActions } from './suggestions';

describe('quickActions (the context panel)', () => {
  it('offers three general openers without a goal, each with its mode', () => {
    const items = quickActions(null);
    expect(items.map((item) => item.label)).toEqual([
      'Find our riskiest assumption',
      'Poke holes in our plan',
      'Practise a pitch',
    ]);
    expect(items.map((item) => item.mode)).toEqual(['diagnose', 'challenge', 'rehearse']);
  });

  it('leads with planning toward the current goal, capped at three', () => {
    const items = quickActions('  Validate exam-week demand with 300 students ');
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: 'goal', label: 'Plan our next step' });
    expect(items[0]?.prompt).toBe(
      'Our current goal is: Validate exam-week demand with 300 students. What should we do next to get there?',
    );
  });

  it('never offers memory to review: what the mentor learns is kept without asking', () => {
    const items = quickActions('A goal');
    expect(items.some((item) => /memory|review|remember/i.test(item.label))).toBe(false);
  });
});

describe('row prompts', () => {
  it('turn what is due or tested into a first message', () => {
    expect(overduePrompt('Book five interviews')).toBe(
      '“Book five interviews” is overdue. Help me get it back on track.',
    );
    expect(milestonePrompt('Pilot in two libraries')).toBe(
      '“Pilot in two libraries” is coming up. What should we do to be ready?',
    );
    expect(assumptionPrompt('Students will pay')).toBe(
      'How could we test this assumption cheaply: “Students will pay”?',
    );
  });
});
