import { TurnGuidance, VenturePath } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { dueState } from './due';
import { laterItems, planAsText, planSources, planStory, reportedEvidence, stageLine, story } from './plan';
import { pathSuggestions, startChips } from './start';
import { supportingExcerpt } from './sources';
import { makeGuidance, makePath, makeStep, PATH_IDS } from './testing';
import { makeEvidence } from '../coach/testing';

const TODAY = new Date(2026, 10, 24, 10);

describe('fixtures', () => {
  it('are what the contract says (the e2e mocks answer with them)', () => {
    expect(VenturePath.parse(makePath())).toEqual(makePath());
    expect(TurnGuidance.parse(makeGuidance())).toEqual(makeGuidance());
  });
});

describe('dueState', () => {
  it('says a date the way a student reads it, and when it has passed', () => {
    expect(dueState('2026-11-24', TODAY)).toEqual({ text: 'Due today', overdue: false });
    expect(dueState('2026-11-25', TODAY)).toEqual({ text: 'Due tomorrow', overdue: false });
    expect(dueState('2026-12-04', TODAY)?.text).toMatch(/^By /);
    expect(dueState('2026-11-20', TODAY)).toMatchObject({ overdue: true });
    expect(dueState('2026-11-20', TODAY)?.text).toMatch(/^Overdue · /);
    expect(dueState(null, TODAY)).toBeNull();
    expect(dueState('soon', TODAY)).toBeNull();
  });
});

describe('the plan', () => {
  it('names the stage by its number, in plain words', () => {
    expect(stageLine(makePath())).toBe('Stage 2 of 7: Discovery');
  });

  it('reads the story oldest first, conversations only when asked for', () => {
    expect(story(makePath().arc).map((entry) => entry.kind)).toEqual(['origin', 'pivot', 'result']);
    expect(story(makePath().arc, { conversations: true }).map((entry) => entry.kind)).toEqual([
      'origin',
      'pivot',
      'result',
      'conversation',
    ]);
  });

  it('keeps the origin and the latest of a long story on the one page', () => {
    const arc = Array.from({ length: 30 }, (_, i) => ({
      id: `e${String(i)}`,
      kind: 'decision' as const,
      on: `2026-10-${String(i + 1).padStart(2, '0')}`,
      title: `Decision ${String(i)}`,
      detail: null,
      source: { kind: 'memory' as const, id: PATH_IDS.memory },
    }));
    const kept = planStory(arc);
    expect(kept).toHaveLength(10);
    expect(kept[0]?.id).toBe('e0');
    expect(kept.at(-1)?.id).toBe('e29');
  });

  it('lists later: the path’s later steps, what the stage still asks for, then the next stage', () => {
    expect(laterItems(makePath()).map((item) => item.title)).toEqual([
      'Ask two of them to pay',
      'What it costs them',
      'Then Validation',
    ]);
  });

  it('shows a criterion the evidence the founder reported for it, never a skipped step’s reason', () => {
    const path = makePath();
    expect(reportedEvidence(path, 'named-person').map((step) => step.evidence)).toEqual([
      'Dana in the chemistry building, every Monday.',
    ]);
    const skipped = makePath({
      done: [
        makeStep({ id: PATH_IDS.done, status: 'skipped', criterionId: 'x', evidence: 'No longer needed' }),
      ],
    });
    expect(reportedEvidence(skipped, 'x')).toEqual([]);
  });

  it('cites each source once', () => {
    expect(planSources(makePath())).toHaveLength(2);
  });

  it('copies as text a professor can read: stage, step, what follows, the story, sources and the disclosure', () => {
    const text = planAsText(makePath(), {
      ventureName: 'BenchTally',
      disclosure: 'AI, not a person.',
      now: TODAY,
    });
    expect(text.split('\n')[0]).toBe('BenchTally: plan');
    for (const line of [
      'Stage 2 of 7: Discovery',
      'Goal: Prove the problem happens often, to people you can reach.',
      '- [~] Five real stories: claimed. Five people described the last time it happened.',
      '- [ ] What it costs them: open. A number each of three people gave.',
      'Hear five lab managers describe the last time they ran out of a reagent',
      '1. [x] List 20 lab managers you can reach (Start with your own department.)',
      'Done when: Five people described the last time it happened, with dates.',
      '- Write down the three costs they named',
      '- The Mom Test, Chapter 3 (Rob Fitzpatrick) https://www.momtestbook.com/',
    ])
      expect(text.split('\n')).toContain(line);
    expect(text).toMatch(/^Now \(By /m);
    expect(text).toMatch(/pivot: From students to lab managers\. Managers hold the budget\./);
    expect(text.trim().endsWith('AI, not a person.')).toBe(true);
    // The story is in order.
    expect(text.indexOf('origin:')).toBeLessThan(text.indexOf('pivot:'));
  });
});

describe('pathSuggestions', () => {
  it('are the path’s own, with the current step named in what they start', () => {
    const all = pathSuggestions(makePath());
    expect(all.map((item) => item.label)).toEqual([
      'Continue: Hear five lab managers describe the last time they ran out of a reagent',
      'I finished it',
      'I’m stuck',
      'What should I do next?',
      'Help me get organised',
    ]);
    expect(all[1]?.prompt).toContain('Hear five lab managers');
    expect(startChips(makePath()).map((item) => item.id)).toEqual([
      'path-continue',
      'path-finished',
      'path-stuck',
    ]);
  });

  it('without a step, offer the two ways to a plan', () => {
    expect(startChips(makePath({ now: null })).map((item) => item.label)).toEqual([
      'What should I do next?',
      'Help me get organised',
    ]);
  });
});

describe('supportingExcerpt', () => {
  it('is the passage the reply retrieved from that source, and none from another', () => {
    const evidence = [
      makeEvidence({
        key: 'E1',
        title: 'The Mom Test: talking to customers',
        excerpt: 'Ask about the past.',
      }),
    ];
    expect(supportingExcerpt({ title: 'The Mom Test' }, evidence)).toBe('Ask about the past.');
    expect(supportingExcerpt({ title: 'Lean Analytics' }, evidence)).toBeNull();
  });
});
