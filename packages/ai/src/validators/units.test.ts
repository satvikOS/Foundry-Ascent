import { describe, expect, it } from 'vitest';

import { inOrder, leansBack, letterOpen, renumbered, unitsOf, withoutFences } from './units.js';

describe('what a unit leans on', () => {
  it.each([
    'That is the only way to know.',
    'But it keeps the page honest.',
    "They'll tell you what it cost them.",
    'It also shows the lab what you did and what you still have to learn, which matters once you talk to the office that decides who owns it.',
  ])('%s', (unit) => {
    expect(leansBack(unit)).toBe(true);
  });
  it.each([
    'It takes 30 minutes.',
    'Also ask two lofts what they paid.',
    'This week, call five lofts.',
    'They pay 40 dollars a month.',
  ])('%s stands alone', (unit) => {
    expect(leansBack(unit)).toBe(false);
  });
});

describe('the shape of a reply', () => {
  it('a fence goes and what it held stays', () => {
    expect(withoutFences('Send this:\n\n```text\nHi [name],\nThanks\n```\n\nThen wait.')).toBe(
      'Send this:\n\nHi [name],\nThanks\n\nThen wait.',
    );
    expect(withoutFences('Write `x` in the cell.')).toBe('Write `x` in the cell.');
  });

  it('a letter is open until it is signed off', () => {
    expect(letterOpen('Send this:\n\nHi [name],\n\nI mend sails.')).toBe(true);
    expect(letterOpen('Subject: A question\n\nHello,\n')).toBe(true);
    expect(letterOpen('Hi [name],\n\nI mend sails.\n\nThanks,\nRae\n\nThen wait.')).toBe(false);
    expect(letterOpen('Hi Rae, good to see you.')).toBe(false);
  });

  it('a numbered list counts on where an item was left out', () => {
    expect(renumbered('1. Ask.\n3. Offer.\n4. Count.\n\nThen:\n1. Rest.')).toBe(
      '1. Ask.\n2. Offer.\n3. Count.\n\nThen:\n1. Rest.',
    );
    expect(renumbered('1. Ask\n   about the last time.\n2. Offer.')).toBe(
      '1. Ask\n   about the last time.\n2. Offer.',
    );
    expect(inOrder('\n4. Count.', 2)).toEqual({ text: '\n3. Count.', last: 3 });
    expect(inOrder('Count.', 2)).toEqual({ text: 'Count.', last: 2 });
  });

  it('an abbreviation ends no sentence', () => {
    expect(unitsOf('It is filed in the U.S. and nowhere else. Ask first.')).toHaveLength(2);
  });
});
