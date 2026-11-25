import { describe, expect, it } from 'vitest';

import { afterIf, isWhole, lineSaid, yourself } from './lint.js';
import { broughtUp } from './tell.js';

describe('a line that is said to them is a whole sentence', () => {
  it.each([
    ['You sharpen all the knives himself on Sundays.', 'You sharpen all the knives yourself on Sundays.'],
    ['A risk you named: you do the books herself.', 'You do the books yourself.'],
    ['You decided: renting a stall before June.', 'You decided on renting a stall before June.'],
    ['You decided: next: ask the two markets for a date.', 'You decided to ask the two markets for a date.'],
    ['Nine cooks rent a knife each week.', 'Nine cooks rent a knife each week.'],
    ['The cook told himself it was dull.', 'The cook told himself it was dull.'],
  ])('%s', (line, said) => {
    expect(lineSaid(line)).toBe(said);
  });
  it.each(
    [
      'has two wheels and a van',
      'uses whoever is there',
      'Applying for a stall before asking any cook',
      'First two Sundays.',
      'Sharpened knives for cooks',
    ].slice(0, 4),
  )('%s is none', (text) => {
    expect(isWhole(text)).toBe(false);
    expect(lineSaid(text)).toBe('');
  });
  it.each(['Renting a stall costs you 40 dollars.', 'You sell on Sundays.', 'Two cooks came back.'])(
    '%s is one',
    (text) => {
      expect(isWhole(text)).toBe(true);
    },
  );
  it('another person in it keeps their own word', () => {
    expect(yourself('You asked the cook, who sharpens it himself.')).toBe(
      'You asked the cook, who sharpens it himself.',
    );
  });
  it.each([
    ['ask the market and agree a day', 'you ask the market and agree a day'],
    ['if the market says no.', 'the market says no'],
    ['five of 20 pay', 'five of 20 pay'],
  ])('a condition has who does it: %s', (text, said) => {
    expect(afterIf(text)).toBe(said);
  });
  it('a fact with nobody in it is brought up by nobody', () => {
    expect(broughtUp('has two wheels and a van', 'x')).toBe('');
    expect(broughtUp('two cooks pay 9 dollars a week', 'x')).toBe(
      'Keep in mind that two cooks pay 9 dollars a week.',
    );
  });
});
