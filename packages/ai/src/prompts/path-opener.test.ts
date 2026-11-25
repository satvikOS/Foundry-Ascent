import { describe, expect, it } from 'vitest';

import { isJudgmentalNote, withoutPressure } from '../distill/judgment.js';
import { offersHelp } from '../distill/sanitize.js';
import { pathOpener } from './path-opener.js';

const TODAY = '2026-11-24'; // a Tuesday
const opener = (
  dueOn: string | null,
  next: string | null = 'Book two calls',
  seed = 's1',
  name: string | null = null,
) =>
  pathOpener({
    step: { title: 'Email the theatre society.', dueOn },
    next,
    today: TODAY,
    founderFirstName: name,
    seed,
  });

describe('the opener of a path with a step', () => {
  it.each([
    [
      '2026-11-23',
      'You were going to email the theatre society by yesterday. Did it happen? If it did, next is to book two calls; if not, we can make it smaller.',
    ],
    ['2026-11-19', 'You were going to email the theatre society by Thursday. Did it happen?'],
    ['2026-11-03', 'You were going to email the theatre society by November 3. Did it happen?'],
    ['2026-11-24', 'Your step is to email the theatre society, due today.'],
    ['2026-11-25', 'Your step is to email the theatre society, due tomorrow.'],
    ['2026-11-27', 'Your step is to email the theatre society, due Friday.'],
  ])('due %s: names it and its due state', (dueOn, said) => {
    expect(opener(dueOn)).toContain(said);
  });

  it('says no day when there is none, and the next one is optional', () => {
    expect(opener(null)).toContain('Your step is to email the theatre society. Is it done, or under way?');
    expect(opener('2026-11-23', null)).toContain(
      'If it did, I have the next step; if not, we can make it smaller.',
    );
  });

  it('never judges or presses, offers help, stays short and names them at most once', () => {
    for (const due of ['2026-11-01', '2026-11-23', '2026-11-24', '2026-11-30', null]) {
      for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
        const line = opener(due, 'Book two calls', seed, 'Priya');
        expect(isJudgmentalNote(line)).toBe(false);
        expect(withoutPressure(line)).toBe(line);
        expect(line).not.toMatch(/overdue|late|missed|still open|should have|fail/i);
        expect(line.split(/\s+/).length).toBeLessThanOrEqual(42);
        expect(line.match(/Priya/g)).toHaveLength(1);
        expect((line.match(/\?/g) ?? []).length).toBeLessThanOrEqual(2);
      }
    }
    expect(offersHelp(opener('2026-11-27'))).toBe(true);
  });

  it('is the same for the same conversation and varies across conversations', () => {
    expect(opener('2026-11-27')).toBe(opener('2026-11-27'));
    expect(
      new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => opener('2026-11-27', null, s))).size,
    ).toBeGreaterThan(1);
  });

  it('cuts a very long title and keeps an acronym', () => {
    const long = pathOpener({
      step: { title: `IRB ${'word '.repeat(60)}`, dueOn: null },
      next: null,
      today: TODAY,
      seed: 'x',
    });
    expect(long).toContain('to IRB word');
    expect(long.split(/\s+/).length).toBeLessThan(45);
  });
});
