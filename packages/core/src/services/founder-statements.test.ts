import { describe, expect, it } from 'vitest';

import { statedMemory } from './founder-statements.js';

const none = { founderName: 'Maya', modelCandidates: [] };

describe('statedMemory (LAB-K1: what the founder states is kept with the turn)', () => {
  it('keeps the decision knowledge.spec states, as the founder’s, in the third person', () => {
    expect(
      statedMemory("We've decided to ask each library for a paid commitment before the pilot starts.", none),
    ).toEqual([
      {
        type: 'decision',
        title: 'Ask each library for a paid commitment before the pilot starts',
        content: 'The team decided to ask each library for a paid commitment before the pilot starts.',
        evidence_ids: [],
        confidence: 0.7,
        source: 'founder_stated',
      },
    ]);
  });

  it.each([
    ['So we settled on per-library pricing.', 'The team settled on per-library pricing.'],
    [
      "I've decided to run the pilot in two libraries, not four.",
      'Maya decided to run the pilot in two libraries, not four.',
    ],
    [
      'We agreed to share our door counts with facilities.',
      'The team agreed to share their door counts with facilities.',
    ],
    ['Our goal is ten paying libraries by June.', "The team's goal is ten paying libraries by June."],
    [
      'My priority this term is to finish the facilities deal.',
      "Maya's priority is to finish the facilities deal.",
    ],
    ["We can't afford a second pilot this year.", "The team can't afford a second pilot this year."],
    ["We don't have the budget for paid ads.", "The team doesn't have the budget for paid ads."],
  ])('%s', (said, content) => {
    expect(statedMemory(said, none).map((c) => c.content)).toEqual([content]);
  });

  it('keeps a statement that follows another clause of the sentence ("…, so we\'ve decided to…")', () => {
    expect(
      statedMemory(
        "How many repeat visitors did our seat map get? Our riskiest assumption still needs a cheap test, so we've decided to rerun the map in exam week.",
        none,
      ).map((c) => c.content),
    ).toEqual(['The team decided to rerun the map in exam week.']);
    expect(
      statedMemory("The dean said yes, and we've agreed to start the pilot in March.", none).map(
        (c) => c.content,
      ),
    ).toEqual(['The team agreed to start the pilot in March.']);
    // The other clause's hedge is not the decision's; a question stays unread.
    expect(statedMemory("Maybe it slips, but we've decided to keep the launch date.", none)).toHaveLength(1);
    expect(statedMemory("It's late, so should we decide to wait?", none)).toEqual([]);
  });

  it('keeps nothing that is a question, a hedge or not a plain first-person statement', () => {
    for (const said of [
      'Should we ask each library for a paid commitment?',
      "We've decided to ask each library for a paid commitment?",
      'Maybe we decided to ask for a deposit, not sure.',
      "We're thinking about asking each library for a paid commitment.",
      'The libraries decided to wait until spring.',
      'We decided.',
      'What did we decide about the pilot?',
      'Hi!',
    ]) {
      expect(statedMemory(said, none), said).toEqual([]);
    }
  });

  it('adds nothing the model’s own candidates already say', () => {
    const said = "We've decided to ask each library for a paid commitment before the pilot starts.";
    const modelCandidates = [
      { title: 'Paid commitment first', content: 'Each library pays a commitment before the pilot starts.' },
    ];
    expect(statedMemory(said, { founderName: 'Maya', modelCandidates })).toEqual([]);
    // Another candidate about something else does not cover it.
    expect(
      statedMemory(said, {
        founderName: 'Maya',
        modelCandidates: [
          { title: 'Facilities budget', content: 'Facilities holds the study-space budget.' },
        ],
      }),
    ).toHaveLength(1);
  });
});
