import { describe, expect, it } from 'vitest';

import { saidSentences, saysAgain, unsaidOf } from './said-before.js';

// Synthetic wording of what two live runs showed: paragraphs given twice, inside one reply and from one to the next.
const REPLY =
  'Sell the first ten lamps yourself, one at a time, to people you can name. Write down how each buyer found the lamps. Offer it at 40 dollars, not 30.\n\n**Next:** List 20 names by Friday. Done when 20 names are written.';
const said = saidSentences(REPLY);

describe('a sentence an earlier one said', () => {
  it.each([
    'Sell the first ten lamps yourself, one at a time, to people you can name.',
    'So sell the first ten lamps yourself, one by one, to people you can name.',
    'Also, write down how each buyer found your lamps.',
    'Offer it at 40 dollars and not 30.',
  ])('%s', (unit) => {
    expect(saysAgain(unit, said)).toBe(true);
  });

  it.each([
    // Another figure, another yes or no, another thing.
    'Offer it at 45 dollars, not 30.',
    'Do not write down how each buyer found the lamps.',
    'Sell the next ten lamps through the two shops that asked for them.',
    'Write it down.',
    // The step line is the same on every turn, and an item of a list is never left out of it.
    'List 20 names by Friday.',
    '- Write down how each buyer found the lamps.',
  ])('%s is none', (unit) => {
    expect(saysAgain(unit, said)).toBe(false);
  });

  it('a line in quotes again, whatever leads into it', () => {
    const quoted = saidSentences('They will ask about money: "Only 12 lamps: who pays for the next ones?"');
    expect(saysAgain('The first one for you: "Only 12 lamps: who pays for the next ones?"', quoted)).toBe(
      true,
    );
    expect(saysAgain('The first one for you: "What does one lamp cost you to make?"', quoted)).toBe(false);
  });

  it('what is not said yet of a text stands on its own', () => {
    expect(
      unsaidOf('Write down how each buyer found the lamps. Then list 50 more of the same kind.', said),
    ).toBe('List 50 more of the same kind.');
    expect(unsaidOf('Write down how each buyer found the lamps.', said)).toBe('');
  });
});
