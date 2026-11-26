import { describe, expect, it } from 'vitest';

import { ungroundedFigures } from './figures.js';

/** A kiln studio of an invented student: what figures of a reply rest on. */
const FOUNDER = 'Two of 14 students waited a day. The kiln is $40 a week.';
const KNOWN = `${FOUNDER}\nOne firing uses 6 shelves.`;
const of = (unit: string, shownText = ''): string[] =>
  ungroundedFigures(unit, { known: KNOWN, shownText, founder: FOUNDER });

describe('figures a reply may state', () => {
  it('theirs, and arithmetic on what the reply shows, stand; a chain builds on itself', () => {
    expect(of('A second kiln is $40 a week more, $160 a month.')).toEqual([]);
    expect(of('Two of 14 is about 14% of them.')).toEqual([]);
    expect(of('Six shelves a firing, so 24 shelves for 4 firings.')).toEqual([]);
  });

  it('a number nobody gave, as an example, a range or a bar, does not', () => {
    expect(of('Say the town has 1,000 potters.')).toEqual(['1,000']);
    expect(of('That is 200–500 people a building.')).toEqual(['200', '500']);
    expect(of('If the next firing hits 60% again, rent it.')).toEqual(['60%']);
    expect(of('Charge $55 a class.')).toEqual(['$55']);
  });

  it('days, years, small counts and list numbers are no figures', () => {
    expect(of('By November 30, in 2026, ask 3 of them.')).toEqual([]);
  });
});
