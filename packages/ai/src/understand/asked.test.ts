import { describe, expect, it } from 'vitest';

import { expectLinearTime } from '../testing/linear-time.js';
import { readParts, type UnderstandContext } from './check.js';
import { inputOf, mergeReadings } from './merge.js';
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

type Sum = SumsReading['s'][number];
const read = (
  c: UnderstandContext,
  n: string[],
  s: Sum[],
  w: string | null = 'the plan',
  m: string | null = null,
) => readParts({ sums: { q: 'the figure', w, n, s, m } }, c);
const said = (c: UnderstandContext, n: string[], e: string, l = 'what you get', u = '$') =>
  read(c, n, [{ l, u, e }]).understanding?.sums[0];

describe('the numbers of a sum, as people write them', () => {
  it('a third is a share, an amount every week is no time, and a number before one thing is no count of it', () => {
    expect(inputOf('share=a third@message')?.value).toBeCloseTo(1 / 3, 9);
    expect(inputOf('share=a quarter@message')?.value).toBe(0.25);
    expect(inputOf('burn=350 every week@message')).toMatchObject({ value: 350, unit: 'count' });
    expect(inputOf('hours=5 hours a week@R1')).toMatchObject({ value: 5, unit: 'time' });
  });

  it('a share of a share, said in words', () => {
    const c = context('200 saw it, 30% clicked and a quarter of those paid. how many paid');
    expect(
      said(
        c,
        ['seen=200@message', 'clicked=30%@message', 'paid=a quarter@message'],
        'seen * clicked * paid',
        'the people who paid',
        'people',
      ),
    ).toMatchObject({ value: 15 });
  });

  it('the cost of one thing before it ("the 600 website") may be money', () => {
    const c = context('we get 15% of each print. how many prints till the 600 website is paid', [
      'A print sells for 80 dollars.',
    ]);
    expect(
      said(
        c,
        ['site=600@message', 'price=$80@R1', 'ours=15%@message'],
        'ceil(site / (price * ours / 100))',
        'the prints',
        'prints',
      ),
    ).toMatchObject({ value: 50 });
  });

  it('a number at the end of a line counts nothing of the next', () => {
    const c = context(
      'and 40 for the banner. all in?',
      [],
      [
        ['the stand was 150', 'Noted.'],
        ['the chairs were 65', 'Noted.'],
      ],
    );
    expect(
      said(c, ['stand=150@history', 'chairs=65@history', 'banner=40@message'], 'stand + chairs + banner'),
    ).toMatchObject({
      value: 255,
    });
  });

  it('money a week against months, turned by code', () => {
    const c = context('we spend 350 every week, months left?', ['The account holds 9,100 dollars.']);
    expect(
      said(c, ['cash=$9,100@R1', 'burn=350 every week@message'], 'cash / burn', 'the months left', 'months'),
    ).toMatchObject({
      value: 6,
    });
  });

  it('a bracket left at the end of the expression is the answer’s, not the sum’s', () => {
    const c = context('what do 4 nights leave', ['A night is 90 dollars and cleaning is 25 a night.']);
    expect(
      said(c, ['nights=4@message', 'rate=$90@R1', 'clean=25@R1'], 'nights * (rate - clean)}'),
    ).toMatchObject({
      value: 260,
    });
  });
});

describe('what it lacks', () => {
  const c = context('nightly take after paying the cleaner?', ['A night is 90 dollars.']);
  const lone: Sum = { l: 'what a night leaves you', u: '$', e: 'rate' };

  it('one number of theirs, where the plan takes something off it, is no sum and lacks the rest', () => {
    expect(read(c, ['rate=$90@R1'], [lone], 'the rate less the cleaner').understanding).toMatchObject({
      sums: [],
      missing: 'the other numbers it needs',
    });
    // What the model said is missing comes first.
    expect(
      read(c, ['rate=$90@R1'], [lone], 'the rate less the cleaner', 'what the cleaner is paid').understanding
        ?.missing,
    ).toBe('what the cleaner is paid');
  });

  it('a plan that takes nothing off: a figure of theirs said again, and nothing missing', () => {
    expect(read(c, ['rate=$90@R1'], [lone], 'the rate of a night').understanding?.missing).toBeNull();
  });

  it('a number that is nowhere is named, in words', () => {
    const none = context('how many lessons pay the 230 tent', ['A kayak lesson is 32 dollars.']);
    const { understanding } = read(
      none,
      ['tent=230@message', 'fee=$35@R1'],
      [{ l: 'the lessons', u: 'lessons', e: 'ceil(tent / fee)' }],
    );
    expect(understanding).toMatchObject({ sums: [], missing: 'fee' });
  });
});

describe('whether the figure was asked for, by code', () => {
  const merged = (message: string, kinds: string[] = ['update']) =>
    mergeReadings(
      {
        route: { a: 'x', b: null, k: kinds, r: [], c: null, f: null, p: null, s: null, h: false },
        sums: {
          q: 'the figure',
          w: null,
          n: ['a=5@message', 'b=7@message'],
          s: [{ l: 'the total', u: '$', e: 'a + b' }],
          m: null,
        },
      },
      { message, keys: new Set(['R1']) },
    );

  it.each([
    'wat am i into it for now',
    'wat does that make',
    'hw much is left',
    'whats it all come to',
    'how many do i need',
  ])('%s asks for it', (message) => {
    expect(merged(message)?.sums.map((s) => s.asked)).toEqual([true]);
    const u = merged(message);
    expect([u?.kind, ...(u?.also ?? [])]).toContain('sum');
  });

  it.each([
    'what can the poster tell people',
    'which club do i write to first',
    'what should we try next',
    'we sold 5 and 7 today',
  ])('%s asks for none', (message) => {
    expect(merged(message)?.sums.map((s) => s.asked)).toEqual([false]);
  });

  const lead = (message: string, kinds: string[] | null) => {
    const sums = {
      q: 'the evenings a week',
      w: 'two evenings of two hours',
      n: ['a=2@message', 'b=2@message'],
      s: [{ l: 'the hours you have a week', u: 'hours', e: 'a + b' }],
      m: null,
    };
    const route =
      kinds === null
        ? null
        : { a: 'x', b: null, k: kinds, r: [], c: null, f: null, p: null, s: null, h: false };
    const u = mergeReadings({ route, sums }, { message, keys: new Set(['R1']) });
    return { asked: u?.sums.map((x) => x.asked), kinds: [u?.kind, ...(u?.also ?? [])] };
  };

  it.each([
    'Show is done and I have my 2 evenings back, 2 hours each. What’s next?',
    'whats next now the 2 evenings are free',
    'so far so good with the 2 evenings. what now?',
    'what’s left to do this week with 2 hours a night',
  ])('a figure SUMS found in "%s" is no ask, with ROUTE or without', (message) => {
    for (const kinds of [['next'], null]) {
      const { asked, kinds: read } = lead(message, kinds);
      // Without ROUTE and nothing asked, there is no reading at all.
      expect(asked?.some(Boolean) ?? false).toBe(false);
      expect(read).not.toContain('sum');
    }
  });

  it.each([
    'whats the total of the 2 evenings',
    'what’s left after the 2 hours',
    'how many hours is that a week',
  ])('"%s" asks for it, with ROUTE or without', (message) => {
    for (const kinds of [['next'], null]) expect(lead(message, kinds).asked).toEqual([true]);
  });

  it('ROUTE reading the message as a sum is the turn’s ask', () => {
    expect(lead('the 2 evenings, 2 hours each', ['sum']).asked).toEqual([true]);
  });

  it('reads its words in linear time', () => {
    expectLinearTime((n) => {
      const message = `${'how much '.repeat(n)}what is it`;
      return () => {
        merged(message);
      };
    }, 2_000);
  }, 60_000);
});
