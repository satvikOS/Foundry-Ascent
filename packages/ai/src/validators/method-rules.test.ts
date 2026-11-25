import { describe, expect, it } from 'vitest';

import { inDistress } from '../prompts/conversation-state.js';
import { SERVICE_OR_PRODUCT, STEP, STEP_ONLY } from '../testing/path-fixtures.js';
import { buildSupportIndex, supportUnit } from './citation-support.js';
import { withMeanings } from './glossary.js';
import { methodUnit } from './method.js';
import { ownFactsUnit } from './own-facts.js';

// Synthetic wording of what a live run let through (2026-11-25).
const lint = (unit: string, founderText?: string) =>
  methodUnit(unit, founderText === undefined ? {} : { founderText });

describe('a question about a would, however it is put', () => {
  it.each([
    'Ask three lofts what they would pay for it.',
    "Find out how much they'd pay for a repair.",
    'Learn whether they would use it every week.',
    'Figure out what price they would pay.',
    'Ask what the tear cost them, and what they would pay to skip that.',
    'Discover if people would switch to it.',
    "Ask two regulars if they'd borrow one.",
  ])('%s asks about the last time instead', (unit) => {
    const read = lint(unit);
    expect(read.findings).toContain('hypothetical_question');
    expect(read.text).not.toMatch(/\bwould|['’]d\b/);
    expect(read.text).toMatch(/last time|last used|last did|use now|spent/);
  });
  it.each([
    'What would make this easier for you?',
    'What would you change about it?',
    'What would convince the lab to switch?',
  ])('%s goes', (unit) => {
    expect(lint(`Ask each of them: "${unit}"`).text).not.toContain(unit);
  });
  it.each([
    'Ask three lofts what they paid for the last repair.',
    'You learn what they need, in what order, and what they would pay for.',
    'Never ask what they would pay.',
    'Find out what they use today.',
    'Ask them to pay now, at a real price.',
  ])('%s stands', (unit) => {
    expect(lint(unit)).toEqual({ text: unit, findings: [] });
  });

  it('a pass line of words is none', () => {
    for (const unit of [
      'If people say they would pay, move on to a bigger harbour.',
      'Once people say they would pay for it, keep going.',
    ])
      expect(lint(unit).text, unit).not.toContain(unit);
    const paid = 'If five of them pay, move on to the next group.';
    expect(lint(paid).text).toBe(paid);
  });
});

describe('a price, and a verdict on one', () => {
  it.each([
    'Set your price above what they pay for the workaround today.',
    'Price it above the alternative.',
    'That sum is the floor of your fee.',
    'Charge what they say they would pay.',
  ])('%s is not the program’s rule', (unit) => {
    expect(lint(unit)).toEqual({ text: '', findings: ['price_rule'] });
  });
  it.each([
    'Set your price below what they pay today and above what one costs you.',
    'What one repair costs you is the floor of your fee.',
    'Do not set it above what they pay today.',
  ])('%s is', (unit) => {
    expect(lint(unit).findings).not.toContain('price_rule');
  });
  it('a total against the price of one decides nothing', () => {
    expect(lint("If that's more than $30, the raise is right.").findings).toEqual(['verdict_without_basis']);
    const compare = 'If ten at $40 leave more in all than ten at $25, keep the higher price.';
    expect(lint(compare)).toEqual({ text: compare, findings: [] });
  });
});

describe('who paid is counted, and not who was asked', () => {
  const claim = 'That proves there is real demand for it.';
  it('three of forty is no proof', () => {
    expect(lint(claim, 'I asked 40 people and only 3 bought.').text).toBe('');
    expect(lint(claim, 'Two lofts said yes out of 30 I asked.').text).toBe('');
  });
  it('enough of them is', () => {
    expect(lint(claim, '14 lofts pay us 60 dollars a month.').text).toBe(claim);
    expect(lint(claim, 'We sold 30 pouches to people we do not know.').text).toBe(claim);
  });
});

describe('lines that say nothing', () => {
  it.each([
    "That's a rough spot, and let's look at the numbers.",
    'We have not hit the target, though there is room to grow.',
    "Okay, Rae, let's get this done.",
    "Rae, here's your sheet for SailMend.",
    'Sorry that it sounded harsh.',
    "You said 'not sure yet'.",
    'You have a clear way forward.',
    'That is for your idea: sails mended on the pier.',
    'Put that beside your idea: SailMend, which mends sails.',
    'Understanding why they left is key to keeping the rest.',
  ])('%s', (unit) => {
    expect(lint(unit)).toEqual({ text: '', findings: ['filler'] });
  });
  it.each([
    "Let's look at the numbers: two lofts pay.",
    'For your idea that means two lofts to ask first.',
    "Here's the page for the harbour master to sign by Friday, with the two dates on it.",
    "You said 'two lofts pay us 40 dollars a month since May', so start with those two lofts.",
    'Sorry, I cannot share what another founder told me.',
  ])('%s stands', (unit) => {
    expect(lint(unit)).toEqual({ text: unit, findings: [] });
  });
});

describe('what people are said to have said', () => {
  const guidance = {
    ...STEP_ONLY,
    said: 'I asked nine sailmakers. Seven like it, but six of those have no bench to put it on.',
  };
  it.each([
    'The sailmakers who lack a bench said they would use a phone version instead.',
    '- Your sailmakers told you that the noise bothers their neighbours.',
    'Most of them agreed that mornings work best.',
  ])('%s was never told', (unit) => {
    expect(ownFactsUnit(unit, guidance).findings).toContain('speech_unsupported');
  });
  it.each([
    'Six of the sailmakers said they have no bench to put it on.',
    'Ask the sailmakers who said no what stopped them.',
    'If buyers said it costs too much, lower it once.',
    'What did the sailmakers tell you about mornings?',
  ])('%s stands', (unit) => {
    expect(ownFactsUnit(unit, guidance).text).toBe(unit);
  });
  it('the program is not quoted at them', () => {
    expect(ownFactsUnit('The program says to ask two lofts first.', guidance).text).toBe(
      'Ask two lofts first.',
    );
  });
});

describe('a term is told once', () => {
  it.each([
    'Those $9 are your gross margin, the amount a patch leaves.',
    'Seven kits is your break-even point, the number that pays for the table.',
    'The $9 is the **contribution margin**—the part a patch adds.',
  ])('%s says what it is', (text) => {
    expect(withMeanings(text, new Set())).toBe(text);
  });
  it('a margin is what a sale leaves, also said of an amount', () => {
    expect(withMeanings('Your gross margin is $9.', new Set())).toContain(
      '(what a sale leaves after its own costs)',
    );
  });
});

describe('a breakdown of figures is no distress', () => {
  it.each([
    'No full breakdown please, only one number.',
    'Can you give me a cost breakdown?',
    'I need a breakdown of the market by Friday.',
  ])('%s', (text) => {
    expect(inDistress(text)).toBe(false);
  });
  it('a person’s is', () => {
    expect(inDistress('I had a breakdown last night and I cannot cope any more.')).toBe(true);
  });
});

describe('a cited sentence is held as the lab holds it', () => {
  const index = buildSupportIndex({
    evidence: [
      {
        key: 'E1',
        title: 'Find ten people',
        excerpt:
          'Talk to ten people who had the problem in the last month and tried to fix it. List thirty names, because many will not answer.',
      },
      {
        key: 'E2',
        title: 'Pilots',
        excerpt: 'Two lofts pay 40 dollars a month. The pilot began on 2026-10-12.',
      },
    ],
    founderText: 'Two lofts pay 40 dollars a month. $28 - $17 = $11.',
    citable: 'Two lofts pay 40 dollars a month since 2026-10-12.',
  });
  const cite = (text: string) => supportUnit(text, index).text;

  it('enough of its words are in the source', () => {
    const held = 'List thirty names, because many people will not answer [E1].';
    expect(cite(held)).toBe(held);
    expect(
      cite('Good founders keep a calm head when the problem is hard and others give up [E1].'),
    ).not.toContain('[E1]');
  });
  it('a figure of it is the source’s or theirs, never a sum of ours nor a day', () => {
    const theirs = 'Two lofts pay 40 dollars a month, and people had the problem in the last month [E1].';
    expect(cite(theirs)).toContain('[E1]');
    expect(
      cite('That $11 is what ten people who had the problem leave in the last month [E1].'),
    ).not.toContain('[E1]');
    expect(
      cite('Talk to 12 people who had the problem in the last month and tried to fix it [E1].'),
    ).not.toContain('12 people who had the problem in the last month and tried to fix it [E1]');
  });
});

describe('a draft in quotes is theirs to say', () => {
  it('to its end, over several sentences', () => {
    const before = 'Here it is: “SailMend mends sails in two days.';
    const line = ' That proves there is real demand for it.';
    expect(methodUnit(line, { before })).toEqual({ text: line, findings: [] });
    expect(methodUnit(line, { before: `${before}”` }).text).not.toBe(line);
    // A question to send is still about the last time.
    expect(methodUnit('“Would you pay for it?”', { before: 'Ask each of them: ' }).findings).toContain(
      'hypothetical_question',
    );
  });
});

describe('a template filled with a dash is read as one with a colon', () => {
  it('holds nothing they did not tell', () => {
    const guidance = {
      ...SERVICE_OR_PRODUCT,
      said: 'I work the desk at the dorm.',
      step: {
        ...STEP,
        template: {
          title: 'One page',
          body: 'Who: [one type of person]\nWhy me: [what you know, have or can reach]',
        },
      },
    };
    expect(ownFactsUnit('Why me — I have run two startups', guidance).text).toContain(
      '[what you know, have or can reach]',
    );
  });
});
