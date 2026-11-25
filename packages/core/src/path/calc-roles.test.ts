/**
 * The calculator's precision: what it leads with is right, and where the words can be read two ways it says nothing
 * (`unsure`) and the model answers with a sum of its own. Synthetic founders, many wordings, traps.
 */
import { describe, expect, it } from 'vitest';

import { calcOf } from './calc.js';

interface Case {
  readonly q: string;
  readonly record?: readonly string[];
  readonly earlier?: readonly string[];
  /** The line it opens with; null: no sum is asked; 'unsure': asked, and not told here. */
  readonly says: string | null;
}
const c = (
  q: string,
  record: string | readonly string[],
  says: string | null,
  earlier: readonly string[] = [],
): Case => ({
  q,
  record: typeof record === 'string' ? [record] : record,
  earlier,
  says,
});

const LAMP = 'A lamp sells for 26 dollars; the wire is 7 dollars, the shade 4 and the plug 2.';
const LIFT = 'A lift is 8 dollars; the driver gets 5 and the payment fee is 40 cents.';
const TEAMS =
  'Twenty teams paid 12 dollars a month in the first month of term; five of them cancelled in the second.';
const POSTERS =
  'Ninety posters were handed out for 45 dollars; fifteen people came to the page and five ordered at 18 dollars.';
const CANDLE = 'A candle sells for 16 dollars and costs me 5 dollars to make.';
const PRINT = 'A print sells for 20 dollars; ink is 3 dollars.';
const BOWL = 'A bowl sells for 28 dollars and costs me 8 dollars to make.';

const run = ({ q, record = [], earlier = [], says }: Case): void => {
  const got = calcOf({ message: q, record, earlier });
  if (says === null) expect(got.ask, JSON.stringify(got)).toBeNull();
  else if (says === 'unsure') {
    expect(got.unsure, JSON.stringify(got)).toBe(true);
    expect(got.lines).toEqual([]);
    expect(got.missing).toBeNull();
  } else {
    expect(got.ask).not.toBeNull();
    expect(got.lines[0], JSON.stringify(got)).toBe(says);
  }
};

describe('roles said beside the number', () => {
  it.each([
    c('What do I make on one lamp?', LAMP, '$26 price - $7 wire - $4 shade - $2 plug = $13 left per lamp.'),
    c(
      "What's left for me on one lift?",
      LIFT,
      '$8 price - $5 driver - $0.40 payment fee = $2.60 left per lift.',
    ),
    c(
      'What are my unit economics?',
      'A hat sells for 30 dollars; yarn is 10 dollars and knitting 7 dollars.',
      '$30 price - $10 yarn - $7 knitting = $13 left per hat.',
    ),
    c(
      'What do I make per wash?',
      'I pay the washer 8 dollars a wash and charge 14 dollars a wash.',
      '$14 price - $8 cost = $6 left per wash.',
    ),
    c(
      'What do I make per wash?',
      'We charge 14 a wash. The printer charges me 4 dollars a wash.',
      '$14 price - $4 printer = $10 left per wash.',
    ),
    c(
      'What do I make on each shirt?',
      'Shirts go for 22 dollars each, blanks run me 7, printing 5.',
      '$22 price - $7 blanks - $5 printing = $10 left per shirt.',
    ),
    c(
      'What do I make on each shirt?',
      'I used to sell a shirt for 18 dollars, now I sell a shirt for 22 dollars. It costs me 7 to make.',
      '$22 price - $7 cost = $15 left per shirt.',
    ),
    c(
      'What do I make per lesson?',
      'Parents pay 40 dollars a lesson, the tutor gets 25, the room is 5 a lesson.',
      '$40 price - $25 tutor - $5 room = $10 left per lesson.',
    ),
    c(
      'What do I make on one cake?',
      'A cake costs the customer 25 dollars and flour costs me 5.',
      '$25 price - $5 flour = $20 left per cake.',
    ),
    c(
      'What do I make on one cake?',
      'Each cake costs me 9 dollars, 5 for flour and 4 for butter. I sell a cake for 25 dollars.',
      '$25 price - $9 cost = $16 left per cake.',
    ),
    c(
      'What is left on a print?',
      'A print sells for 20 dollars and paper costs 4. The app takes 15 percent of each sale.',
      '$20 price - $4 paper - $3 app (15%) = $13 left per print.',
    ),
    c(
      'What do I make per ride?',
      'We charge 12 dollars a ride and Uber takes 25 percent.',
      '$12 price - $3 uber (25%) = $9 left per ride.',
    ),
    c(
      'What do I make per ride?',
      'We charge 12 dollars a ride. Gas is 2 dollars a ride and insurance is 90 a month.',
      '$12 price - $2 gas = $10 left per ride.',
    ),
    c(
      'What is my margin?',
      'We sell a tote for 18 dollars. Blank totes cost 4.50 each, ink 1.25, and card fees are 80 cents.',
      '$18 price - $4.50 blank totes - $1.25 ink - $0.80 card fees = $11.45 left per tote.',
    ),
    c('What is left on a print?', PRINT, '$20 price - $3 ink - $4 shipping = $13 left per print.', [
      'Plus shipping costs 4 dollars a print.',
    ]),
    c('What if I charge 25, what is left on a print?', PRINT, '$25 price - $3 ink = $22 left per print.'),
    c(
      'Should I charge 20 instead? What would be left?',
      CANDLE,
      '$20 price - $5 cost = $15 left per candle.',
    ),
    c(
      'Am I losing money?',
      'We sell a tote for 18 dollars and it costs me 21 dollars to make.',
      '$18 price - $21 cost = -$3: each tote loses money.',
    ),
  ])('$q <- $record', run);
});

describe('a word of cost that is the thing sold', () => {
  it.each([
    c(
      "What's left for me on one delivery?",
      'A delivery is 9 dollars; the rider gets 6 and the payment fee is 60 cents.',
      '$9 price - $6 rider - $0.60 payment fee = $2.40 left per delivery.',
    ),
    c(
      'What is left on a print?',
      'A print sells for 20 dollars; delivery is 3 dollars a print.',
      '$20 price - $3 delivery = $17 left per print.',
    ),
  ])('$q <- $record', run);
});

describe('so many of them, a month, a fixed cost', () => {
  it.each([
    c(
      'A stall at the spring market is 78 dollars. Say I sell 20 lamps there. What would be left?',
      LAMP,
      '20 lamps x $13 left per lamp - $78 stall = $182 left.',
    ),
    c(
      'If I sell 30 candles at the fair and the table is 50 dollars, what do I keep?',
      CANDLE,
      '30 candles x $11 left per candle - $50 table = $280 left.',
    ),
    c(
      'what would I have left from 30 candles after a 50 dollar table?',
      CANDLE,
      '30 candles x $11 left per candle - $50 table = $280 left.',
    ),
    c(
      'I make soup 7 dollar, cost me 4. If sell 80 how much stay for me?',
      'A soup sells for 7 dollars and costs 4 to make.',
      '80 soups x $3 left per soup = $240 before other costs.',
    ),
    c('What do I make on 30 candles?', CANDLE, '30 candles x $11 left per candle = $330 before other costs.'),
    c(
      'And how many lamps before the stall has paid for itself?',
      LAMP,
      '$78 stall / $13 left per lamp = 6 lamps to pay for it.',
      [
        'What do I make on one lamp?',
        'A stall at the spring market is 78 dollars. Say I sell 20 lamps there. What would be left?',
      ],
    ),
    c(
      'A van is 260 a month to rent. How many lifts a month pay for it?',
      LIFT,
      '$260 a month van / $2.60 left per lift = 100 lifts a month to cover it.',
    ),
    c(
      'how many shirts to cover the press?',
      'A shirt sells for 22 dollars and costs me 7 to make. The press is 300 dollars. A table is 50 dollars.',
      '$300 press / $15 left per shirt = 20 shirts to pay for it.',
    ),
    c(
      'How many bowls to break even on the kiln?',
      [`${BOWL} The kiln was 900 dollars.`],
      '$900 kiln / $20 left per bowl = 45 bowls to pay for it.',
    ),
    c(
      'How many do I sell to cover 150 dollars of rent?',
      BOWL,
      '$150 rent / $20 left per bowl = 8 bowls to pay for it.',
    ),
    c(
      'How much revenue is that?',
      'A candle sells for 16 dollars.',
      '25 candles x $16 = $400 a month in sales, before any cost.',
      ['I sell 25 candles a month.'],
    ),
    c(
      'What do I earn an hour?',
      [CANDLE, 'One candle takes me 20 minutes.'],
      '$16 price - $5 cost = $11 left per candle.',
    ),
    c(
      'How long would it take to make 10 candles?',
      [CANDLE, 'One candle takes me 20 minutes.'],
      '10 candles x 20 minutes = 200 minutes (3.3 hours).',
    ),
    c(
      'How long will my money last?',
      'I have 1200 dollars saved and spend 150 a month on hosting and 50 a month on ads.',
      '$1,200 / $200 a month = 6 months.',
    ),
    c(
      'How much money do I need before I can start?',
      [],
      '$500 used bike + $60 leaves and cups = $560 for the first morning.',
      [
        "I'd sell tea from a bike outside. A used bike is 500 dollars, leaves and cups for one morning are 60, and I'd charge 2 dollars a cup.",
      ],
    ),
    c(
      'How much cash would I need before I can get started?',
      [],
      '$500 used bike + $60 leaves and cups = $560 for the first morning.',
      ['A used bike is 500 dollars, leaves and cups for one morning are 60 dollars.'],
    ),
    c('How much is a quarter hour at 36 dollars an hour?', [], '$36 an hour / 4 = $9 for a quarter hour.'),
  ])('$q <- $record', run);
});

describe('follow-ups go on from the sum before', () => {
  it.each([
    c('And if I do fifty a week?', LIFT, '50 lifts x $2.60 left per lift = $130 a week before other costs.', [
      "What's left for me on one lift?",
    ]),
    c('ok and at 25 a week?', CANDLE, '25 candles x $11 left per candle = $275 a week before other costs.', [
      'How much do I make per candle?',
    ]),
    c(
      'What about 200 a month?',
      CANDLE,
      '200 candles x $11 left per candle = $2,200 a month before other costs.',
      ['How much do I make per candle?'],
    ),
    c('And 30 of them?', CANDLE, '30 candles x $11 left per candle = $330 before other costs.', [
      'How much do I make per candle?',
    ]),
    c('What if I sell 30?', CANDLE, '30 candles x $11 left per candle = $330 before other costs.', [
      'How much do I make per candle?',
    ]),
    c('and if it costs me 7 to make?', CANDLE, '$16 price - $7 cost = $9 left per candle.', [
      'How much do I make per candle?',
    ]),
    c('And at 18 dollars?', CANDLE, 'unsure', ['How much do I make per candle?']),
    c('what if wax goes up to 6 dollars?', CANDLE, 'unsure', ['How much do I make per candle?']),
    c('And for 40 people?', CANDLE, null, ['How much do I make per candle?']),
    c('And if 30 people come?', CANDLE, null, ['How much do I make per candle?']),
    c('And if I do fifty a week?', LIFT, null, ['Who is my first customer?']),
    c('What about 200 a month?', CANDLE, null, ['What is my runway?']),
  ])('$q <- $earlier', run);
});

describe('shares, what one cost to win, a price for a margin', () => {
  it.each([
    c('What share of my teams did I lose in the second month?', TEAMS, '5 of 20 teams = 25%.'),
    c("So what's coming in a month now?", TEAMS, '20 - 5 = 15 teams, and 15 x $12 = $180 a month.'),
    c(
      'If the same share leaves again next month, how many teams do I have?',
      TEAMS,
      '25% of 15 teams is about 3.8, so about 11 teams stay.',
    ),
    c(
      'If the same share leaves again next month, how many do I have?',
      'Sixteen clubs paid us; eight of them left.',
      '50% of 8 clubs is 4, so 8 - 4 = 4 clubs.',
    ),
    c('What is my churn?', 'We started with 40 members and 6 cancelled.', '6 of 40 members = 15%.'),
    c('What did it cost me to win one order?', POSTERS, '$45 spent / 5 orders = $9 to win one order.'),
    c('What share of the posters turned into an order?', POSTERS, '5 of the 90 posters = 5.6%.'),
    c(
      'What is my customer acquisition cost?',
      'I spent 30 dollars on ads and 45 dollars on flyers; 5 bought.',
      '$75 spent / 5 customers = $15 to win one customer.',
    ),
    c(
      'What did a signup cost me?',
      'I spent 30 dollars on ads and 12 people signed up.',
      '$30 spent / 12 signups = $2.50 to win one signup.',
    ),
    c('What share is that, and is it enough?', 'Kept 2 of 5.', '3 of 40 = 7.5%.', [
      'I offered the app to 40 parents at 4 dollars a month. 3 paid.',
    ]),
    c(
      'One word. East or west?',
      'In the east hall five of 20 rooms signed up; in the west hall nine of 60 did.',
      'East: 5 of 20 = 25%; west: 9 of 60 = 15%.',
    ),
    c(
      'Which is better, the dorm or the gym?',
      'At the dorm 8 of 40 bought, at the gym 9 of 30 bought.',
      'Gym: 9 of 30 = 30%; dorm: 8 of 40 = 20%.',
    ),
    c(
      'Dorm or gym?',
      'At the dorm 8 of 40 cancelled, at the gym 9 of 30 cancelled.',
      'Dorm: 8 of 40 = 20%; gym: 9 of 30 = 30%.',
    ),
    c(
      'A jar costs me 6 dollars to make and post. What do I charge to keep 25 percent of the price?',
      [],
      '$6 cost is the other 75% of the price, so $6 / 0.75 = $8.',
    ),
    c(
      'What do I charge for a 40 percent margin?',
      'A jar costs me 6 dollars to make.',
      '$6 cost is the other 60% of the price, so $6 / 0.6 = $10.',
    ),
    c(
      'What price gives me a 40 percent margin?',
      'A bowl costs me 8 dollars to make.',
      '$8 cost is the other 60% of the price, so $8 / 0.6 = $13.33.',
    ),
    c(
      'What do I charge with a 50 percent markup?',
      'A jar costs me 6 dollars to make.',
      '$6 cost + 50% of it = $9.',
    ),
  ])('$q <- $record', run);
});

describe('two readings, or a number with no place: it does not lead', () => {
  it.each([
    c('What do I make on one mug?', 'A mug is 8 dollars. I sell it for 20.', 'unsure'),
    c('What do I make on one mug?', 'Mugs: 8 dollars, clay 3.', 'unsure'),
    c('What do I make on one cake?', 'A cake costs 9 dollars.', 'unsure'),
    c(
      'What do I make on one cake?',
      'Each cake costs me 9 dollars. I sell a cake for 25 dollars. Butter is 3 dollars.',
      'unsure',
    ),
    c('What do I make on one lift?', 'A lift is 8 dollars; the payment fee is 40 cents.', 'unsure'),
    c(
      'What is left on a print?',
      'I sell a print for 20 dollars, or 15 for students. Paper costs 4 a print.',
      'unsure',
    ),
    c(
      'What is left on a print?',
      'I sell prints at 3 for 20 dollars. Paper costs 2 dollars a print.',
      'unsure',
    ),
    c('What is left on a print?', 'I sell a print for 20 cedis and paper is 4 cedis.', 'unsure'),
    c('What is left on a print?', 'A print sells for 20 dollars. A roll of paper is 30 dollars.', 'unsure'),
    c('What is left on a print?', PRINT, 'unsure', ['Paper costs 4 dollars.']),
    c('What if I raise the price by 2 dollars, what is left on a print?', PRINT, 'unsure'),
    c('What is left on a print at 20 percent off?', PRINT, 'unsure'),
    c(
      'What do I make per wash?',
      'We add a booking fee of 2 dollars. A wash is 12 dollars and soap costs me 1.',
      'unsure',
    ),
    c(
      'What do I make per wash?',
      'Customers pay me 14 dollars; 8 goes to the washer, 1 to the app.',
      'unsure',
    ),
    c('What do I make per candle?', 'I sold 12 candles for 192 dollars and spent 60 on wax.', 'unsure'),
    c('What do I make per candle?', 'I sold 12 candles at 16 dollars each and spent 60 on wax.', 'unsure'),
    c('What do I make per candle?', 'A candle sells for 16 dollars. I spent 60 dollars on wax.', 'unsure'),
    c(
      'What do I make per candle?',
      'A candle sells for 16 dollars, wax is 4 and the shop keeps half.',
      'unsure',
    ),
    c(
      'What do I make per candle?',
      'A candle sells for 16 dollars, wax is 4 and I pay a helper 15 dollars an hour.',
      'unsure',
    ),
    c(
      'What do I make per cookie?',
      'I sell cookies by the dozen for 18 dollars; each costs me 50 cents.',
      'unsure',
    ),
    c(
      'What do I make per cookie?',
      'A pack of 6 sells for 12 dollars; each cookie costs me 1 dollar.',
      'unsure',
    ),
    c('What do I make per cup?', 'Beans are 14 dollars a pound; a cup sells for 3 dollars.', 'unsure'),
    c(
      'What do I make per kit?',
      'Nobody would pay 12 dollars. Four said they would pay 8 dollars a kit. It costs me 3 to make.',
      'unsure',
    ),
    c(
      'What do I make per ride?',
      'Uber charges 12 dollars a ride. My gas costs me 2 dollars a ride.',
      'unsure',
    ),
    c(
      'What do I make per box?',
      'Subscribers pay 20 dollars a month for a box. Snacks cost 11 dollars a box and postage 4 a box.',
      'unsure',
    ),
    c(
      'What do I make per lesson?',
      'Parents pay 40 dollars a lesson now at the center. I would charge 30.',
      'unsure',
    ),
    c('Am I losing money?', 'A tote sells for 18 dollars; a blank is 21 dollars.', 'unsure'),
    c('Am I losing money?', 'Totes 18 dollars, blanks 21.', 'unsure'),
    c('What do I make a month if clay goes to 8?', [CANDLE, 'I sell 25 candles a month.'], 'unsure'),
    c('What do I keep on a candle after 3 refunds?', CANDLE, 'unsure'),
    c(
      'what would be left if I sell 10 shirts and pay 30 dollars for gas?',
      'A shirt sells for 22 dollars and costs me 7 to make.',
      'unsure',
    ),
    c('How many candles do I need to sell to make 500 dollars?', CANDLE, 'unsure'),
    c('I want 500 dollars profit, how many candles do I sell?', CANDLE, 'unsure'),
    c(
      'How many clients cover my rent?',
      'Clients pay me 50 dollars a month. Rent is 300 dollars a month.',
      'unsure',
    ),
    c('What do I charge to make 40 percent?', 'A jar costs me 6 dollars to make.', 'unsure'),
    c(
      'What share of my members cancelled?',
      'We had 30 members in May and 24 in June; three left.',
      'unsure',
    ),
    c('What is my churn?', '40 members, 6 left last month, 3 joined.', 'unsure'),
    c('What is my conversion rate?', 'Asked 20, 4 bought. Emailed 50, 5 replied.', 'unsure'),
    c('What share is that?', 'Kept 2 of 5.', 'unsure', ['I asked 9 teachers about it. 7 love it.']),
    c(
      'What did each customer cost me to get?',
      'I spent 30 dollars on ads and 45 on flyers, 12 people signed up and 5 bought.',
      'unsure',
    ),
    c('How long will my money last?', 'I have 1200 dollars saved and spend 100 a week.', 'unsure'),
  ])('$q <- $record $earlier', run);
});

describe('told twice, told by others, told for later', () => {
  const BAG = 'I sell each bag for 14 dollars and it costs me 6 dollars to make.';
  it.each([
    c(
      'What do I make per bag?',
      [BAG, 'We decided to raise the price to 18 dollars.'],
      '$18 price - $6 cost = $12 left per bag.',
    ),
    c(
      'What do I make per bag?',
      [BAG, 'We will sell each bag for 20 dollars next year.'],
      '$14 price - $6 cost = $8 left per bag.',
    ),
    c('What do I make per bag?', [BAG, 'The first version sold for 9 dollars a bag.'], 'unsure'),
    c(
      'What do I make per bag?',
      ['We sell each bag for 14 dollars, each costs us 6 dollars, and we donate 1 dollar a bag.'],
      'unsure',
    ),
    c('What is left if I give 10% to charity?', BAG, 'unsure'),
    c('What is left per bag for my cofounder and me if we split it?', BAG, 'unsure'),
    c('what do i keep per bag after the school takes its 2 dollar cut', BAG, 'unsure'),
    c(
      'How many subscribers do I need to cover the server?',
      'A subscription is 9 dollars a month; the server is 120 dollars a month.',
      'unsure',
    ),
    c('I emailed 400 and 18 replied, and 6 of those bought. What percent bought?', [], 'unsure'),
    c('My conversion is 5%. If I email 400, how many buy?', [], 'unsure'),
    c('We lost 3 of 24 members. What is my churn?', [], '3 of 24 members = 12.5%.'),
    c(
      'We have $5000 from the grant and we spend $600 a month on rent, $200 a month on ads and earn $300 a month. Runway?',
      [],
      '$5,000 / ($800 out - $300 in a month) = 10 months.',
    ),
    c(
      'Wholesale to the bookstore is 7 dollars, retail 12, each costs me 4. What is my margin?',
      [],
      'unsure',
    ),
    c(
      'ok so if i charge 15 bucks for a cut and my clippers cost like 2 bucks per cut what am i making per cut',
      [],
      '$15 price - $2 clippers = $13 left per cut.',
    ),
    c('What did Maya make on one bag last week?', BAG, null),
    c('What do they make on one bag?', BAG, null),
    c('What would Canvas Co make on one bag?', BAG, null),
  ])('$q <- $record', run);
});

describe('no sum of theirs is asked', () => {
  it.each(
    [
      'What margin do other bakeries make?',
      'What is a good margin?',
      'What does break-even mean?',
      'What is churn?',
      'What do I make first?',
      'What do I make of that?',
      'What is left to do?',
      'What do I keep in the pitch?',
      'What percent of parents have this problem?',
      'What share do I give my cofounder?',
      'How long would it take to get 10 customers?',
      'How long to visit 10 shops?',
      'How many months do I have before the competition?',
      'Can I test 3 people an hour?',
      'Should I set a goal with 20 percent growth?',
      'Would you charge 20 for it?',
      'Campus or downtown?',
      'What is the margin of error in a survey?',
    ].map((q) => c(q, [CANDLE], null)),
  )('$q', run);
});

describe('what it never says', () => {
  it('a fee they pay is never the price, and no sale is said to lose money on a guess', () => {
    for (const record of [
      'A lift is 8 dollars; the driver gets 5 and the payment fee is 40 cents.',
      'The payment fee is 40 cents and a lift is 8 dollars; the driver gets 5.',
      'A lift is 8 dollars, the platform fee is 2 dollars, the driver gets 5 dollars.',
      'Card fees are 40 cents. The driver gets 5. A lift is 8 dollars.',
      'We pay a listing fee of 3 dollars. A lift is 8 dollars; the driver gets 5.',
      'A lift is 8 dollars and delivery is 9 dollars.',
      'A lift: 8 dollars. Driver: 12 dollars.',
    ])
      for (const q of [
        "What's left for me on one lift?",
        'What is my margin?',
        'How many lifts to break even?',
      ]) {
        const got = calcOf({ message: q, record: [record] });
        expect(got.lines.join(' '), `${record} ${q}`).not.toMatch(
          /loses money|-\$|\$0\.40 price|\$2 price|\$3 price/,
        );
      }
  });

  it('the same words, any order of the same sentences, never two answers', () => {
    const parts = [
      'A lamp sells for 26 dollars.',
      'The wire costs 7 dollars a lamp.',
      'The shade costs 4 dollars a lamp.',
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [1, 2, 0],
    ]) {
      const record = order.map((i) => parts[i] ?? '');
      const got = calcOf({ message: 'What do I make on one lamp?', record });
      expect(got.lines[0], record.join(' ')).toMatch(/ = \$15 left per lamp\.$/);
      const together = calcOf({ message: 'What do I make on one lamp?', record: [record.join(' ')] });
      expect(together.lines[0], record.join(' ')).toMatch(/ = \$15 left per lamp\.$/);
    }
  });
});

describe('facts of their numbers, with no sum asked', () => {
  it.each([
    [
      'One edit takes me about eight hours and I charge 200 dollars. Is the fee right?',
      ['Charge 200 dollars an edit.'],
      '$200 / 8 hours = $25 an hour, before any cost.',
    ],
    [
      "So the gym pays 60 a month, and the pies go for 4, so if I sell 50 pies that's my second gym covered, right? My pie shop's the other thing I run.",
      ['One gym pays 60 dollars a month for two counters.'],
      '50 pies x $4 = $200 in sales, before any cost.',
    ],
    [
      'How should I price it?',
      [
        'I sell tutoring by the quarter hour.',
        'Six students booked a quarter hour; tutors on the student board ask 40 dollars an hour.',
      ],
      '$40 an hour / 4 = $10 for a quarter hour.',
    ],
  ])('%s', (message, record, line) => {
    const got = calcOf({ message, record });
    expect([got.ask, got.lines[0]]).toEqual([null, line]);
  });
});
