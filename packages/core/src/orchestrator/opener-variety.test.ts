import { describe, expect, it } from 'vitest';

import { openerPhrasings, pastRepliesOf, repeatsOpener } from './continuity.js';
import { continuityOpener, threadOpener, type LeftOffConversationData } from './continuity-prompt.js';

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

  it('says the fallback line another way, never drops its subject, when its phrasing repeats the last opener', () => {
    // Review of coaching v3 (a flaky continuity test): a phrasing whose greeting and frame matched the last opener gave
    // way to the line without a subject. Whatever the seed, and whatever phrasing the last conversation opened with,
    // another phrasing of the same thread or topic opens differently.
    const last = {
      digest: null,
      title: 'Per-seat pricing',
      channel: 'chat' as const,
      lastActivityAt: '2026-11-05T10:00:00.000Z',
      withThisVeir: true,
      exchanges: [{ founder: 'Should we charge libraries per seat?', answer: 'Who signs off on it?' }],
      said: ['Should we charge libraries per seat?'],
    };
    const now = new Date('2026-11-06T10:00:00.000Z');
    for (let n = 0; n < 200; n += 1) {
      const seed = `session-${String(n)}:maya:0`;
      const topics = openerPhrasings(seed, (s) => continuityOpener(last, { now, seed: s }).withTopic);
      const threads = openerPhrasings(seed, (s) =>
        threadOpener('the five library-staff interviews you planned', { seed: s }),
      );
      for (const lines of [topics, threads]) {
        for (const previous of lines) {
          const fresh = lines.find((l) => l !== null && !repeatsOpener(l, previous));
          expect(fresh, seed).toBeDefined();
          expect(fresh ?? '').toMatch(/per seat|library-staff interviews/);
        }
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
