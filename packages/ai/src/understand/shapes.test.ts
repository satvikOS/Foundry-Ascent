import { describe, expect, it } from 'vitest';

import { expectLinearTime } from '../testing/linear-time.js';
import { readParts, type UnderstandContext } from './check.js';
import { mergeReadings } from './merge.js';
import type { SumsReading } from './schema.js';
import { SHAPE_SLOTS, SUM_SHAPES, built, slotsOf, slotWords } from './shapes.js';

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
const sum = (k: string, a: string[], l = 'what you get', u = ''): Sum => ({ l, u, k, a, e: null });
const read = (c: UnderstandContext, s: Sum[], m: string | null = null) =>
  readParts({ sums: { q: 'the figure', w: 'the plan', s, m } }, c);
const said = (c: UnderstandContext, s: Sum) => read(c, [s]).understanding?.sums[0];

describe('a sum of a known shape, built by code from its slots', () => {
  it('cover: fixed and target over what one sale leaves, rounded up', () => {
    const c = context('the tent is 230 and i want 70 more. how many lessons', [
      'A kayak lesson is 32 dollars; the guide gets 12 of it.',
    ]);
    const s = sum(
      'cover',
      ['fixed=230@message', 'target=70@message', 'price=$32@R1', 'cost=12@R1'],
      'the lessons',
      'lessons',
    );
    expect(said(c, s)).toMatchObject({ value: 15, asked: true });
  });

  it('cover: a share that is theirs comes off the price; ours is the price times it', () => {
    const theirs = context('the market keeps 20%. how many loaves pay the 120 oven', [
      'A loaf sells for 6 dollars.',
    ]);
    expect(
      said(
        theirs,
        sum('cover', ['fixed=120@message', 'price=$6@R1', 'cut=20%@message'], 'the loaves', 'loaves'),
      ),
    ).toMatchObject({ value: 25 });
    const ours = context('we take 20% of each loaf. how many loaves pay the 120 oven', [
      'A loaf sells for 6 dollars.',
    ]);
    expect(
      said(
        ours,
        sum('cover', ['fixed=120@message', 'price=$6@R1', 'ours=20%@message'], 'the loaves', 'loaves'),
      ),
    ).toMatchObject({ value: 100 });
  });

  it('cover: payback from the gain it names', () => {
    const c = context('the press is 900. how many months till its paid', [
      'The press saves 75 dollars a month.',
    ]);
    expect(said(c, sum('cover', ['fixed=900@message', 'gain=$75@R1'], 'the months', 'months'))).toMatchObject(
      {
        value: 12,
      },
    );
  });

  it('hourly: a month of money over a week of hours, the periods turned by code', () => {
    const c = context('what is that an hour', ['Five homes pay 52 dollars a month; it is 3 hours a week.']);
    const s = sum(
      'hourly',
      ['count=Five@R1', 'price=$52 a month@R1', 'hours=3 hours a week@R1'],
      'what an hour pays you',
    );
    // 5 × $52 a month is $60 a week: over 3 hours.
    expect(said(c, s)).toMatchObject({ value: 20 });
  });

  it('left: what is left after what each costs, what is paid once and their share', () => {
    const c = context('the fair takes 10%. on 30 mugs, what is left after the 50 table', [
      'A mug sells for 20 dollars and the clay is 4.',
    ]);
    const s = sum('left', [
      'count=30@message',
      'price=$20@R1',
      'unitcost=4@R1',
      'cost=50@message',
      'cut=10%@message',
    ]);
    // 30 × $20 − 30 × $4 − $50 − 10% of $600.
    expect(said(c, s)).toMatchObject({ value: 370 });
  });

  it('ours, stake, total, runway, price, change, rate, chain', () => {
    const cases: [UnderstandContext, Sum, number][] = [
      [
        context('we keep 5% of what the stalls make. what is ours', ['The stalls made 2,400 dollars.']),
        sum('ours', ['amount=2,400@R1', 'ours=5%@message']),
        120,
      ],
      [
        context('12k for 6 percent, what does that value us at'),
        sum('stake', ['amount=12k@message', 'share=6 percent@message']),
        200_000,
      ],
      [
        context('and 40 for the banner. all in?', [], [['the stand was 150', 'Noted.']]),
        sum('total', ['amount=150@history', 'amount=40@message']),
        190,
      ],
      [
        context('we hold 4,000 and spend 900 a month, 400 comes in. how long'),
        sum(
          'runway',
          ['cash=4,000@message', 'burn=900@message', 'income=400@message'],
          'the months',
          'months',
        ),
        8,
      ],
      [
        context('lamp price please, 40% of it mine', ['A lamp costs 30 dollars to make.']),
        sum('price', ['cost=$30@R1', 'margin=40%@message']),
        50,
      ],
      [
        context('what with 20% on top', ['A lamp costs 30 dollars to make.']),
        sum('price', ['cost=$30@R1', 'markup=20%@message']),
        36,
      ],
      [
        context('how much did the queue grow', ['The queue was 50 in May and is 65 now.']),
        sum('change', ['old=50@R1', 'new=65@R1'], 'the growth of the queue', '%'),
        30,
      ],
      [
        context('by what share did the wait fall', ['The wait was 40 minutes and is 30 now.']),
        sum('change', ['old=40@R1', 'new=30@R1'], 'the fall in the wait', '%'),
        25,
      ],
      [
        context('what share answered', ['Of 80 calls, 20 were answered.']),
        sum('rate', ['part=20@R1', 'whole=80@R1'], 'the share answered', '%'),
        25,
      ],
      [
        context('200 saw it, 30% clicked and a quarter of those paid. how many paid'),
        sum(
          'chain',
          ['whole=200@message', 'share=30%@message', 'share=a quarter@message'],
          'the people who paid',
          'people',
        ),
        15,
      ],
    ];
    for (const [c, s, value] of cases) expect(said(c, s)).toMatchObject({ value });
  });

  it('a shape is checked as any sum is: a number that is nowhere is refused', () => {
    const c = context('how many lessons pay the 230 tent', ['A kayak lesson is 32 dollars.']);
    const { understanding, report } = read(c, [
      sum('cover', ['fixed=230@message', 'price=$35@R1'], 'the lessons', 'lessons'),
    ]);
    expect(understanding?.sums ?? []).toEqual([]);
    expect(report.sumDrops).toEqual(['input']);
    expect(understanding?.missing).toBe('the price of one');
  });

  it('free: the expression over the names of its slots, as before', () => {
    const c = context('what do 4 nights leave', ['A night is 90 dollars and cleaning is 25 a night.']);
    const s: Sum = {
      l: 'what four nights leave you',
      u: '$',
      k: 'free',
      a: ['nights=4@message', 'rate=$90@R1', 'clean=25@R1'],
      e: 'nights * (rate - clean)}',
    };
    expect(said(c, s)).toMatchObject({ value: 260 });
  });

  it('every shape names its slots, and a slot says what it is in words', () => {
    expect(SUM_SHAPES.filter((k) => k !== 'free').every((k) => SHAPE_SLOTS[k].length > 0)).toBe(true);
    for (const slots of Object.values(SHAPE_SLOTS))
      for (const s of slots) expect(slotWords(`${s}12`)).not.toBeNull();
    expect(slotWords('price')).toBeNull();
    expect(slotsOf(['price=$5@R1', 'price=$2@R1', 'nothing', '=4@R1'], 3).by.get('price')).toEqual([
      'price31',
      'price32',
    ]);
  });
});

describe('what it lacks', () => {
  it('a shape without a slot it needs says which, as what is missing', () => {
    const lacks = (k: Parameters<typeof built>[0], slots: string[]) =>
      built(k, slotsOf(slots, 1).by, '').lacks;
    expect(lacks('cover', ['price=$5@R1'])).toBe('the cost to cover');
    expect(lacks('cover', ['fixed=50@R1'])).toBe('the price of one');
    expect(lacks('hourly', ['price=$5@R1'])).toBe('the hours it takes');
    expect(lacks('runway', ['cash=500@R1'])).toBe('what goes out a month');
    expect(lacks('stake', ['amount=500@R1'])).toBe('the share');
    expect(lacks('price', ['cost=5@R1'])).toBe('the share of the price you keep');
    expect(lacks('change', ['new=5@R1'])).toBe('the figure before');
    expect(lacks('total', [])).toBe('the amounts');
  });

  it('reaches the reading of a message that asks for the figure', () => {
    const c = context('how many jars pay for the stall', ['A jar sells for 7 dollars.']);
    const { understanding } = read(c, [sum('cover', ['price=$7@R1'], 'the jars', 'jars')]);
    expect(understanding).toMatchObject({ kind: 'sum', sums: [], missing: 'the cost to cover' });
    // What the model said is missing comes first.
    expect(read(c, [sum('cover', ['price=$7@R1'])], 'what the stall costs').understanding?.missing).toBe(
      'what the stall costs',
    );
  });

  it('a sum of one number of theirs is no sum, and says it lacks the rest', () => {
    const c = context('nightly take after paying the cleaner?', ['A night is 90 dollars.']);
    const s: Sum = { l: 'what a night leaves you', u: '$', k: 'free', a: ['rate=$90@R1'], e: 'rate' };
    const plan = (w: string) => readParts({ sums: { q: 'the figure', w, s: [s], m: null } }, c).understanding;
    expect(plan('the rate less the cleaner')).toMatchObject({
      sums: [],
      missing: 'the other numbers it needs',
    });
    // A plan that takes nothing off: a figure of theirs said again, and nothing missing.
    expect(plan('the rate of a night')?.missing).toBeNull();
  });
});

describe('whether the figure was asked for, by code', () => {
  const merged = (message: string, s: Sum[], kinds: string[] = ['update']) =>
    mergeReadings(
      {
        route: { k: kinds as never, p: null, s: null, r: [], c: null, f: null, h: false } as never,
        sums: { q: 'the figure', w: null, s, m: null },
      },
      { message, keys: new Set(['R1']) },
    );

  it.each([
    'so what am i into this for so far',
    'wat does that make',
    'hw much is left',
    'whats it all come to',
    'how many do i need',
  ])('%s asks for the one sum there is', (message) => {
    const one = merged(message, [sum('total', ['amount=5@message', 'amount=7@message'])]);
    expect(one?.sums.map((s) => s.asked)).toEqual([true]);
  });

  it('of two sums, the one whose shape the message asks for', () => {
    const two = merged('what is that an hour', [
      sum('total', ['amount=5@message', 'amount=7@message']),
      sum('hourly', ['amount=12@message', 'hours=3@message']),
    ]);
    expect(two?.sums.map((s) => s.asked)).toEqual([false, true]);
  });

  it.each(['what can the poster tell people', 'which club do i write to first', 'what should we try next'])(
    '%s asks for no figure',
    (message) => {
      expect(
        merged(message, [sum('rate', ['part=5@message', 'whole=7@message'])])?.sums.map((x) => x.asked),
      ).toEqual([false]);
    },
  );

  it('news with a figure in it asks for none', () => {
    const news = merged('we sold 5 and 7 today', [sum('total', ['amount=5@message', 'amount=7@message'])]);
    expect(news?.sums.map((s) => s.asked)).toEqual([false]);
  });

  it('reads its words in linear time', () => {
    expectLinearTime((n) => {
      const message = `${'how much '.repeat(n)}what is it`;
      return () => {
        merged(message, [sum('total', ['amount=5@message'])]);
      };
    }, 2_000);
  });
});
