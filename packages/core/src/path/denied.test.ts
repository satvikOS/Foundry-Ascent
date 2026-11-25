import { describe, expect, it } from 'vitest';

import { deniedGrowth, tellsDecline } from './denied.js';
import { memory, NO_READS } from './testing/inputs.js';
import { onStep, readTurnOf, replyOf } from './testing/understood.js';

const FEWER = 'Forty-two stalls rented a cart in the first month; thirty-one rent one in the third.';

describe('a claim of growth their record denies', () => {
  it.each([
    FEWER,
    'Nine bakers pay each week, down from fourteen in June.',
    'Members fell from 80 to 64 over the summer.',
    '55 people came in May, 40 came in October.',
  ])('%s tells a decline', (fact) => {
    expect(tellsDecline(fact)).toBe(true);
  });
  it.each([
    'Thirty-one stalls rented a cart in the first month; forty-two rent one in the third.',
    'Wait fell from 30 to 12 minutes in the second week.',
    'Nine of 14 bakers came back.',
    'A cart costs 40 dollars, 25 in the second month.',
    'You hope for 80 members now and 60 later.',
    'You sold 12 carts.',
  ])('%s tells none', (fact) => {
    expect(tellsDecline(fact)).toBe(false);
  });

  it('is named first, with both numbers', () => {
    expect(deniedGrowth('I told the judges we grew every month, okay?', [FEWER])?.text).toBe(
      'Not quite, by your own record: forty-two stalls rented a cart in the first month; thirty-one rent one in the third. Say both numbers, before somebody else does.',
    );
  });
  it.each([
    'how do we get growing again?',
    'we want to grow steadily',
    'the dough is growing mould? no',
    'is it okay?',
  ])('nothing is denied in "%s"', (message) => {
    expect(deniedGrowth(message, message.includes('mould') ? [] : [FEWER])).toBeNull();
  });
  it('nor where the record says nothing of it', () => {
    expect(deniedGrowth('we have steady growth', ['Nine of 14 bakers came back.'])).toBeNull();
  });

  it('and nothing beside it agrees', () => {
    const message = 'i told her growth has been steady, thats fine right?';
    const t = readTurnOf(message, null, {
      reads: {
        ...NO_READS,
        steps: [onStep('retention')],
        memory: [memory({ type: 'evidence', title: 'Carts', content: FEWER })],
      },
    });
    const reply = replyOf(
      t,
      message,
      "Yes, that's fine. It matches what you told me before. Write her the two months side by side, and ask eight who stopped why.",
      'text',
      FEWER,
    );
    expect(reply).toMatch(/^Not quite, by your own record: forty-two stalls/);
    expect(reply).not.toMatch(/that's fine|matches/);
    expect(reply).toContain('side by side');
  });
});
