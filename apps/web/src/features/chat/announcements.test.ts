import { describe, expect, it } from 'vitest';

import { IDS } from '../coach/testing';
import { turnOutcomeAnnouncement } from './announcements';

const blocked = (reason: string, escalationId: string | null = null) => ({
  event: 'turn.blocked' as const,
  turnId: IDS.turn,
  reason,
  escalationId,
  supportMessage: null,
});

describe('turnOutcomeAnnouncement', () => {
  it('never says a blocked answer was handed to a person', () => {
    for (const reason of ['policy', 'identity', 'invalid_schema', 'crisis_support', 'blocked']) {
      for (const escalationId of [null, IDS.ref]) {
        const said = turnOutcomeAnnouncement(
          { status: 'blocked', blocked: blocked(reason, escalationId), autoRetryAt: null },
          'Corin’s vEIR',
        );
        expect(said?.politeness).toBe('assertive');
        expect(said?.text).not.toMatch(/handed|sent to|passed to/i);
      }
    }
  });

  it('matches the panel: held back, a crisis, a drafted request that is not shared yet', () => {
    const say = (reason: string, escalationId: string | null = null) =>
      turnOutcomeAnnouncement(
        { status: 'blocked', blocked: blocked(reason, escalationId), autoRetryAt: null },
        'Corin’s vEIR',
      )?.text;
    expect(say('policy')).toBe('This answer was held back. You can ask again, or ask a person.');
    expect(say('crisis_support')).toBe('You deserve support from a person. Support options are shown.');
    expect(say('blocked', IDS.ref)).toBe(
      'This is one for a person. You can ask a person for help. A support request was drafted for you to review. Nothing is shared until you do.',
    );
  });

  it('says "still answering" only while a re-check is actually scheduled', () => {
    expect(
      turnOutcomeAnnouncement(
        { status: 'failed', blocked: null, autoRetryAt: Date.now() + 2_000 },
        'Corin’s vEIR',
      ),
    ).toEqual({ text: 'Still answering. Corin’s vEIR will check again shortly.', politeness: 'polite' });
    // A conflict with a server wait but no replay scheduled (replays used up, or an in-flight request) failed.
    expect(
      turnOutcomeAnnouncement({ status: 'failed', blocked: null, autoRetryAt: null }, 'Corin’s vEIR'),
    ).toEqual({ text: 'The response could not be completed.', politeness: 'assertive' });
  });

  it('announces completion and stop politely, and nothing while idle or streaming', () => {
    const say = (status: 'completed' | 'cancelled' | 'idle' | 'streaming') =>
      turnOutcomeAnnouncement({ status, blocked: null, autoRetryAt: null }, 'Corin’s vEIR');
    expect(say('completed')).toEqual({ text: 'Response ready.', politeness: 'polite' });
    expect(say('cancelled')).toEqual({ text: 'Stopped.', politeness: 'polite' });
    expect(say('idle')).toBeNull();
    expect(say('streaming')).toBeNull();
  });
});
