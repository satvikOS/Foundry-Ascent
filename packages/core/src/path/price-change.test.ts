import { describe, expect, it } from 'vitest';

import { priceChange } from './price-change.js';

const text = (message: string, ...told: string[]) => priceChange(message, told)?.text ?? null;

describe('a change of price, with both prices known', () => {
  it('a raise: the share of the buyers it must keep, what it is for theirs, and the cost that is not known', () => {
    expect(
      text('Should I raise the price to 40? Yes or no.', 'Four sailing clubs pay 25 dollars a month.'),
    ).toBe(
      'Yes, for the next ones you ask, and leave the 4 who pay now at $25 until you know. $40 brings what $25 does when 5 of every 8 who would pay $25 still pay $40. Above that line it brings more, below it less. Of the 4 who pay now, 3 at $40 would bring $120 a month, against $100 today. What one costs you is not in this; any cost makes the line easier to beat.',
    );
    expect(text('Do I go from $12 to $15 a jar?')).toContain(
      '$15 brings what $12 does when 4 of every 5 who would pay $12 still pay $15.',
    );
    expect(text('Could I charge 30 instead of 20?')).toContain('2 of every 3 who would pay $20');
    // Not in small whole numbers: of ten, rounded up.
    expect(text('Should we raise it from 17 to 23?', 'The fee is 17 dollars.')).toContain(
      'about 8 of every 10 who would pay $17 still pay $23',
    );
  });

  it('a cost of one they told is taken off both', () => {
    expect(text('Should I raise the price to 14?', 'A bowl sells for $10 and costs me $4 to make.')).toBe(
      'Yes, for the next ones you ask, and leave the ones who pay now at $10 until you know. $14 brings what $10 does (after the $4 one costs you) when 3 of every 5 who would pay $10 still pay $14. Above that line it brings more, below it less.',
    );
  });

  it('a cut: how many more it has to win', () => {
    expect(text('Should I drop the price to 25?', 'I charge 40 dollars a month.')).toBe(
      'Not yet. At $25 it takes 8 buyers to bring what 5 bring at $40. So it pays only if it wins that many, and nobody has shown that it does. What one costs you is not in this; any cost makes the line harder to beat.',
    );
  });

  it.each([
    ['Should I raise the price to 40?', []],
    ['Should I raise the price to 40?', ['We charge 25 dollars.', 'We charge 30 dollars a box.']],
    ['I raised the price to 40.', ['I charge 25 dollars.']],
    ['Should I grow from 4 to 10 customers?', ['I charge 25 dollars.']],
    ['Do I raise it to 40 percent?', ['I charge 25 dollars.']],
    ['Should I go to 40 people next?', ['I charge 25 dollars.']],
    ['Should I raise the price?', ['I charge 25 dollars.']],
    ['Should I set it to 25?', ['I charge 25 dollars.']],
  ])('says nothing it is not sure of: %s %j', (message, told) => {
    expect(priceChange(message, told)).toBeNull();
  });

  it('is short on a call', () => {
    const made = priceChange('Do I raise the price to 40?', ['Four clubs pay 25 dollars a month.']);
    expect(made?.voice.split(' ').length).toBeLessThanOrEqual(50);
  });
});
