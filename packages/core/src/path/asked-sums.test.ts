import { describe, expect, it } from 'vitest';

import { coverAsked, worthAsked } from './asked-sums.js';

const s = (message: string, record: string[] = [], earlier: string[] = []) => ({ message, record, earlier });

describe('a figure they ask for that nobody worked out', () => {
  it('what an offer implies, from this message or one before', () => {
    expect(worthAsked(s('she put 20k on the table for 5%, what is that worth all together'))).toMatchObject({
      value: 400_000,
      said: '$400,000',
      working: '$20,000 ÷ 0.05',
      asked: true,
    });
    expect(
      worthAsked(
        s('and what would it value the workshop at?', [], ['my aunt offered $3,000 for 10 percent']),
      ),
    ).toMatchObject({ value: 30_000 });
  });
  it.each([
    'is it worth my time',
    'she offered 20k for 5%, do I take it',
    'what is it worth to sell 20 for 10% off',
    'is the whole thing worth it',
  ])('none: %s', (message) => {
    expect(worthAsked(s(message))).toBeNull();
  });

  const RECORD = [
    'A lamp sells for 40 dollars; wire is 6 and the shade 4.',
    'The workshop charges 90 dollars a day for the table.',
  ];
  it('how many cover a cost, rounded up, with every cost of one', () => {
    expect(
      coverAsked(
        s('whats the fewest lamps so i am not paying to be there', [
          'A lamp sells for 40 dollars; wire is 6 dollars, the shade 4 dollars; the hall charges 90 dollars a day.',
        ]),
        '',
      ),
    ).toMatchObject({
      value: 3,
      said: '3 lamps',
      working: '$90 ÷ ($40 − $6 − $4)',
    });
  });
  it('what a thing cost once, at the price they say', () => {
    expect(
      coverAsked(
        s('at 25 each, when is the 600 back', ['Parts are 10 dollars a unit; a press is 600 dollars once.']),
        'when the press is paid back',
      ),
    ).toMatchObject({ value: 40, working: '$600 ÷ ($25 − $10)' });
  });
  it.each([
    [s('how do i break even', []), ''],
    [s('what do i keep', RECORD), ''],
    [
      s('the fewest so i do not lose, they pay 5 each', [
        'Wire is 6 dollars a lamp, the press is 600 dollars once.',
      ]),
      '',
    ],
  ] as const)('none where a number is missing, or it can be read two ways', (source, ask) => {
    expect(coverAsked(source, ask)).toBeNull();
  });
});
