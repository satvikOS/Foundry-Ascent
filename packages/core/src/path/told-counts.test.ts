import { describe, expect, it } from 'vitest';

import { tellsTalks, toldCounts } from './told-counts.js';

describe('what the counts of a message show', () => {
  it.each([
    [
      'we did 26 lamps and nine of them went to regulars',
      'again',
      /^Nine of the 26 were from before, so 17 were new\./,
    ],
    [
      'i did six. three said they would buy, one gets one for free from her aunt, two shrugged',
      'talks',
      /^Three of six said they would buy, and a word is not money yet\. [^]*one of them for free[^]*Ask the three for a day and a price this week\.$/,
    ],
    [
      'we asked 8 and two said yes',
      'talks',
      /^Two of eight said yes, and a word is not a yes you can count yet\./,
    ],
    [
      'fair: 60 stopped, 25 took a card, 6 bought right there',
      'funnel',
      /^Six of the 60 who stopped bought, about 10 in 100: that is the number that counts\./,
    ],
  ] as const)('%s', (message, kind, text) => {
    const read = toldCounts(message);
    expect(read?.kind).toBe(kind);
    expect(read?.text).toMatch(text);
    expect((read?.voice ?? '').split(/(?<=[.])\s+/).length).toBeLessThanOrEqual(2);
  });
  it.each([
    'we sold 26 lamps on sunday',
    'i did 4 hours of wiring and two said hi',
    'it costs 40 and 6 for the wire',
    '6 bought, 60 stopped',
    'how many should i make?',
  ])('nothing is read in "%s"', (message) => {
    expect(toldCounts(message)).toBeNull();
  });
  it.each([
    ['i did four talks and one is booked', true],
    ['i did six. three said they would buy', true],
    ['talked to nine of them', true],
    ['did four lamps', false],
  ])('talks held: "%s" %s', (message, tells) => {
    expect(tellsTalks(message)).toBe(tells);
  });
});
