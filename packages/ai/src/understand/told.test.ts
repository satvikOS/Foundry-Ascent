import { describe, expect, it } from 'vitest';

import { expectLinearTime } from '../testing/linear-time.js';
import {
  decidedBy,
  gaveSomething,
  onlyPraise,
  secondQuestion,
  tellsOutcome,
  tellsUpdate,
  verdictStands,
} from './told.js';

describe('an outcome', () => {
  it.each([
    'Nine of the ringers came to the tower.',
    'the warden said no to the bells',
    'two couples cancelled the boat',
    'I ran 6 tower nights.',
    'the dean turned our stall down',
    'a chapel will lend us its yard',
    'my cousins love the bell',
    'guest say too loud but they come back',
    'rang 12 wardens. 2 booked a night',
    'one ringer wrote me that it is too heavy',
  ])('%s', (message) => {
    expect(tellsOutcome(message)).toBe(true);
  });
  it.each([
    'I get shaky when I think of ringing the warden',
    'what if the warden never writes back',
    'we are going to ask 12 wardens',
    'how many ringers came?',
    'I have 5 hours a week and 2 exams',
    'bells for small chapels, tuned by hand',
    'my brother says we should add a tour',
    "i didn't ring anyone",
    'would a ringer pay for that',
  ])('none: %s', (message) => {
    expect(tellsOutcome(message)).toBe(false);
  });

  it('is what a verdict stands over: told now, or just before and asked about', () => {
    expect(verdictStands('is that good', ['nine ringers came'], false)).toBe(true);
    expect(verdictStands('is that good', ['we tune bells'], false)).toBe(false);
    expect(verdictStands('so how should i put it to them', ['nine ringers came'], true)).toBe(false);
    // Read as one by the call: a plain count, and no fear of it.
    expect(verdictStands('14 wardens now, 6 chapels', [], true)).toBe(true);
    expect(verdictStands('14 wardens now, 6 chapels', [], false)).toBe(false);
    expect(verdictStands('i feel so behind, 14 others are ahead', [], true)).toBe(false);
    expect(verdictStands('im nervous about the 6 chapels', [], true)).toBe(false);
  });

  it.each([
    ["I'll ring 9 wardens by Sunday", true],
    ['ok, we are switching to hand bells', true],
    ['change it: the bell is 60 now, not 45', true],
    ["should I say I'll ring 9 wardens?", false],
    ['nine wardens said no', false],
  ])('an update that asks nothing: %s', (message, told) => {
    expect(tellsUpdate(message)).toBe(told);
  });

  it('praise of people close by, and what was given up', () => {
    expect(onlyPraise('my aunt and her choir love it')).toBe(true);
    expect(onlyPraise('my aunt paid 20 for it')).toBe(false);
    expect(onlyPraise('nine strangers love it')).toBe(false);
    expect(gaveSomething('three paid the deposit')).toBe(true);
    expect(gaveSomething('three liked it')).toBe(false);
  });
});

describe('who a message leaves no doubt must decide', () => {
  it.each([
    ['sad day, and the tower trust sent a letter to stop using their crest on our cap', 'legal'],
    ['some lawyer wrote that our name is too close to a foundry in ohio', 'legal'],
    ['their paper says they own every change we make to the code', 'legal'],
    ['the distributor wants to be exclusive for 2 years, I sign monday?', 'legal'],
    ['a founder offers 9 thousand for a tenth of the company', 'equity'],
    ['my welder wants a third of it instead of pay', 'equity'],
    ['we give the bell to 20 kids at the daycare and record how they sleep', 'irb'],
    ['the label will say the chime lowers blood pressure', 'regulatory'],
    ['i am on a visa and the chapel wants to pay me', 'immigration'],
  ] as const)('%s', (message, who) => {
    expect(decidedBy(message)).toBe(who);
  });
  it.each([
    'the warden sent a letter that he loves the bell',
    'which words go on the sign',
    'we shared the van with a choir',
    'ten percent of the ringers came back',
    'I asked 20 students how they sleep',
    'the crest letter is handled, we stopped using it',
    'how do I get the chapel to pay me',
    'the bell detects nothing, it just rings on the page',
  ])('nobody: %s', (message) => {
    expect(decidedBy(message)).toBeNull();
  });
});

describe('a second question', () => {
  it.each([
    ['how do i find wardens and should i print a list', 'how to find wardens', 'should i print a list'],
    ['Is 40 too much? Where do bells even sell?', 'whether 40 is too much', 'Where do bells even sell'],
    ['what does tuning mean. also do i need it by thursday', 'what tuning means', 'do i need it by thursday'],
  ])('%s', (message, ask, second) => {
    expect(secondQuestion(message, ask)).toBe(second);
  });
  it.each([
    ['how do i find wardens?', 'how to find wardens'],
    ['we sold 4 bells. good, right?', 'whether it is good'],
    ['how do i find wardens, how do i find more wardens', 'how to find wardens'],
    ['bells are heavy and loud', 'x'],
  ])('none: %s', (message, ask) => {
    expect(secondQuestion(message, ask)).toBeNull();
  });
});

it('is linear', () => {
  expectLinearTime((n) => {
    const text = 'they sent a letter and what if it is 9 of the ringers, also how do i find them. '.repeat(n);
    return () => {
      tellsOutcome(text);
      decidedBy(text);
      secondQuestion(text, text);
      verdictStands(text, [text], true);
    };
  }, 12);
}, 60_000);
