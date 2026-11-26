import { describe, expect, it } from 'vitest';

import { conversationCraftRules } from '../prompts/craft.js';
import { guidanceText, type PromptGuidance } from '../prompts/guidance.js';
import { STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { markedSum } from '../testing/path-reply.js';
import { buildSupportIndex, withoutSpan } from './citation-support.js';
import { validateCoachResponse } from './coach-response.js';
import { SentenceGate, type SentenceGateOptions } from './sentence-gate.js';
import { SumFacts, spelledAsDigits, sumsText, sumsUnit } from './sums.js';

/** A synthetic founder's numbers. */
const KNOWN =
  'A lamp sells for 26 dollars; the wire is 7 dollars, the shade 4 and the plug 2. A stall costs 95 dollars. ' +
  'I sold 20 lamps. 8 of 40 people bought. Nineteen clubs paid 15 dollars a month, five cancelled. The app takes 40 percent. ' +
  'A trip is 9 dollars, the rider gets 6 and the payment fee is 50 cents. Posters were 36 dollars and 3 ordered, of 80 posters.';

const said = (unit: string, spoken = false, known = KNOWN, earlier: string[] = []): string => {
  const facts = new SumFacts(known, earlier);
  const out = sumsUnit(unit, facts, { spoken, cut: withoutSpan });
  expect(out.text, unit).not.toMatch(/\[\[|\]\]/);
  // Read again, it stays as it is.
  const again = sumsUnit(out.text, facts, { spoken, cut: withoutSpan });
  expect(again.text, unit).toBe(out.text);
  return out.text;
};

describe('a sum in a marker, worked out', () => {
  it.each([
    [
      'You keep [[26 - 7 - 4 - 2 dollars]] a lamp.',
      'You keep 26 - 7 - 4 - 2 = 13 dollars a lamp.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars a lamp.',
    ],
    [
      'You keep [[26 - 7 - 4 - 2]] dollars a lamp.',
      'You keep 26 - 7 - 4 - 2 = 13 dollars a lamp.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars a lamp.',
    ],
    ['You keep $[[26 - 7 - 4 - 2]] a lamp.', 'You keep $13 a lamp.', 'You keep $13 a lamp.'],
    [
      'You keep [[$26 - $7 - $4 - $2]] a lamp.',
      'You keep 26 - 7 - 4 - 2 = $13 a lamp.',
      'You keep 26 minus 7 minus 4 minus 2, so $13 a lamp.',
    ],
    [
      'You keep [[26 price - 7 wire - 4 shade - 2 plug dollars]].',
      'You keep 26 - 7 - 4 - 2 = 13 dollars.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars.',
    ],
    [
      'You keep [[26 minus 7 minus 4 minus 2 dollars]].',
      'You keep 26 - 7 - 4 - 2 = 13 dollars.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars.',
    ],
    [
      'You keep [[26 − 7 – 4 - 2 dollars]].',
      'You keep 26 - 7 - 4 - 2 = 13 dollars.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars.',
    ],
    [
      'You keep [[sum: 26 - 7 - 4 - 2 dollars]].',
      'You keep 26 - 7 - 4 - 2 = 13 dollars.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars.',
    ],
    // A result the model worked out all the same is not read.
    [
      'You keep [[26 - 7 - 4 - 2 = 12 dollars]].',
      'You keep 26 - 7 - 4 - 2 = 13 dollars.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars.',
    ],
    [
      'You keep [[26 - 7 - 4 - 2]] = 12 dollars.',
      'You keep 26 - 7 - 4 - 2 = 13 dollars.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars.',
    ],
    [
      'You keep [26 - 7 - 4 - 2 dollars] a lamp.',
      'You keep 26 - 7 - 4 - 2 = 13 dollars a lamp.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars a lamp.',
    ],
    [
      'So 26 - 7 - 4 - 2 = [[26 - 7 - 4 - 2 dollars]].',
      'So 26 - 7 - 4 - 2 = 13 dollars.',
      'So 26 - 7 - 4 - 2 = 13 dollars.',
    ],
    // Money with cents.
    [
      'A trip leaves [[9 - 6 - 0.50 dollars]].',
      'A trip leaves 9 - 6 - 0.50 = $2.50.',
      'A trip leaves 9 minus 6 minus 0.50, so $2.50.',
    ],
    [
      'A trip leaves [[9 - 6 - 50 cents]].',
      'A trip leaves 9 - 6 - 0.50 = $2.50.',
      'A trip leaves 9 minus 6 minus 0.50, so $2.50.',
    ],
    [
      'A trip leaves [[9 dollars - 6 dollars - 50 cents]].',
      'A trip leaves 9 - 6 - 0.50 = $2.50.',
      'A trip leaves 9 minus 6 minus 0.50, so $2.50.',
    ],
    // So many, brackets, what is heard one way only.
    [
      'Left: [[20 * (26 - 7 - 4 - 2) - 95 dollars]].',
      'Left: 20 x (26 - 7 - 4 - 2) - 95 = 165 dollars.',
      'Left: 20 times 13 minus 95, so 165 dollars.',
    ],
    [
      'It is [[(19 - 5) x 15 dollars a month]].',
      'It is (19 - 5) x 15 = 210 dollars a month.',
      'It is 14 times 15, so 210 dollars a month.',
    ],
    [
      'It is [[(19-5)x15]] dollars a month.',
      'It is (19 - 5) x 15 = 210 dollars a month.',
      'It is 14 times 15, so 210 dollars a month.',
    ],
    // Shares.
    [
      'You lost [[5 / 19 percent]] of them.',
      'You lost 5 of 19 = 26.3% of them.',
      'You lost 5 of 19, so 26.3 percent of them.',
    ],
    [
      'You lost [[5 of 19 as a percentage]].',
      'You lost 5 of 19 = 26.3%.',
      'You lost 5 of 19, so 26.3 percent.',
    ],
    [
      'You lost [[5 / 19]]% of them.',
      'You lost 5 of 19 = 26.3% of them.',
      'You lost 5 of 19, so 26.3% of them.',
    ],
    [
      'You lost [[5 / 19 * 100 percent]].',
      'You lost 5 / 19 x 100 = 26.3%.',
      'You lost 5 divided by 19 times 100, so 26.3 percent.',
    ],
    ['That is [[3 / 80 percent]].', 'That is 3 of 80 = 3.75%.', 'That is 3 of 80, so 3.75 percent.'],
    [
      'You keep [[100 - 40 percent]] of it.',
      'You keep 100 - 40 = 60% of it.',
      'You keep 100 minus 40, so 60 percent of it.',
    ],
    [
      'The app takes [[26 * 40% dollars]].',
      'The app takes 26 x 40% = $10.40.',
      'The app takes 26 times 40 percent, so $10.40.',
    ],
    // A price that keeps a share.
    [
      'Charge [[7 / (1 - 40%) dollars]].',
      'Charge 7 / (1 - 40%) = $11.67.',
      'Charge 7 divided by 0.60, so $11.67.',
    ],
    ['Charge [[7 / 0.6 dollars]].', 'Charge 7 / 0.6 = $11.67.', 'Charge 7 divided by 0.6, so $11.67.'],
    // Counts that must cover something are whole, and others are not.
    [
      'You need [[95 / 26 lamps]] to cover the stall.',
      'You need 95 / 26 = 3.7, so 4 lamps to cover the stall.',
      'You need 95 divided by 26, so 4 lamps to cover the stall.',
    ],
    [
      'That is [[95 / 26 lamps]].',
      'That is 95 / 26 = about 3.7 lamps.',
      'That is 95 divided by 26, so about 3.7 lamps.',
    ],
    [
      'It lasts [[95 / 15 months]].',
      'It lasts 95 / 15 = about 6.3 months.',
      'It lasts 95 divided by 15, so about 6.3 months.',
    ],
    // Plain constants only multiply and divide.
    [
      'A year is [[15 * 12 dollars]].',
      'A year is 15 x 12 = 180 dollars.',
      'A year is 15 times 12, so 180 dollars.',
    ],
    [
      'Each order cost [[36 / 3 dollars]].',
      'Each order cost 36 / 3 = 12 dollars.',
      'Each order cost 36 divided by 3, so 12 dollars.',
    ],
    [
      'A loss is [[6 - 9 dollars]] each.',
      'A loss is 6 - 9 = -3 dollars each.',
      'A loss is 6 minus 9, so minus 3 dollars each.',
    ],
    // No sum, a place to fill in.
    [
      'You have [[19 - 5 clubs]], so [[(19 - 5) * 15 dollars]] comes in.',
      'You have 19 - 5 = 14 clubs, so (19 - 5) x 15 = 210 dollars comes in.',
      'You have 19 minus 5, so 14 clubs, so 14 times 15, that is 210 dollars comes in.',
    ],
    ['You have [[19 clubs - 5 clubs]].', 'You have 19 - 5 = 14 clubs.', 'You have 19 minus 5, so 14 clubs.'],
    ['You sold [[20 lamps]].', 'You sold 20 lamps.', 'You sold 20 lamps.'],
    ['Say it costs [[your price]].', 'Say it costs [your price].', 'Say it costs [your price].'],
    ['Talk to [5 - 10 people].', 'Talk to [5 - 10 people].', 'Talk to [5 - 10 people].'],
    ['Cited [E1] and [E2, E3].', 'Cited [E1] and [E2, E3].', 'Cited [E1] and [E2, E3].'],
  ])('%s', (unit, text, voice) => {
    expect(said(unit)).toBe(text);
    expect(said(unit, true)).toBe(voice);
  });

  it('uses a result worked out before, in this reply or an earlier one, and their own currency', () => {
    const facts = new SumFacts(KNOWN);
    expect(sumsUnit('You keep [[26 - 7 - 4 - 2 dollars]].', facts).text).toContain('= 13 dollars');
    expect(sumsUnit('On 20 that is [[20 * 13 dollars]].', facts).text).toBe(
      'On 20 that is 20 x 13 = 260 dollars.',
    );
    for (const earlier of [
      'You keep 26 - 7 - 4 - 2 = 13 dollars a lamp.',
      'You keep 26 minus 7 minus 4 minus 2, so 13 dollars a lamp.',
      '$26 price - $7 wire - $4 shade - $2 plug = $13 left per lamp.',
    ])
      expect(said('That is [[20 * 13 dollars]].', false, KNOWN, [earlier]), earlier).toBe(
        'That is 20 x 13 = 260 dollars.',
      );
    expect(said('That is [[20 * 13 dollars]].')).toBe('');
    const cedis = 'I sell it for 40 cedis and it costs 25 cedis.';
    expect(said('You keep [[40 - 25 cedis]].', false, cedis)).toBe('You keep 40 - 25 = 15 cedis.');
    expect(said('You keep [[40 - 25]] each.', false, cedis)).toBe('You keep 40 - 25 = 15 each.');
    expect(said('You keep [[40 - 25 dollars]].', false, cedis)).toBe('');
  });

  it.each([
    // A number nobody gave.
    'You keep [[26 - 9.75 dollars]].',
    'That is [[33 * 7 dollars]].',
    'You keep [[8017 - 46 dollars]].',
    // Constants as amounts.
    'You keep [[26 - 12 dollars]].',
    'It is [[12 * 52 dollars]].',
    // Units that do not fit.
    'That is [[26 * 7 dollars]].',
    'That is [[26 - 20 dollars]].',
    'That is [[20 / 26 dollars]].',
    'You have [[26 - 7 clubs]].',
    // Below zero with no word of a loss.
    'You keep [[0.50 - 9 dollars]].',
    'What is left is [[6 - 9 dollars]].',
    // What cannot be read.
    'You keep [[price - cost]].',
    'You keep [[26 - 7.',
    'You keep 26 - 7]].',
    'You keep [[26 - 7] dollars]].',
    'You keep [[26 -]].',
    'You keep [[26 7]].',
    'You keep [[26 - 7 to 9 dollars]].',
    'You keep [[26 and 7 dollars]].',
    'You keep [[26 ** 7]].',
    'You keep [[(26 - 7 dollars]].',
    'You keep [[26 - 25%]].',
    'You keep [[1e9 * 26 dollars]].',
    'You keep [[alert(1) - 7]].',
    'You keep [[26 / (7 - 7)]].',
    'You keep [[31 dollars]].',
  ])('never says %s', (unit) => {
    expect(said(unit)).toBe('');
    expect(said(unit, true)).toBe('');
  });

  it('leaves out only the clause that carries a sum nobody can check, as an ungrounded figure', () => {
    expect(said('Sell the first ten at the fair by hand, which leaves you [[33 - 8.25 dollars]] each.')).toBe(
      'Sell the first ten at the fair by hand.',
    );
  });
});

describe('a sum the model wrote out, put right', () => {
  it.each([
    ['26 minus 13 leaves 12.', '26 minus 13 leaves 13.'],
    ['26 - 13, so you keep 12 dollars.', '26 - 13, so you keep 13 dollars.'],
    ['26 - 13 = 12 dollars a lamp.', '26 - 13 = 13 dollars a lamp.'],
    ['$26 - $13 = $12.', '$26 - $13 = $13.'],
    [
      '26 dollars minus 7 for the wire, 4 for the shade and 2 for the plug leaves 12 dollars.',
      '26 dollars minus 7 for the wire, 4 for the shade and 2 for the plug leaves 13 dollars.',
    ],
    [
      'Take 26 minus 7 minus 4 minus 2, which leaves you 11.',
      'Take 26 minus 7 minus 4 minus 2, which leaves you 13.',
    ],
    ['20 x 13 = 250.', '20 x 13 = 260.'],
    ['20 lamps at 13 dollars is 250 dollars.', '20 lamps at 13 dollars is 260 dollars.'],
    ['20 times 13 comes to 270.', '20 times 13 comes to 260.'],
    ['15 dollars times 12 months is 190 dollars.', '15 dollars times 12 months is 180 dollars.'],
    ['8 of 40 is 25%.', '8 of 40 is 20%.'],
    ['8 out of 40 is 25 percent.', '8 out of 40 is 20 percent.'],
    ['95 / 13 = 8.1 lamps.', '95 / 13 = 7.3 lamps.'],
    ['36 divided by 3 is 13 dollars.', '36 divided by 3 is 12 dollars.'],
    ['9 - 6 - 0.50 = 3.50 dollars.', '9 - 6 - 0.50 = 2.50 dollars.'],
    ['(19 - 5) x 15 = 200 dollars.', '(19 - 5) x 15 = 210 dollars.'],
    ['You keep $12 a lamp ($26 - $7 - $4 - $2).', 'You keep $13 a lamp ($26 - $7 - $4 - $2).'],
    [
      'You keep 12 dollars (26 minus 7 minus 4 minus 2).',
      'You keep 13 dollars (26 minus 7 minus 4 minus 2).',
    ],
    ['26 - 13 = 14 and 20 x 13 = 250.', '26 - 13 = 13 and 20 x 13 = 260.'],
  ])('%s', (unit, right) => {
    expect(said(unit, false, KNOWN, ['26 - 7 - 4 - 2 = 13 dollars.'])).toBe(right);
  });

  it.each([
    // Right already, however it was rounded.
    '26 minus 13 leaves 13.',
    '95 / 13 is 7.3.',
    '95 divided by 13 is about 7 lamps.',
    'You need 95 / 13, or 8 lamps.',
    '7 / 0.6 = 11.67 dollars.',
    '3 of 80 is 4%.',
    '8 of 40 is 20%.',
    // No sum.
    'Talk to 8 - 20 people, that is 2 a day.',
    '8/10 is fine, or 3.',
    'Five of 8 said yes, so 3 did not.',
    'On 12/9 is the fair, so 4 days.',
    'Offer it at 26 and 13.',
    '4 of them paid 15, that is good.',
    'A 20 - 40 minute call is enough.',
    'You sell 20 lamps at 26 dollars.',
    '8 of 40 people, or 10% of the campus.',
    'It costs 7 dollars (4 - 8 sizes).',
    'You keep $13 a lamp ($26 - $7 - $4 - $2).',
    '26 minus 13 leaves 2 things to pay.',
    // Their own sum, said back.
    'You said 26 minus 13 is 12.',
  ])('leaves %s', (unit) => {
    expect(said(unit, false, KNOWN, ['26 - 7 - 4 - 2 = 13 dollars.'])).toBe(unit);
  });

  it.each([
    // Wrong, on numbers nobody gave.
    '99 minus 33 is 80.',
    'You keep 44 - 11 = 22 dollars.',
    // Units that do not fit.
    '26 - 20 = 5 dollars.',
    // Read two ways.
    '26 minus 2 times 4 is 50.',
  ])('drops %s', (unit) => {
    expect(said(unit)).toBe('');
  });

  it('nothing after it builds on a result that was wrong', () => {
    const facts = new SumFacts(KNOWN, ['26 - 7 - 4 - 2 = 13 dollars.']);
    const run = (unit: string): string => sumsUnit(unit, facts, { cut: withoutSpan }).text;
    expect(run('26 - 7 - 4 - 2 = 12 dollars.')).toBe('26 - 7 - 4 - 2 = 13 dollars.');
    expect(run('At 20 lamps you make 240 dollars.')).toBe('');
    expect(run('Twelve stays yours, so 12 dollars it is.')).toBe('');
    expect(run('At 20 lamps you make 260 dollars.')).toBe('At 20 lamps you make 260 dollars.');
    expect(run('Sell 8 of them first.')).toBe('Sell 8 of them first.');
    // Said again otherwise right after the sum.
    const next = new SumFacts(KNOWN);
    sumsUnit('You keep [[26 - 7 - 4 - 2 dollars]].', next);
    expect(sumsUnit('That is 11 dollars.', next, { cut: withoutSpan }).text).toBe('');
    expect(sumsUnit('That is 13 dollars.', next, { cut: withoutSpan }).text).toBe('That is 13 dollars.');
  });
});

describe('any sum written out wrong', () => {
  it('is put right or dropped, whatever its wording', () => {
    const next = random(5);
    const pick = (): number => POOL[Math.floor(next() * POOL.length)] ?? 24;
    let repaired = 0;
    for (let n = 0; n < 3_000; n += 1) {
      const a = pick();
      const b = pick();
      const op = '-+*/'.charAt(Math.floor(next() * 4));
      const right = op === '-' ? a - b : op === '+' ? a + b : op === '*' ? a * b : a / b;
      if (right <= 0.5) continue;
      const wrong =
        Math.round((right + (next() < 0.5 ? -1 : 1) * (1.5 + Math.floor(next() * 40))) * 100) / 100;
      if (wrong <= 0 || Math.abs(wrong - right) < 1.2) continue;
      const words = { '-': 'minus', '+': 'plus', '*': 'times', '/': 'divided by' }[op] ?? 'minus';
      const sign = op === '*' ? 'x' : op;
      const eq = ['leaves', 'is', 'comes to', 'gives you', '=', ', so you keep', ', which is', 'equals'][
        Math.floor(next() * 8)
      ];
      const expr = next() < 0.5 ? `${String(a)} ${words} ${String(b)}` : `${String(a)} ${sign} ${String(b)}`;
      const unit = `${expr}${eq?.startsWith(',') === true ? eq : ` ${eq ?? 'is'}`} ${String(wrong)} dollars.`;
      const out = sumsUnit(unit, new SumFacts(POOL_TEXT), { cut: withoutSpan }).text;
      expect(out, unit).not.toBe(unit);
      if (out === '') continue;
      repaired += 1;
      expect(Math.abs(lastNumber(out) - right), `${unit} -> ${out}`).toBeLessThanOrEqual(0.00501);
    }
    expect(repaired).toBeGreaterThan(1_500);
  });
});

describe('spelled numbers', () => {
  it.each([
    ['sixteen clubs', '16 clubs'],
    ['twenty-five dollars', '25 dollars'],
    ['one hundred and twenty people', '120 people'],
    ['twelve fifty each', '12.50 each'],
    ['a thousand', '1000'],
    ['nobody', 'nobody'],
  ])('%s', (text, digits) => {
    expect(spelledAsDigits(text).replace('12.5 ', '12.50 ')).toBe(digits);
  });
});

// Any expression, any cut of the stream ---------------------------------------------------------------------------------

/** A small generator (mulberry32): the same runs every time. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const POOL = [24, 6, 3, 2, 30, 13, 16, 9, 90, 450, 3.5, 0.75, 1200];
const POOL_TEXT = `The numbers are ${POOL.join(' and ')}.`;

interface Made {
  readonly text: string;
  readonly value: number;
  readonly prec: number;
}

function expression(next: () => number, depth: number): Made {
  if (depth === 0 || next() < 0.25) {
    const n = POOL[Math.floor(next() * POOL.length)] ?? 24;
    return { text: String(n), value: n, prec: 3 };
  }
  const a = expression(next, depth - 1);
  const b = expression(next, depth - 1);
  const op = '+-*/'.charAt(Math.floor(next() * 4));
  const prec = op === '+' || op === '-' ? 1 : 2;
  const left = a.prec < prec ? `(${a.text})` : a.text;
  const right = b.prec < prec || (b.prec === prec && (op === '-' || op === '/')) ? `(${b.text})` : b.text;
  const value =
    op === '+'
      ? a.value + b.value
      : op === '-'
        ? a.value - b.value
        : op === '*'
          ? a.value * b.value
          : a.value / b.value;
  const sign = op === '*' && next() < 0.5 ? (next() < 0.5 ? 'x' : '×') : op;
  return {
    text: next() < 0.8 || sign === 'x' ? `${left} ${sign} ${right}` : `${left}${sign}${right}`,
    value,
    prec,
  };
}

/** The last number a sentence states. */
const lastNumber = (text: string): number => {
  const all = [...text.matchAll(/(minus |-)?\$?(\d[\d,]*(?:\.\d+)?)(?=[^\d]*$)/g)].at(-1);
  return Number((all?.[2] ?? 'NaN').replace(/,/g, '')) * (all?.[1] === undefined ? 1 : -1);
};

describe('any expression of their numbers', () => {
  it('is worked out right, or not said; never shown as it was written', () => {
    const next = random(20_261_127);
    let told = 0;
    for (let n = 0; n < 4_000; n += 1) {
      const made = expression(next, 1 + Math.floor(next() * 3));
      if (made.prec === 3) continue;
      const spoken = next() < 0.5;
      const unit = `You lose or keep [[${made.text} dollars]].`;
      const out = sumsUnit(unit, new SumFacts(POOL_TEXT), { spoken });
      expect(out.text, unit).not.toMatch(/[[\]]/);
      const leaves = (made.text.match(/\d+(?:\.\d+)?/g) ?? []).length;
      if (!Number.isFinite(made.value) || Math.abs(made.value) > 1e10 || leaves > 12) {
        expect(out.text, unit).toBe('');
        continue;
      }
      expect(out.text, unit).not.toBe('');
      told += 1;
      expect(
        Math.abs(lastNumber(out.text.replace(/\.$/, '')) - made.value),
        `${unit} -> ${out.text}`,
      ).toBeLessThanOrEqual(0.00501);
      // Read again it stays, whatever was shown.
      expect(sumsUnit(out.text, new SumFacts(POOL_TEXT), { spoken }).text, unit).toBe(out.text);
    }
    expect(told).toBeGreaterThan(2_000);
  });

  it('with one number that is not theirs, is never said', () => {
    const next = random(7);
    for (let n = 0; n < 600; n += 1) {
      const made = expression(next, 2);
      if (made.prec === 3) continue;
      const stranger = 1000 + Math.floor(next() * 190) + 0.37;
      const text = next() < 0.5 ? `${made.text} - ${String(stranger)}` : `${String(stranger)} + ${made.text}`;
      expect(sumsUnit(`You lose [[${text} dollars]].`, new SumFacts(POOL_TEXT)).text, text).toBe('');
    }
  });
});

const GATE: SentenceGateOptions = {
  personaName: 'Thomas',
  mentor: true,
  otherVentureNames: [],
  otherVentureCanaries: [],
  founderText: 'What do I keep on one lamp, and on twenty?',
  knownFigures: KNOWN,
  support: buildSupportIndex({ evidence: [], founderText: KNOWN }),
  today: TODAY,
};
const GUIDED: PromptGuidance = {
  ...STEP_ONLY,
  firstTime: false,
  said: KNOWN,
  matched: 'none',
  asksSum: true,
  stepRole: 'quiet',
};

function stream(reply: string, cuts: readonly number[], options: Partial<SentenceGateOptions> = {}) {
  const gate = new SentenceGate({ ...GATE, ...options });
  let text = '';
  const spoken: string[] = [];
  const take = (units: readonly { text: string; spoken: string }[]): void => {
    for (const u of units) {
      // Nothing of a marker is ever released.
      expect(u.text).not.toMatch(/\[\[|\]\]/);
      expect(u.spoken).not.toMatch(/[[\]]/);
      text += u.text;
      if (u.spoken !== '') spoken.push(u.spoken);
    }
  };
  let from = 0;
  for (const cut of [...cuts, reply.length]) {
    take(gate.push(reply.slice(from, cut)).units);
    from = cut;
  }
  take(gate.end().units);
  return { gate, text, spoken: spoken.join(' ') };
}

const REPLY =
  'You keep [[26 - 7 - 4 - 2 dollars]] on one lamp. On twenty that is [[20 * 13 dollars]], before the stall.\n\n' +
  'The stall takes [[95 / 13 lamps]] to pay for itself, so it is worth one more Saturday of your time.';
const SHOWN =
  'You keep 26 - 7 - 4 - 2 = 13 dollars on one lamp. On twenty that is 20 x 13 = 260 dollars, before the stall.\n\n' +
  'The stall takes 95 / 13 = 7.3, so 8 lamps to pay for itself, so it is worth one more Saturday of your time.';

describe('through the sentence gate', () => {
  it('a marker is held back whole, wherever the stream is cut', () => {
    for (let at = 1; at < REPLY.length; at += 1) expect(stream(REPLY, [at]).text, String(at)).toBe(SHOWN);
    // One character at a time, and cut twice.
    expect(
      stream(
        REPLY,
        Array.from({ length: REPLY.length - 1 }, (_, i) => i + 1),
      ).text,
    ).toBe(SHOWN);
    for (let at = 1; at < REPLY.length - 5; at += 7) expect(stream(REPLY, [at, at + 3]).text).toBe(SHOWN);
    const { gate } = stream(REPLY, [40]);
    expect(gate.trace.rewritten).toBe(true);
  });

  it('any reply of random sums is the same whole, in one piece and in any pieces, typed and said', () => {
    const next = random(99);
    const support = buildSupportIndex({ evidence: [], founderText: POOL_TEXT });
    for (let n = 0; n < 60; n += 1) {
      const a = expression(next, 2);
      const b = expression(next, 2);
      const reply = `First, you keep or lose [[${a.text} dollars]] of it. Then comes a plain sentence. After that it is [[${b.text}]] dollars, gained or lost.`;
      const options: Partial<SentenceGateOptions> = { knownFigures: POOL_TEXT, support, spoken: n % 2 === 0 };
      const whole = stream(reply, [], options);
      for (let k = 0; k < 6; k += 1) {
        const cuts = [...new Set([1, 2, 3, 4].map(() => 1 + Math.floor(next() * (reply.length - 2))))].sort(
          (x, y) => x - y,
        );
        const out = stream(reply, cuts, options);
        expect([out.text, out.spoken], `${reply} ${cuts.join()}`).toEqual([whole.text, whole.spoken]);
      }
    }
  });

  it('opens a reply with a sum: a marker is no structured output', () => {
    const reply = '[[26 - 7 - 4 - 2 dollars]] is what one lamp leaves you, before the stall.';
    for (let at = 1; at < reply.length; at += 1) {
      const out = stream(reply, [at]);
      expect(out.gate.fallback).toBeNull();
      expect(out.text).toBe('26 - 7 - 4 - 2 = 13 dollars is what one lamp leaves you, before the stall.');
    }
    expect(stream('{"answer": "hello there, founder"}', [3]).gate.fallback).toBe('structured_output');
    expect(stream('[{"answer": "hello there, founder"}]', [3]).gate.fallback).toBe('structured_output');
    expect(stream('[["answer", "hello there, founder"]]', [3]).gate.fallback).toBe('structured_output');
  });

  it('on a call says the spoken form, which is the transcript', () => {
    const out = stream(
      'You keep [[9 - 6 - 0.50 dollars]] on a trip. That is thin, so raise the price first.',
      [20],
      {
        spoken: true,
      },
    );
    expect(out.text).toBe(
      'You keep 9 minus 6 minus 0.50, so $2.50 on a trip. That is thin, so raise the price first.',
    );
    expect(out.spoken).toBe(out.text);
  });

  it('drops the sentence of a sum that cannot be told, and says the rest', () => {
    const out = stream(
      'You keep [[26 - 9.99 dollars]] on one. Offer it to five people this week and write down what they say.',
      [12],
    );
    expect(out.text.trim()).toBe('Offer it to five people this week and write down what they say.');
    expect(out.gate.trace.supportEdits).toBe(1);
    expect(
      stream('You keep [[26 - 7 on one lamp.\n\nOffer it to five people this week.', [12]).text.trim(),
    ).toBe('Offer it to five people this week.');
  });

  it('the reply that was shown is the reply that is stored: the final validation changes nothing of it', () => {
    for (const spoken of [false, true]) {
      const options: Partial<SentenceGateOptions> = {
        guidance: GUIDED,
        spoken,
        support: buildSupportIndex({
          evidence: [],
          founderText: KNOWN,
          guidanceText: guidanceText(GUIDED, TODAY),
        }),
      };
      const out = stream(REPLY, [33, 90], options);
      expect(out.text).toContain(spoken ? 'so 13 dollars on one lamp' : '= 13 dollars on one lamp');
      const raw = {
        mode: 'coach',
        answer: out.text.trim(),
        claims: [],
        uncertainty: [],
        challenge: null,
        next_actions: [],
        escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
        memory_candidates: [],
        follow_up_questions: [],
        rehearsal: null,
        spoken: spoken ? out.text.trim() : null,
      };
      const check = (answer: string) =>
        validateCoachResponse(
          { ...raw, answer, spoken: spoken ? answer : null },
          {
            evidenceKeys: new Set(),
            preRisk: { categories: [] },
            otherVentureNames: [],
            otherVentureCanaries: [],
            personaName: 'Thomas',
            mentor: true,
            coverageThreshold: 0.6,
            founderText: GATE.founderText ?? '',
            knownFigures: KNOWN,
            support: options.support ?? null,
            guidance: GUIDED,
            today: TODAY,
            channel: spoken ? 'voice' : 'text',
            released: true,
          },
        ).response;
      expect(check(out.text.trim()).answer).toBe(out.text.trim());
      // Written whole, its markers are worked out there the same way.
      expect(check(REPLY).answer).toBe(out.text.trim());
    }
  });

  it('a field of the response never holds a marker', () => {
    const facts = new SumFacts(KNOWN);
    expect(sumsText('A lamp leaves [[26 - 7 - 4 - 2 dollars]]. And [[broken.', facts).text).toBe(
      'A lamp leaves 26 - 7 - 4 - 2 = 13 dollars.',
    );
  });

  it('the examples of the prompt are no figures of a reply', () => {
    const examples = [...conversationCraftRules('text').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[0]);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples.filter((e) => /\d/.test(e)))
      expect(stream(`You keep ${example} on one lamp.`, [9]).text, example).toBe('');
  });
});

describe('the mock writes a sum as a model is asked to', () => {
  it.each([
    [
      'What do I make on one lamp?',
      ['A lamp sells for 26 dollars; the wire is 7 dollars.'],
      '[[26 - 7 dollars]]',
    ],
    ['And on 20 lamps?', ['A lamp sells for 26 dollars and costs 9 to make.'], '[[20 * (26 - 9) dollars]]'],
    ['What share bought?', ['Eight of 40 bought.'], '[[8 / 40 percent]]'],
    ['What is my rate?', ['One edit takes six hours and I charge 90 dollars.'], '[[90 / 6 dollars an hour]]'],
    ['If I sell 50, what is it?', ['They go for 4 dollars.'], '[[50 * 4 dollars]]'],
    ['Who is my customer?', [], null],
  ])('%s', (ask, sources, marker) => {
    expect(markedSum(ask, sources)).toBe(marker);
  });
});

describe('a number of theirs in another unit', () => {
  const TRIP =
    'A trip takes 45 minutes and leaves 30 dollars. The show had 2,400 listeners and the spot is 120 dollars.';
  it('minutes as hours, and listeners in thousands, may stand in a sum', () => {
    expect(said('That is [[30 / 0.75 dollars]] an hour.', false, TRIP)).toBe(
      'That is 30 / 0.75 = 40 dollars an hour.',
    );
    expect(said('Per thousand: [[120 / 2.4 dollars]].', false, TRIP)).toBe(
      'Per thousand: 120 / 2.40 = 50 dollars.',
    );
  });

  it('the unit after a result of its own goes with that result', () => {
    expect(
      said(
        'All of it takes [[3 * 3 * 25 minutes]] = 3.75 hours.',
        false,
        'three people, three items each, 25 minutes an item',
      ),
    ).toBe('All of it takes 3 x 3 x 25 = 225 minutes.');
  });
});
