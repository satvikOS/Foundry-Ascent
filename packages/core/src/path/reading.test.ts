import { describe, expect, it } from 'vitest';

import { PLAYBOOK } from './playbook/index.js';
import {
  JUDGEMENT_PLAYS,
  gapFor,
  personalAnswer,
  problemIn,
  readingOf,
  type AnswerSource,
} from './reading.js';
import { type PriorSource } from './tell.js';
import { memory, NO_READS } from './testing/inputs.js';

const source = (content: string | null, over: Partial<PriorSource> = {}): PriorSource => ({
  oneLiner: 'Sails mended by the yard.',
  reads: {
    ...NO_READS,
    memory: content === null ? [] : [memory({ type: 'evidence', title: 'What happened', content })],
  },
  intake: null,
  earlier: [],
  message: 'Is this a real business?',
  about: '',
  said: '',
  venture: 'SailMend',
  ...over,
});
const read = (content: string | null, over: Partial<PriorSource> = {}, customer: string | null = null) =>
  readingOf(source(content, over), { customer, leftOver: false });

describe('what they have and what is missing, from the record', () => {
  it.each([
    ['One sail loft pays 300 dollars a month; returns there went from 12 percent to 7 percent.', 'one_paid'],
    ['Two lofts pay 80 dollars a month each.', 'some_paid'],
    ['Nine of 30 skippers bought a patch at 12 dollars.', 'some_paid'],
    ['30 skippers were asked to a paid course; 2 booked and paid.', 'some_paid'],
    ['One harbour master asked for a trial on one boat.', 'interest'],
    ['14 crews got a repair by hand; 6 fewer came back than the month before.', 'interest'],
    ['Eight skippers described a torn sail in the last month.', 'told'],
    ['My roommates said they would pay for it.', 'none'],
    ['Skippers opened the page 400 times and nobody paid.', 'interest'],
    ['A patch sells for 12 dollars and costs 4 to make.', 'none'],
    ['We paid 60 dollars for the stall.', 'none'],
    [null, 'none'],
  ])('%s: %s', (content, level) => {
    expect(read(content).level).toBe(level);
  });

  it('their best proof, with its number and who, then the nearest thing nobody has shown', () => {
    const one = read(
      'One sail loft pays 300 dollars a month; returns there went from 12 percent to 7 percent.',
    );
    expect(one.have).toBe(
      'You have one sail loft paying 300 dollars a month, and returns there went from 12 percent to 7 percent.',
    );
    expect(one.lacks).toBe('You do not have a second one who pays yet.');
    expect(read('One harbour master asked for a trial on one boat.').have).toBe(
      'You have this so far: one harbour master asked for a trial on one boat.',
    );
    // "Four pay" of a fact that says who is told whole.
    expect(read('Twelve crews use it; four pay 3 dollars a month.').have).toBe(
      'You have this so far: twelve crews use it; four pay 3 dollars a month.',
    );
    expect(read('Two lofts pay 80 dollars a month; one left last month.').lacks).toBe(
      'You do not know yet why the ones who left did (one left last month).',
    );
    expect(
      readingOf(source('Two lofts pay 80 dollars a month each.'), { customer: null, leftOver: true }).lacks,
    ).toBe('You do not have ten who pay and are not friends yet.');
  });

  it('with nothing on record it says so, and names the first thing to find out', () => {
    expect([read(null).have, read(null).lacks]).toEqual([
      '',
      'Nobody outside your own circle has told you about the last time they had this problem yet.',
    ]);
    expect(read(null, {}, 'Skippers').lacks).toBe(
      'You have not heard from skippers about the last time they had this problem yet.',
    );
  });

  it('what goes wrong today is theirs, in their words: never their plan or their line of it', () => {
    expect(
      problemIn(['Mending a sail here takes three weeks in spring and I could do it in two days.']),
    ).toBe('mending a sail here takes three weeks in spring');
    expect(read(null, { earlier: ['Sails get thrown out after one tear, all the time.'] }).have).toBe(
      'You have seen one thing: sails get thrown out after one tear, all the time.',
    );
    for (const none of [
      'SailMend repairs sails that crews throw away.',
      'I want to mend sails faster.',
      'How long does it take too long?',
      'My idea is a faster loft.',
    ])
      expect(problemIn([none], ['SailMend']), none).toBe('');
  });

  it('what is missing is what the ask is about', () => {
    const r = read('One harbour master asked for a trial on one boat.');
    expect(gapFor('pricing', r, 'SailMend')).toBe('No stranger has paid for SailMend yet.');
    expect(gapFor('pricing', r, 'New venture')).toBe('No stranger has paid for it yet.');
    expect(gapFor('valuation', r, 'SailMend')).toBe('You do not have anyone who paid or signed yet.');
    for (const about of ['find-ten-people', 'first-100-users', 'quit-or-continue'])
      expect(gapFor(about, r, 'SailMend')).toBe('');
  });
});

describe('the program’s answer to a judgement, made for them', () => {
  const PLAYS = new Map(PLAYBOOK.plays.map((p) => [p.id, p]));
  const made = (
    playId: string,
    content: string | null,
    over: Partial<AnswerSource> = {},
    customer: string | null = null,
  ) =>
    personalAnswer(playId, {
      reading: read(content, {}, customer),
      venture: 'SailMend',
      idea: 'Sails mended by the yard',
      customer: customer ?? '',
      answer: PLAYS.get(playId)?.answer ?? '',
      yesNo: false,
      facts: content === null ? [] : [content],
      message: '',
      ...over,
    });

  it('every play it reads is in the playbook', () => {
    for (const id of JUDGEMENT_PLAYS) expect(PLAYS.has(id), id).toBe(true);
  });

  it('"tell me it is great": their strength, their risk, and what would change the view', () => {
    const paid = made('honest-read', 'One sail loft pays 300 dollars a month.');
    expect(paid?.opens).toBe(true);
    expect(paid?.text).toBe(
      'I will not call it great, because neither of us knows yet. Its real strength: one sail loft pays 300 dollars a month. Its real risk: one payer can be the exception, and nobody knows until a second one pays the same price. A second payer at the same price this month would change my view.',
    );
    const none = made('honest-read', null, {}, 'skippers');
    expect(none?.text).toContain('So far there is only the idea, sails mended by the yard');
    expect(none?.text).toContain('the first thing to find out is what they did the last time');
    expect(none?.voice).toContain('sails mended by the yard');
    expect(made('honest-read', 'Two lofts pay 80 dollars a month; one left last month.')?.text).toContain(
      'Its real risk: one left last month, and you do not know why.',
    );
  });

  it.each([
    ['real-business', null, /^Not yet\. So far it is an idea: sails mended by the yard\./],
    [
      'real-business',
      'One sail loft pays 300 dollars a month.',
      /^Not yet, but it has started\. You have one sail loft/,
    ],
    ['real-business', 'Two lofts pay 80 dollars a month each.', /^It is becoming one\./],
    [
      'grants-angels-vc',
      'One harbour master asked for a trial on one boat.',
      /^A grant or a campus competition .*asked for a trial on one boat\. You do not have anyone who paid/,
    ],
    ['grants-angels-vc', 'One sail loft pays 300 dollars a month.', /^The second customer first/],
    ['raise-or-grow', 'Two lofts pay 80 dollars a month each.', /^Your customers first/],
    ['valuation', null, /^Do not put a number on it yet.*What you have so far is the idea, sails mended/],
    [
      'investor-meeting',
      'One sail loft pays 300 dollars a month.',
      /open with your proof: one sail loft pays 300 dollars a month\. Then say the gap before they ask: you do not have a second one/,
    ],
    [
      'qa-prep',
      '14 crews got a repair by hand; 6 fewer came back than the month before.',
      /^The first one for you: "Only \d+: how do you know it was your doing/,
    ],
    ['qa-prep', null, /^The first one for you: "Who has paid for this/],
    ['smallest-test', null, /^Run this one first: do the job by hand for five people/],
    [
      'smallest-test',
      'One harbour master asked for a trial on one boat.',
      /^Run this one first: sell it before you make more/,
    ],
    [
      'first-ten-customers',
      'Four lofts pay 25 dollars a month; two more are on a free trial.',
      /^Start with the nearest: two more are on a free trial\./,
    ],
    [
      'quit-or-continue',
      '30 skippers were asked to a course; 3 paid.',
      /^Do not decide on this one result\. 3 of 30 bought, which is 10%/,
    ],
  ])('%s with %s', (playId, content, says) => {
    expect(made(playId, content)?.text).toMatch(says);
  });

  it('a company is asked for a trial, by its own words', () => {
    const asked = 'One harbour office asked for a trial on one boat.';
    expect(made('smallest-test', asked, { idea: 'Sails mended for harbour offices' })?.text).toMatch(
      /^Run this one first: ask the one who wants it for a small paid trial/,
    );
  });

  it('who to talk to first is named from their own idea, or left to the program', () => {
    expect(made('find-ten-people', null, {}, 'skippers of small boats')?.text).toMatch(
      /^Talk first to skippers of small boats who had the problem in the last month/,
    );
    expect(made('find-ten-people', null)).toBeNull();
  });

  it('"would they pay?" is not proven by what they said, and is when they paid', () => {
    const asked = 'Four of ten skippers asked when they could book.';
    expect(made('will-anyone-pay', asked, { yesNo: true })?.text).toMatch(
      /^That is not proven yet\. .*asked when they could book/,
    );
    expect(made('will-anyone-pay', 'One sail loft pays 300 dollars a month.', { yesNo: true })?.text).toMatch(
      /^One does\./,
    );
    // How to find out is another question.
    expect(made('will-anyone-pay', asked)).toBeNull();
    expect(made('will-anyone-pay', null, { yesNo: true })).toBeNull();
  });

  it('a science idea is told which way to plan, and whose call the rest is', () => {
    expect(made('biotech-path', null, { idea: 'A gel that heals burns on patients' })?.text).toMatch(
      /^You are on the longer path: a gel that heals burns on patients, .*Which of the two is a specialist’s call, not mine\./,
    );
    expect(made('biotech-path', null, { idea: 'A software for labs that counts cells' })?.text).toMatch(
      /^You are on the shorter path/,
    );
    expect(made('biotech-path', null)?.text).toMatch(/decides the path/);
  });

  it('no result, no verdict on stopping; another play keeps the program’s answer', () => {
    expect(made('quit-or-continue', 'Two lofts pay 80 dollars a month each.')).toBeNull();
    expect(made('quit-or-continue', null)?.text).toMatch(
      /^Neither yet: it is not dead, it is untested\. You have told me of no test of sails mended by the yard/,
    );
    expect(made('equity-split', 'One sail loft pays 300 dollars a month.')).toBeNull();
  });
});
