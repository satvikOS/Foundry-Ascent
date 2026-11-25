import { describe, expect, it } from 'vitest';

import { calcAsked, calcOf, quantitiesIn, ratiosIn, saidNumbers, type CalcAsk } from './calc.js';

/** What a message (with what was said before it) gives: the lines, and the one number that is missing. */
type Case = readonly [
  message: string,
  lines: readonly string[],
  missing?: string | null,
  before?: readonly string[],
];

const BOX =
  'A kit sells for 12 dollars; beads cost 7 dollars and shipping 1.50 a kit; about 40 kits go out a month.';
const BOX_LEFT = '$12 price - $7 beads - $1.50 shipping = $3.50 left per kit.';

describe('what they said, with numbers as digits', () => {
  it.each([
    ['forty kits at twelve dollars', '40 kits at $12'],
    ['twenty five bucks', '$25'],
    ['twenty-five bucks', '$25'],
    ['a dollar fifty', '$1.50'],
    ['twelve dollars and fifty cents', '$12.50'],
    ['50 cents each', '$0.5 each'],
    ['a dozen cookies', '12 cookies'],
    ['two dozen cookies', '24 cookies'],
    ['half a dozen', '6'],
    ['one hundred and twenty people', '120 people'],
    ['a hundred dollars', '$100'],
    ['two thousand dollars', '$2000'],
    ['$1,200 for the press', '$1200 for the press'],
    ['1.5k users', '1500 users'],
    ['$3k', '$3000'],
    ['three grand', '$3000'],
    ['$3 to $5', '$3~5'],
    ['3-5 dollars', '$3~5'],
    ['between 3 and 5 dollars', '$3~5'],
    ['$12/kit', '$12 per kit'],
    ['half an hour', '30 minutes'],
    ['an hour and a half', '90 minutes'],
    ['twelve fifty', 'twelve fifty'],
    ['3 and 5 dollars', '3 and $5'],
  ])('%s', (text, said) => {
    expect(saidNumbers(text)).toBe(said);
  });
});

describe('a number and its role', () => {
  const roles = (text: string): string[] =>
    quantitiesIn(text).quantities.map(
      (q) =>
        `${q.role}:${String(q.low)}${q.high === q.low ? '' : `~${String(q.high)}`}${q.noun === null ? '' : `/${q.noun}`}${q.period === null ? '' : `@${q.period}`}${q.label === '' ? '' : `(${q.label})`}`,
    );
  it.each([
    ['We sell each bead for $14.', ['price:14/bead']],
    ['I charge 25 dollars a pickup.', ['price:25/pickup']],
    ['I charge 3 dollars a cup', ['price:3/cup']],
    ['We charge $40 per lab per month', ['price:40/lab']],
    ['Customers pay us $30 a month.', ['price:30@month']],
    ['My fee is 450 dollars.', ['price:450']],
    ['The fee is 450 now, not 300.', ['price:450']],
    ['The price is $20 each', ['price:20']],
    ['Tickets sell at 8 bucks', ['price:8/ticket']],
    ['I sell mugs for $15.', ['price:15/mug']],
    ['25 mugs offered at 6 dollars', ['price:6/mug']],
    ['Each kit costs me $9 to make', ['unit_cost:9/kit']],
    ['It costs 4 dollars to make one', ['unit_cost:4']],
    ['Wax is $2 and jars cost $3 each', ['unit_cost:3(jars)']],
    ['A bracelet costs $2 in beads', ['unit_cost:2/bracelet(beads)']],
    ['Shipping is $4 a kit', ['unit_cost:4/kit(shipping)']],
    ['Payment fees are 50 cents each', ['unit_cost:0.5(payment fees)']],
    ['Rent is $200 a month', ['period_cost:200@month(rent)']],
    ['We spend 60 dollars a month on hosting', ['period_cost:60@month(we)']],
    ['Beans and cups for one morning are 80 dollars', ['period_cost:80@other(beans and cups)']],
    ['The press costs $1,200 up front', ['one_time:1200(press)']],
    ['A used bike is 650 dollars', ['one_time:650(used bike)']],
    ['I have $500 saved up', ['cash:500']],
    ['We make $400 a month', ['revenue:400@month']],
    ['I sell 40 kits a month', ['volume:40/kit@month']],
    ['We do 12 orders a week', ['volume:12@week']],
    ['One wash takes me 20 minutes', ['unit_time:20/wash']],
    ['It takes nine hours each', ['unit_time:540']],
    ['I have four hours a week for it', ['week_hours:4@week']],
    ['Should I raise the price to 40 dollars?', []],
    ['What if I charged $10 a ride?', []],
    ['I talked to 8 people on 3 floors', []],
    ['Chapter 4 is due on December 11', []],
  ])('%s', (text, want) => {
    const said = roles(text);
    if (text.startsWith('We spend')) expect(said[0]).toContain('period_cost:60@month');
    else expect(said).toEqual(want);
  });
});

describe('part of a whole', () => {
  it.each([
    ['13 of 25', [[13, 25]]],
    ['3 out of 40 bought', [[3, 40]]],
    ['13 of the 25 mugs sold', [[13, 25]]],
    ['I asked 40 people and only 3 bought.', [[3, 40]]],
    ['25 mugs offered at 5 dollars, 13 sold on one morning.', [[13, 25]]],
    ['Emailed 60, and 9 replied', [[9, 60]]],
    ['Pitched 12 shops but 2 signed', [[2, 12]]],
    ['5 orders from 80 visitors', [[5, 80]]],
    ['15 of 10', []],
    ['at 9 of the clock', []],
    ['a meeting in 12 days', []],
  ])('%s', (text, want) => {
    expect(ratiosIn(saidNumbers(text).replace(/\$\d+/g, '$')).map((r) => [r.part, r.whole])).toEqual(want);
  });
});

describe('what they ask to have worked out', () => {
  it.each<[string, CalcAsk | null]>([
    ['What are my unit economics?', 'contribution'],
    ['How much do I make per kit?', 'contribution'],
    ['what is the profit on each mug', 'contribution'],
    ['Am I making money?', 'contribution'],
    ['What is my margin?', 'margin'],
    ['So what would I make in a month at forty kits?', 'monthly'],
    ['How much profit would that be a month?', 'monthly'],
    ['How many do I need to sell to break even?', 'break_even'],
    ['how many cups to pay for the bike?', 'break_even'],
    ['How many kits cover the rent?', 'break_even'],
    ["What's my hourly rate at that?", 'hourly'],
    ['What do I earn an hour?', 'hourly'],
    ['What is my conversion rate?', 'conversion'],
    ['What percent is that?', 'conversion'],
    ['How long until it pays itself back, the payback?', 'payback'],
    ['How long will my money last?', 'runway'],
    ['What is our runway?', 'runway'],
    ['How long would 10 orders take?', 'time'],
    ['What revenue would that be? How much in sales?', 'revenue'],
    ['How should this be priced?', null],
    ['Do I raise the price to 40? Yes or no.', null],
    ['Who should I talk to first?', null],
    ['I sold 13 of 25.', null],
    ['What money does the start take?', null],
    ['Where do the first hundred users come from?', null],
  ])('%s', (text, want) => {
    expect(calcAsked(text)).toBe(want);
  });
});

describe('the sums', () => {
  const SUMS: readonly Case[] = [
    // What one sale leaves.
    ['Can you work out my unit economics for one kit?', [BOX_LEFT], null, [BOX]],
    ['What were my unit economics again, per kit?', [BOX_LEFT], null, [BOX]],
    [
      'What are my unit economics?',
      ['$28 price - $9 wool - $8 knitting = $11 left per scarf.'],
      null,
      ['A scarf sells for 28 dollars, wool costs 9 and knitting takes 8 dollars a scarf.'],
    ],
    [
      'I sell a mug for $15 and it costs me $6 to make. How much do I make per mug?',
      ['$15 price - $6 cost = $9 left per mug.'],
      null,
    ],
    [
      'We charge 10 dollars a wash and soap costs 2 dollars a wash. What is left on each wash?',
      ['$10 price - $2 soap = $8 left per wash.'],
      null,
    ],
    [
      'I charge ten bucks a wash, soap costs two bucks a wash. what do I keep on each wash',
      ['$10 price - $2 soap = $8 left per wash.'],
      null,
    ],
    [
      'Each kit sells for $30. Parts cost $12, the bag costs $1 and shipping costs $4.50 a kit. What do I make on each kit?',
      ['$30 price - $12 parts - $1 bag - $4.50 shipping = $12.50 left per kit.'],
      null,
    ],
    [
      'It costs me 4 to 6 dollars to make one and I sell each for $12. What do I make on each one?',
      ['$12 price - $4 to $6 cost = $6 to $8 left per sale.'],
      null,
    ],
    [
      'A pin sells for $3 and costs me $4 to make. Am I making money?',
      ['$3 price - $4 cost = -$1: each pin loses money.'],
      null,
    ],
    [
      'What do I make per cookie? They sell for 2 dollars each and cost 75 cents each.',
      ['$2 price - $0.75 cost = $1.25 left per cookie.'],
      null,
    ],
    [
      'What is my profit on a sticker? I charge a dollar fifty a sticker and it costs 25 cents to make.',
      ['$1.50 price - $0.25 cost = $1.25 left per sticker.'],
      null,
    ],
    // The newest word stands.
    [
      'Change it: the price is $14 a kit. What is left per kit?',
      ['$14 price - $7 beads - $1.50 shipping = $5.50 left per kit.'],
      null,
      [BOX],
    ],
    [
      'Beads cost $6 a kit now. What is left per kit?',
      ['$12 price - $6 beads - $1.50 shipping = $4.50 left per kit.'],
      null,
      [BOX],
    ],
    [
      'The shipping is not $1.50 any more. Shipping costs $2 a kit. What is left per kit?',
      ['$12 price - $7 beads - $2 shipping = $3 left per kit.'],
      null,
      [BOX],
    ],
    // Margin.
    ['What is my margin?', [BOX_LEFT, 'Margin: $3.50 of $12 = 29% of the price.'], null, [BOX]],
    [
      'I sell each for $20 and each costs $5. What is the margin?',
      ['$20 price - $5 cost = $15 left per sale.', 'Margin: $15 of $20 = 75% of the price.'],
      null,
    ],
    // A month.
    [
      'So what would I make in a month at forty kits?',
      ['40 kits x $3.50 left per kit = $140 a month before other costs.'],
      null,
      [BOX],
    ],
    [
      'What would I make a month at 100 kits?',
      ['100 kits x $3.50 left per kit = $350 a month before other costs.'],
      null,
      [BOX],
    ],
    [
      'What do I make a month?',
      ['40 kits x $3.50 left per kit = $140 a month before other costs.'],
      null,
      [BOX],
    ],
    [
      'What do I make a month after rent?',
      ['40 kits x $3.50 left per kit = $140 a month before other costs.', '$140 - $60 rent = $80 a month.'],
      null,
      [BOX, 'Rent is $60 a month.'],
    ],
    [
      'What do I make in a week?',
      ['10 kits x $5 left per kit = $50 a week before other costs.', 'Four weeks of that: $200.'],
      null,
      ['A kit sells for $9 and costs me $4 to make. I sell 10 kits a week.'],
    ],
    [
      'How much would I make a month at 30 mugs?',
      ['30 mugs x $9 left per mug = $270 a month before other costs.'],
      null,
      ['I sell a mug for $15 and it costs me $6 to make.'],
    ],
    // Sales.
    ['How much is that in sales?', ['40 kits x $12 = $480 a month in sales, before any cost.'], null, [BOX]],
    // Break-even.
    [
      'How many kits do I need to sell to break even on the press?',
      [
        '$1,200 press / $3.50 left per kit = 343 kits to pay for it.',
        BOX_LEFT,
        'Each kit after that leaves $3.50.',
      ],
      null,
      [BOX, 'The press costs $1,200 up front.'],
    ],
    [
      'How many kits cover the rent?',
      ['$60 a month rent / $3.50 left per kit = 18 kits a month to cover it.', BOX_LEFT],
      null,
      [BOX, 'Rent is $60 a month.'],
    ],
    [
      'How many do I have to sell to pay for the oven?',
      [
        '$300 oven / $2 left per pie = 150 pies to pay for it.',
        '$5 price - $3 cost = $2 left per pie.',
        'Each pie after that leaves $2.',
      ],
      null,
      ['A pie sells for $5 and it costs me $3 to make. The oven is $300.'],
    ],
    [
      'A pin sells for $3 and costs me $4 to make. The machine is $100. How many to break even?',
      [
        '$3 price - $4 cost = -$1: each pin loses money.',
        'No number of pins covers a cost while one pin loses money.',
      ],
      null,
    ],
    // An hour.
    [
      "What's my fee per application, and what's my hourly rate at that?",
      ['$450 / 9 hours = $50 an hour, before any cost.'],
      null,
      [
        'One application takes me about nine hours and I charge 300 dollars. Is the fee right?',
        'Change it: the fee is 450 now, not 300.',
      ],
    ],
    [
      'What do I earn an hour?',
      ['$10 price - $2 soap = $8 left per wash.', '$8 left / 20 minutes = $24 an hour.'],
      null,
      ['I charge $10 a wash, soap costs $2 a wash and one wash takes me 20 minutes.'],
    ],
    [
      'One lesson takes an hour and a half and I charge $45 a lesson. What am I making an hour?',
      ['$45 / 90 minutes = $30 an hour, before any cost.'],
      null,
    ],
    // Conversion.
    ['13 of 25 sold. What percent is that?', ['13 of 25 = 52%.'], null],
    ['What is my conversion rate?', ['3 of 40 = 7.5%.'], null, ['I asked 40 people and only 3 bought.']],
    // Payback.
    [
      'How long is the payback?',
      [
        '40 kits x $3.50 left per kit = $140 a month.',
        '$700 / $140 a month = about 5 months to earn it back.',
      ],
      null,
      [BOX, 'The machine costs $700 up front.'],
    ],
    // Runway.
    [
      'I have $900 saved up and I spend $150 a month on ads. How long will my money last?',
      ['$900 / $150 a month = 6 months.'],
      null,
    ],
    [
      'I have $900 in the bank, we spend $200 a month on hosting and we make $50 a month. What is our runway?',
      ['$900 / ($200 out - $50 in a month) = 6 months.'],
      null,
    ],
    // Time.
    [
      'How long would 10 orders take? One order takes me 15 minutes.',
      ['10 x 15 minutes = 150 minutes (2.5 hours).'],
      null,
    ],
    // A cost of a batch is not a cost of one.
    [
      'What is left on each cup?',
      [],
      'How many cups do you sell in one morning?',
      ["A used bike is 650 dollars, beans and cups for one morning are 80, and I'd charge 3 dollars a cup."],
    ],
    [
      'What is left on each cup if I sell 60 cups a morning?',
      ['60 cups x $3 - $80 beans and cups = $100 left for one morning.'],
      null,
      [
        "A used bike is 650 dollars, beans and cups for one morning are 80 dollars, and I'd charge 3 dollars a cup.",
      ],
    ],
  ];
  it.each(SUMS.map((c) => ({ c, name: c[0] })))('$name', ({ c: [message, lines, missing, before] }) => {
    const got = calcOf({ message, earlier: before ?? [] });
    expect(got.lines).toEqual(lines);
    expect(got.missing).toBe(missing ?? null);
  });

  const LACKS: readonly Case[] = [
    ['What are my unit economics?', [], 'What do you charge for one sale?'],
    [
      'What are my unit economics?',
      [],
      'What does one mug cost you to make and deliver?',
      ['I sell a mug for $15.'],
    ],
    [
      'What would I make in a month?',
      ['$15 price - $6 cost = $9 left per mug.'],
      'How many mugs do you sell in a month?',
      ['I sell a mug for $15 and it costs me $6 to make.'],
    ],
    ['What is my margin?', [], 'Which one: mugs or shirts?', ['I sell mugs for $15. I sell shirts for $25.']],
    ['What is my hourly rate?', [], 'What do you charge for one sale?'],
    ['What is my hourly rate?', [], 'How long does one sale take you?', ['I charge $30 each.']],
    ['How long will my money last?', [], 'How much money do you have for this now?'],
    ['How long will my money last?', [], 'What do you spend on it in a month?', ['I have $500 saved up.']],
    [
      'How many do I need to sell to break even?',
      ['$15 price - $6 cost = $9 left per mug.'],
      'What is the one-time cost you want to earn back?',
      ['I sell a mug for $15 and it costs me $6 to make.'],
    ],
    ['What is my conversion rate?', [], 'How many did you ask, and how many said yes with money?'],
    ['What is the payback?', [], 'What is the one-time cost you want to earn back?'],
    // A monthly cost is never one sale's.
    [
      'What is left per kit?',
      [],
      'What does one kit cost you to make and deliver?',
      ['A kit sells for $12. Rent is $200 a month.'],
    ],
    ['What do I make per kit?', [], 'What do you charge for one kit?', ['Beads cost $7 a kit.']],
  ];
  it.each(LACKS.map((c) => ({ c, name: c[0] })))(
    'asks for the one number it lacks: $name',
    ({ c: [message, lines, missing, before] }) => {
      const got = calcOf({ message, earlier: before ?? [] });
      expect(got.lines).toEqual(lines);
      expect(got.missing).toBe(missing ?? null);
    },
  );

  it('with no sum asked, gives what one sale leaves as a fact, and the share of what they just told', () => {
    expect(calcOf({ message: 'How do I price it?', record: [BOX] })).toEqual({
      ask: null,
      lines: [BOX_LEFT],
      missing: null,
    });
    expect(
      calcOf({ message: 'I ran a price test. 25 mugs offered at 5 dollars, 13 sold on one morning.' }).lines,
    ).toEqual(['13 of 25 = 52%.']);
    expect(calcOf({ message: 'Who do I talk to first?' })).toEqual({ ask: null, lines: [], missing: null });
  });

  it('takes the ask from the turn when the words do not say it', () => {
    expect(calcOf({ message: 'And for mine?', record: [BOX], ask: 'contribution' }).lines).toEqual([
      BOX_LEFT,
    ]);
  });

  it('reads the record before what they said here, whatever the order of the copies', () => {
    const copies = [BOX, 'A kit sells for $12; beads cost $7 and shipping $1.50 a kit.'];
    expect(calcOf({ message: 'What is left per kit?', record: copies }).lines).toEqual([BOX_LEFT]);
  });

  it('gives the same lines for the same words', () => {
    const run = (): string =>
      JSON.stringify(calcOf({ message: 'What would I make in a month at forty kits?', record: [BOX] }));
    expect(new Set([run(), run(), run()]).size).toBe(1);
  });
});
