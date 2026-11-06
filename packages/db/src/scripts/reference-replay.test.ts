import { describe, expect, it } from 'vitest';

import { replayRates } from './reference-replay.js';

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
      passages: 2,
      runsWithReference: 1,
      worstRunShare: 0.5,
    });
  });
});
