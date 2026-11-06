import { describe, expect, it } from 'vitest';

import { replayRates, ventureWords } from './reference-replay.js';

describe('reference replay (rates only)', () => {
  it('counts turns and runs that would get a reference, never an item twice in a conversation', () => {
    const rates = replayRates([
      [
        [
          { student: 'How did Dropbox grow?', channel: 'text' },
          { student: 'And what did Dropbox do next?', channel: 'text' },
          { student: 'thanks, talk soon', channel: 'text' },
        ],
        [{ student: 'How did Dropbox grow?', channel: 'text' }],
      ],
      [[{ student: 'Could this work for parents of toddlers?', channel: 'voice' }]],
    ]);
    expect(rates).toEqual({
      runs: 2,
      turns: 5,
      turnsWithReference: 2,
      contextualTurns: 0,
      passages: 2,
      runsWithReference: 1,
      worstRunShare: 0.5,
    });
  });

  it('offers an item the conversation keeps naming, unasked, at most once every few turns, never twice', () => {
    const say = (student: string) => ({ student, channel: 'text' });
    const rates = replayRates([
      [
        [
          say('Our unit economics look shaky because each delivery costs more than we charge.'),
          say('I worked out the unit economics again with the new courier quote last night.'),
          say('The unit economics still fail on small orders below twenty dollars each.'),
          say('So the unit economics only work for the office customers ordering in bulk.'),
          say('We could raise the minimum order, our unit economics improve straight away then.'),
          say('thanks!'),
        ],
      ],
    ]);
    // Turn 2 is the first the conversation corroborates; the item is never offered again in the conversation.
    expect(rates).toMatchObject({ turns: 6, turnsWithReference: 1, contextualTurns: 1, passages: 1 });
  });

  it('counts what the venture’s own words bring too, as production does (review of coaching v3)', () => {
    const say = (student: string) => ({ student, channel: 'text' });
    const run = [
      [
        say('We lost two of the recycling pickups this week because the van broke down.'),
        say('thanks, that helps'),
      ],
    ];
    const venture = ventureWords({
      oneLiner: 'Recycling pickups for student halls',
      goal: 'Sign three halls',
    });
    expect(venture).toBe('Recycling pickups for student halls. Sign three halls');
    // The founder's words alone: nothing earlier names it, so nothing comes unasked.
    expect(replayRates([run])).toMatchObject({ turnsWithReference: 0, contextualTurns: 0 });
    // The venture's own words back it, as a production turn reads them: offered once.
    expect(replayRates([run], [venture])).toMatchObject({
      turnsWithReference: 1,
      contextualTurns: 1,
      passages: 1,
    });
    expect(ventureWords({ oneLiner: ' ', goal: null })).toBeNull();
  });
});
