import { describe, expect, it } from 'vitest';

import { PLAYBOOK } from './playbook/index.js';
import { NO_READS } from './testing/inputs.js';
import { onStep, readTurnOf, replyOf } from './testing/understood.js';
import { offersForShares } from './referrals.js';

describe('money put to them for a part of the company', () => {
  it.each([
    'my godmother wants to give us 40k for 15%, is that ok?',
    'he offered $25,000 for 10 percent of it',
    'a guy from church would put in 60 thousand for a fifth',
    'an angel investor wants in before christmas',
    'she will invest 80k at a cap of 2 million',
    'the accelerator asked for 6% of the company in return',
    'the uncle of my partner offers 12 grand for some shares',
    '5k in exchange for 8% of the plum stall, fair?',
    'some angel offered us money',
    'um he said a hundred thousand for ten percent so',
    'two hundred people came. then a man put 30k on the table for a third of it',
  ])('%s', (message) => {
    expect(offersForShares(message)).toBe(true);
  });

  it.each([
    'we sell it at 20 dollars for 10% off this week',
    'I pay 30 dollars for 15% more sugar',
    'the market takes 10% of sales',
    'we charged 12 for half a tray',
    'what is an angel investor?',
    'how do I find an angel who invests in food?',
    'is it better to get grants, angel investors or a loan?',
    'do angel investors offer money to stalls?',
    'what would an angel want to see before they invest?',
    'we raised the price by 15%',
    'the shop gets 20% commission on every jar',
    'baseball caps cost 12 each, what price?',
    'the cap of the jar leaks',
    'we sold 40 for 25 each',
    'it costs 8 for a quarter pound',
    'she invested a lot of time in it',
    'I offered them 2 jars for 15 dollars',
    'the tutor gets 60% of the fee',
    'angel food cake sold out',
    'we did about a hundred for ten percent off',
    'my cofounder wants 40% of the company',
    'who gets a third of it when she leaves?',
  ])('not: %s', (message) => {
    expect(offersForShares(message)).toBe(false);
  });

  it('has who decides and the step of it, and the writer rules on nothing', () => {
    const message = 'my godmother offered 40k for 15%, good deal?';
    const t = readTurnOf(message, null, { reads: { ...NO_READS, steps: [onStep('retention')] } });
    expect(t.decision.referral?.category).toBe('securities_investment');
    expect(PLAYBOOK.plays.find((p) => p.id === t.decision.step?.view.playId)?.referral?.category).toBe(
      'securities_investment',
    );
    const reply = replyOf(
      t,
      message,
      'Good deal. Fifteen percent for that is a strong valuation. Do not put a number on it yet, and ask her for two weeks before you answer: what it is worth is what you and an investor agree on in a deal, and no stranger has paid yet.',
    );
    expect(reply).not.toMatch(/Good deal|strong valuation/);
    expect(reply).toMatch(/lawyer/);
    expect(reply).toContain('ask her for two weeks');
  });
});
