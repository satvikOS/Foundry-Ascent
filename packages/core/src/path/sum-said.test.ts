import { describe, expect, it } from 'vitest';

import { sumSaid, type SumContext } from './sum-said.js';
import { sumOf } from './testing/understood.js';

const said = (over: Parameters<typeof sumOf>[0], c: SumContext = {}): string => {
  const s = sumSaid(sumOf(over), c);
  return [s.text, s.aside].filter((x) => x !== '').join(' ');
};

describe('a figure as a mentor says it', () => {
  const money = { unit: '$' as const, value: 42, said: '$42', working: '6 × $7' };
  it.each([
    ['what you keep on a Saturday', 'You keep $42 on a Saturday: 6 × $7.'],
    ['what you would charge per lamp', 'You would charge $42 per lamp: 6 × $7.'],
    ['what you are paid an hour', 'You are paid $42 an hour: 6 × $7. That is before any cost comes off.'],
    ['what comes in at the fair', '$42 comes in at the fair: 6 × $7. That is before any cost.'],
    ['what is left after the wire', '$42 is left after the wire: 6 × $7.'],
    ['what the fair left you', 'The fair left you $42: 6 × $7.'],
    ['what one lamp leaves', 'One lamp leaves $42: 6 × $7.'],
    ['what the workshop costs a month', 'The workshop costs $42 a month: 6 × $7.'],
    ['what Ines paid in March', 'Ines paid $42 in March: 6 × $7.'],
    ['what it comes to', 'It comes to $42: 6 × $7.'],
    ['what the lamp is worth', 'The lamp is worth $42: 6 × $7.'],
    ['how much money you have left', 'You have $42 left: 6 × $7.'],
    ['how much the shop keeps', 'The shop keeps $42: 6 × $7.'],
    ['the profit per lamp', 'The profit per lamp comes to $42: 6 × $7.'],
    ['direct costs of the fair', 'Direct costs of the fair come to $42: 6 × $7.'],
    ['', 'That comes to $42: 6 × $7.'],
  ])('%s: %s', (label, text) => {
    expect(said({ ...money, label })).toBe(text);
  });

  it.each([
    ['how many lamps you must sell', '8 lamps', '$56 ÷ $7', 'You must sell 8 lamps: $56 ÷ $7.'],
    ['how many you need to break even', '8', '$56 ÷ ($9 − $2)', 'You need 8 to break even: $56 ÷ ($9 − $2).'],
    [
      'lamps needed to earn back the 560',
      '80',
      '$560 ÷ $7',
      'You need 80 lamps to earn back the $560: $560 ÷ $7. That leaves out what each one costs you to make, so the real number is higher.',
    ],
    [
      'the number of lamps to cover the rent',
      '8',
      '$56 ÷ ($9 − $2)',
      'You need 8 lamps to cover the rent: $56 ÷ ($9 − $2).',
    ],
    [
      'the fewest lamps that cover the table',
      '8 lamps',
      '$56 ÷ ($9 − $2)',
      'The fewest that cover the table is 8 lamps: $56 ÷ ($9 − $2).',
    ],
    ['break-even', '8 lamps', '$56 ÷ ($9 − $2)', 'You break even at 8 lamps: $56 ÷ ($9 − $2).'],
  ])('a count: %s', (label, n, working, text) => {
    expect(said({ label, unit: 'units', value: 8, said: n, working })).toBe(text);
  });

  it('a difference is in the unit of what it was taken from, and no word is said twice', () => {
    const s = {
      label: 'how much shorter the drying is',
      unit: 'units' as const,
      value: 14,
      said: '14 drying',
      working: '50 − 36',
    };
    expect(said(s, { texts: ['The drying fell from 50 to 36 minutes.'] })).toBe(
      'The drying is 14 minutes shorter: 50 − 36.',
    );
    expect(said({ ...s, said: '14 minutes' })).toBe('The drying is 14 minutes shorter: 50 − 36.');
  });

  it('months, shares and what they rest on', () => {
    expect(
      said({
        label: 'how long the cash lasts',
        unit: 'months',
        value: 5,
        said: '5 months',
        working: '$600 ÷ $120',
      }),
    ).toBe(
      'The cash lasts 5 months: $600 ÷ $120. That holds only while nothing new comes in and you spend the same.',
    );
    expect(
      said({ label: 'the share that came back', unit: '%', value: 25, said: '25%', working: '3 ÷ 12' }),
    ).toBe('25% came back: 3 ÷ 12. Out of only 12, one more or less moves it by 8 points.');
  });

  it('what an offer implies is said as that, with the share as it is', () => {
    expect(
      said(
        {
          label: 'what the whole workshop is worth',
          value: 400_000,
          said: '$400,000',
          working: '$20,000 ÷ (5% ÷ 100)',
        },
        { worth: true },
      ),
    ).toBe(
      'On paper that makes the whole workshop worth $400,000: $20,000 ÷ 0.05. That is what one offer implies, not a price anyone else has agreed to.',
    );
  });

  it('a loss is a loss', () => {
    expect(
      said({ label: 'what you keep a month', value: -15, said: '-$15', working: '3 × $7 − $36' }),
    ).toMatch(/^You lose \$15 a month: 3 × \$7 − \$36\./);
  });

  it('never "is is", and the figure is always there', () => {
    for (const label of [
      'how much better the second lamp is is',
      'what',
      'how much',
      'what the',
      'whether it pays',
      'left over',
      'money for you, the maker and the shop after all of it is paid and the van is back',
      'how many',
      'what she said it would be worth to them if it worked',
    ]) {
      const text = said({ ...money, label });
      expect(text, label).toContain('$42');
      expect(text, label).not.toMatch(/\b(is|are|was) \1\b/);
    }
  });

  it('on a call it is one sentence anyone can follow', () => {
    expect(sumSaid(sumOf({ ...money, label: 'what comes in at the fair' })).voice).toBe(
      '$42 comes in at the fair, 6 times $7.',
    );
    expect(sumSaid(sumOf()).voice).toBe('The market day left you $187.50.');
  });
});
