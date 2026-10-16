import { describe, expect, it } from 'vitest';

import { addsNothingTo, conversationGrounding, isCoachEcho, sameMemoryContent } from './memory-dedupe.js';

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

describe('isCoachEcho (the coach’s own advice is never kept as a fact about the venture)', () => {
  // Production, call 2: the founder's short replies, and the same advice in every answer.
  const call = conversationGrounding([
    {
      founder: 'Could you help with that?',
      answer:
        'The regulatory pathway is not yet determined. Book the advisor to settle classification first.',
    },
    { founder: 'hmm, maybe', answer: 'Book the advisor meeting before you spend on the redesign.' },
  ]);
  const uncited = { cited: false };

  it('drops advice nothing of which came from the founder or the venture’s records', () => {
    expect(
      isCoachEcho(
        {
          title: 'Regulatory pathway not yet determined',
          content: 'The regulatory pathway is not yet determined.',
        },
        call,
        uncited,
      ),
    ).toBe(true);
    expect(
      isCoachEcho(
        { title: 'Advisor meeting', content: 'Book the advisor meeting to settle classification.' },
        call,
        uncited,
      ),
    ).toBe(true);
    // The same note citing the venture's records is about them, not the coach's framing.
    expect(
      isCoachEcho(
        {
          title: 'Regulatory pathway not yet determined',
          content: 'The regulatory pathway is not yet determined.',
        },
        call,
        { cited: true },
      ),
    ).toBe(false);
  });

  it('keeps what the founder said, even reworded and said back by the coach', () => {
    const goal = conversationGrounding([
      {
        founder: 'Honestly I just want to get rich fast from this startup.',
        answer: 'Wanting to get rich quickly is a common goal. Let us make the startup fundable first.',
      },
    ]);
    expect(
      isCoachEcho(
        { title: 'Personal goal', content: 'Maya wants to get rich quickly through the startup.' },
        goal,
        {
          speakers: ['Maya'],
          cited: false,
        },
      ),
    ).toBe(false);
  });

  it('keeps advice the founder agreed to, and anything too short to judge', () => {
    const agreed = conversationGrounding([
      {
        founder: 'What should we do first?',
        answer: 'Run a two-week door-counter test in the main library.',
      },
      { founder: 'Sounds good, let’s do that.', answer: 'Great. Pick the start date.' },
    ]);
    expect(
      isCoachEcho(
        { title: 'Door-counter test', content: 'A two-week door-counter test runs in the main library.' },
        agreed,
        uncited,
      ),
    ).toBe(false);
    expect(agreed.founder).toContain('Run a two-week door-counter test in the main library.');
    expect(isCoachEcho({ title: 'Advisor', content: 'Advisor.' }, call, uncited)).toBe(false);
  });
});
