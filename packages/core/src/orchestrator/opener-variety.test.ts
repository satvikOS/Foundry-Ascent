import { describe, expect, it } from 'vitest';

import { pastRepliesOf, repeatsOpener } from './continuity.js';
import { plainOpeners, type LeftOffConversationData } from './continuity-prompt.js';

/**
 * Coaching v3 (owner round 3): openers are model-written and never the same twice in a row, and the vEIR's phrasing
 * ledger reads the end of the person's own last conversations. Paraphrased lines, never transcript text.
 */
describe('a new conversation never opens the way the last one did', () => {
  it('reads a near-duplicate or the same first words as a repeat', () => {
    const last =
      'Good to talk again. Shall we pick up the library pricing, or is something else on your mind?';
    expect(repeatsOpener(last, last)).toBe(true);
    expect(
      repeatsOpener(
        'Good to talk again. Shall we pick up the second library, or is something else on your mind?',
        last,
      ),
    ).toBe(true);
    expect(repeatsOpener('Hey. Did the second library answer about the trial?', last)).toBe(false);
    expect(repeatsOpener('Hey. Did the second library answer about the trial?', null)).toBe(false);
    expect(repeatsOpener('Hey. Did the second library answer?', '')).toBe(false);
  });

  it('a greeting that names nothing always has another wording than the one the last conversation opened with', () => {
    // Whatever the seed, and whichever plain line the last conversation opened with, another opens differently: not a
    // near-duplicate, not the same first words, and neither its greeting nor its invitation again.
    for (let n = 0; n < 200; n += 1) {
      const seed = `session-${String(n)}:maya:0`;
      const lines = plainOpeners(seed, true);
      for (const previous of lines) {
        const [greeting, invitation] = previous.split(/(?<=[.!])\s/);
        const fresh = lines.find(
          (l) =>
            !repeatsOpener(l, previous) &&
            !l.includes(greeting ?? previous) &&
            !l.includes(invitation ?? previous),
        );
        expect(fresh, `${seed}: ${previous}`).toBeDefined();
      }
    }
  });
});

describe('the end of the last conversations, for the phrasing ledger and the name', () => {
  const conversation = (over: Partial<LeftOffConversationData>): LeftOffConversationData => ({
    sessionId: 's',
    withCaller: true,
    teammateFirstName: null,
    withThisVeir: true,
    title: null,
    channel: 'chat',
    lastActivityAt: '2026-11-05T10:00:00.000Z',
    ended: true,
    digest: null,
    exchanges: [],
    ...over,
  });

  it('reads only the person’s own conversations with this vEIR, newest first', () => {
    expect(
      pastRepliesOf({
        conversations: [
          conversation({ replies: ['Latest reply.', 'Earlier reply.'] }),
          conversation({ withCaller: false, replies: ['A teammate’s.'] }),
          conversation({ withThisVeir: false, replies: ['Another coach’s.'] }),
          conversation({ replies: ['Older conversation.'] }),
        ],
      }),
    ).toEqual(['Latest reply.', 'Earlier reply.', 'Older conversation.']);
    expect(pastRepliesOf(null)).toEqual([]);
  });
});
