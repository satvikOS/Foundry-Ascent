import { describe, expect, it } from 'vitest';

import { addsNothingTo, sameMemoryContent } from './memory-dedupe.js';

describe('sameMemoryContent', () => {
  it('matches the same statement however it is written, not one with another detail', () => {
    expect(sameMemoryContent('Libraries pay per room.', 'libraries pay per ROOM')).toBe(true);
    expect(
      sameMemoryContent(
        'Libraries want weekly occupancy reports for every study room during exams.',
        'Libraries want weekly occupancy reports for every study room during the exams.',
      ),
    ).toBe(true);
    expect(
      sameMemoryContent(
        'Maya will interview five library staff before Friday.',
        'Maya will interview ten library staff before Friday.',
      ),
    ).toBe(false);
    expect(sameMemoryContent('', '')).toBe(false);
  });
});

describe('addsNothingTo (a candidate restating a proposal of the same conversation)', () => {
  const turnProposal =
    'Maya asked: “I will interview five library staff about booking pain points before Friday.” ' +
    'More interviews about real past behaviour are planned.';

  it('recognises a restatement with other framing words and the founder named', () => {
    expect(
      addsNothingTo(
        'Maya plans to interview five library staff about booking pain points before Friday.',
        turnProposal,
      ),
    ).toBe(true);
    expect(
      addsNothingTo(
        'Maya plans to interview five library staff about booking pain points before Friday.',
        'The founder asked: “I will interview five library staff about booking pain points before Friday.”',
        ['Maya'],
      ),
    ).toBe(true);
  });

  it('keeps a candidate that adds a detail, a number, a negation, or is too short to tell', () => {
    expect(
      addsNothingTo(
        'Maya plans to interview ten library staff about booking pain points before Friday.',
        turnProposal,
      ),
    ).toBe(false);
    expect(
      addsNothingTo('Maya will not interview library staff about booking pain points.', turnProposal),
    ).toBe(false);
    expect(
      addsNothingTo(
        'Maya plans to interview five library staff about booking pain points before Friday and pay them.',
        turnProposal,
      ),
    ).toBe(false);
    expect(addsNothingTo('Maya plans interviews.', turnProposal)).toBe(false);
  });
});
