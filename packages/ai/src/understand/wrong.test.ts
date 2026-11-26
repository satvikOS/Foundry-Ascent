import { describe, expect, it } from 'vitest';

import { betterSums, sumsDoubt } from './again.js';
import { readParts, type UnderstandContext } from './check.js';
import { countAsked, mergeReadings } from './merge.js';
import type { SumsReading } from './schema.js';

const context = (
  message: string,
  record: readonly string[] = [],
  history: readonly [string, string][] = [],
): UnderstandContext => ({
  today: '2026-03-04',
  message,
  history: history.map(([founder, reply]) => ({ founder, reply })),
  record: record.map((text, i) => ({
    key: `R${String(i + 1)}`,
    kind: 'fact',
    text,
    on: null,
    memoryId: null,
  })),
  shown: '',
  plays: [],
  stepCandidates: new Set(),
});
const reading = (n: string[], s: SumsReading['s'], q = 'the figure'): SumsReading => ({
  q,
  w: 'the plan',
  n,
  s,
  m: null,
});
const first = (c: UnderstandContext, r: SumsReading) => readParts({ sums: r }, c).understanding?.sums[0];

describe('a follow-up that changes one number', () => {
  const record = ['We keep 20 percent of every sale and pay the card fee, 2 percent of it, out of that.'];
  const before: [string, string][] = [
    ['march came to 1,500 in sales. what is ours after the card fee', 'You keep $270: $1,500 × (20% − 2%).'],
  ];

  it('puts the new number where the like one was, not in place of the sales', () => {
    const c = context('and at 25 instead?', record, before);
    // The model read 25 as the sales: what one sale of $25 leaves.
    const wrong = reading(
      ['sales=25@message', 'cut=20%@R1', 'fee=2%@R1'],
      [{ l: 'what you keep', u: '$', e: 'sales * (cut - fee)' }],
    );
    expect(first(c, wrong)).toMatchObject({ value: 345 });
    expect(readParts({ sums: wrong }, c).report.sumMends).toContain('instead');
  });

  it('leaves a sum alone where the new number did take the place of the like one', () => {
    const c = context('and at 25 instead?', record, before);
    const right = reading(
      ['sales=1,500@history', 'cut=25@message', 'fee=2%@R1'],
      [{ l: 'what you keep', u: '$', e: 'sales * (cut / 100 - fee / 100)' }],
    );
    expect(first(c, right)).toMatchObject({ value: 345 });
    expect(readParts({ sums: right }, c).report.sumMends).not.toContain('instead');
  });

  it('changes nothing where no earlier number is near the new one, or the message is no follow-up', () => {
    const far = context('and with 900 instead?', record, before);
    const sum = reading(
      ['sales=900@message', 'cut=20%@R1', 'fee=2%@R1'],
      [{ l: 'what you keep', u: '$', e: 'sales * (cut - fee)' }],
    );
    expect(first(far, sum)).toMatchObject({ value: 162 });
    const plain = context('april had 25 sales, what do they bring', record, before);
    expect(
      readParts(
        {
          sums: reading(
            ['sales=25@message', 'cut=20%@R1', 'fee=2%@R1'],
            [{ l: 'what you keep', u: '$', e: 'sales * (cut - fee)' }],
          ),
        },
        plain,
      ).report.sumMends,
    ).not.toContain('instead');
  });
});

describe('a share of ours, where the figure is the other person’s', () => {
  const c = context(
    'a 4 hr night at 30 an hour, i keep 10% and the sitter pays her own taxi, 8 return. what does she actually make an hour',
  );
  const n = ['hours=4@message', 'rate=30@message', 'keep=10%@message', 'taxi=8@message'];

  it('is what is left of it for them', () => {
    const r = reading(n, [
      { l: 'what the sitter makes an hour', u: '$', e: '(hours * rate * keep - taxi) / hours' },
    ]);
    expect(first(c, r)).toMatchObject({ value: 25 });
    expect(readParts({ sums: r }, c).report.sumMends).toContain('part');
  });

  it('is left alone where the sum takes it off already, or the figure is ours', () => {
    const off = reading(n, [
      { l: 'what the sitter makes an hour', u: '$', e: '(hours * rate * (1 - keep) - taxi) / hours' },
    ]);
    expect(first(c, off)).toMatchObject({ value: 25 });
    const ours = reading(n, [{ l: 'what you make on the night', u: '$', e: 'hours * rate * keep' }]);
    expect(first(c, ours)).toMatchObject({ value: 12 });
  });
});

describe('a count of other things than the one asked for', () => {
  const record = [
    'A tin of glaze sells for 50 dollars and costs 20 to make; a studio buys 30 tins in a year.',
  ];
  const c = context('at 50 a tin, studios we need to net 9k a year after making it', record);
  const liters = reading(
    ['net=9k@message', 'price=$50@R1', 'cost=20@R1'],
    [{ l: 'the tins to net $9,000', u: 'tins', e: 'ceil(net / (price - cost))' }],
  );

  it('is what the message counts', () => {
    expect(countAsked('at 50 a tin, studios we need to net 9k')).toBe('studios');
    expect(countAsked('how many kilns is that')).toBe('kilns');
    expect(countAsked('how many leave')).toBeNull();
    expect(countAsked('how many hours a week')).toBeNull();
  });

  it('is no figure they asked for, and is asked for again', () => {
    const route = { a: 'x', b: null, k: ['sum'], r: [], c: null, f: null, p: null, s: null, h: false };
    const u = mergeReadings({ route, sums: liters }, { message: c.message, keys: new Set(['R1']) });
    expect(u?.sums.map((s) => s.asked)).toEqual([false]);
    const doubt = sumsDoubt(liters, c);
    expect(doubt).toMatchObject({ code: 'noun' });
    expect(doubt?.hint).toContain('how many studios');
    const studios = reading(
      ['net=9k@message', 'price=$50@R1', 'cost=20@R1', 'tins=30@R1'],
      [{ l: 'the studios to net $9,000', u: 'studios', e: 'ceil(net / ((price - cost) * tins))' }],
    );
    if (doubt === null) throw new Error('no doubt');
    expect(betterSums(liters, studios, doubt, c)).toBe(studios);
    expect(readParts({ route, sums: studios }, c).understanding?.sums[0]).toMatchObject({
      value: 10,
      asked: true,
    });
    // A second answer that still counts tins does not stand in for the first.
    expect(betterSums(liters, liters, doubt, c)).toBe(liters);
  });
});
