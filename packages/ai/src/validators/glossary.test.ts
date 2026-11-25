import { describe, expect, it } from 'vitest';

import { termsIn, withMeanings } from './glossary.js';

describe('business words for who never did this', () => {
  it('the meaning is said once, after the first use', () => {
    expect(withMeanings('Set a pass line. The pass line is yours.', new Set())).toBe(
      'Set a pass line (the number that means it worked, set before you start). The pass line is yours.',
    );
    const known = new Set<string>();
    withMeanings('Write the value proposition.', known);
    expect(withMeanings('Show the value proposition.', known)).toBe('Show the value proposition.');
  });

  it('jobs, pains and gains are told in plain words', () => {
    expect(withMeanings('List jobs, pains and gains.', new Set())).toBe(
      'List jobs, pains and gains (what they try to do, what hurts, what they want).',
    );
  });

  it('on a call it is said, not bracketed', () => {
    expect(withMeanings('Know your runway before you sign.', new Set(), true)).toBe(
      'Know your runway, how long the money lasts, before you sign.',
    );
  });

  it('leaves a word that already says its meaning', () => {
    for (const text of [
      'A pass line (the number that means it worked) comes first.',
      'Runway is how long the money lasts.',
      'Runway: the months you have left.',
      'That is called churn.',
    ])
      expect(withMeanings(text, new Set()), text).toBe(text);
  });

  it('keeps bold and ten words at most', () => {
    expect(withMeanings('Find the **beachhead** now.', new Set())).toBe(
      'Find the **beachhead** (the first small group you win) now.',
    );
    for (const word of [
      'MVP',
      'churn',
      'runway',
      'cap table',
      'vesting',
      'TAM',
      'unit economics',
      'pass line',
    ]) {
      const meaning = /\((.+?)\)/.exec(withMeanings(`${word} matters`, new Set()))?.[1] ?? '';
      expect(meaning, word).not.toBe('');
      expect(meaning.split(' ').length, word).toBeLessThanOrEqual(10);
    }
  });

  it('knows what a text used already', () => {
    expect([...termsIn('Your MVP and the term sheet')].sort()).toEqual(['mvp', 'term sheet']);
    expect(termsIn('We drew up a plan').size).toBe(0);
  });
});
