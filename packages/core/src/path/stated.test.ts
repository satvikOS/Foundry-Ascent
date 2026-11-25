import { describe, expect, it } from 'vitest';

import { meIn, todayIn, whoIn } from './stated.js';

describe('who an idea is for, in its own words', () => {
  it.each([
    [
      'LoamLink pairs gardeners who have too much compost with neighbours who need some',
      'gardeners who have too much compost and neighbours who need some',
    ],
    ['ChoirBox would let amateur choirs swap sheet music', 'amateur choirs'],
    [
      'lends tripods to student musicians who film their own concerts',
      'student musicians who film their own concerts',
    ],
    ['helps small museums label their stores', 'small museums'],
    ['sell sourdough starters to cafes and bakeries', 'cafes and bakeries'],
    ['a bedtime radio show for tired parents', 'tired parents'],
  ])('%s: %s', (idea, who) => {
    expect(whoIn(idea)).toBe(who);
  });

  it.each([
    'a lamp that dims with the room',
    'mends chairs that students leave on the street',
    'lets people list spare bricks',
    'study notes written by students who sat the exam',
    'weekly surprise seed packets',
  ])('nobody is named: %s', (idea) => {
    expect(whoIn(idea)).toBeNull();
  });
});

describe('what people do now, and what they themselves do', () => {
  it('is as they told it, and nothing of a plan, a question or a wish', () => {
    expect(todayIn(['Right now they leave notes on a board and hope.'])).toBe(
      'they leave notes on a board and hope',
    );
    expect(todayIn(['Now people will love it.', 'What do they do now?', 'Today I ask five of them.'])).toBe(
      null,
    );
    expect(meIn(['I coach the rowing club on weekends, and I want to sell oars.'])).toBe(
      'I coach the rowing club on weekends',
    );
    expect(meIn(['I work on it alone.', 'Could I work at the boathouse?', 'I will teach there.'])).toBe(null);
  });
});
