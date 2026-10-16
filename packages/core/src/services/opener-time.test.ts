import { describe, expect, it } from 'vitest';

import { OPENER_SHOWN_MAX_AGE_MS, openerTime } from './sessions.js';

const NOW = new Date('2026-10-16T19:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe('when a new conversation’s opener is phrased', () => {
  it('as of when New chat showed it, so it says what the founder read', () => {
    expect(openerTime(ago(5 * 60_000), NOW).toISOString()).toBe(ago(5 * 60_000));
    // Another server's clock a moment ahead is still the time it was shown (never later than now).
    expect(openerTime(new Date(NOW.getTime() + 2_000).toISOString(), NOW)).toEqual(NOW);
  });

  it('now when nothing was shown, the time is not a time, in the future or over an hour old', () => {
    for (const shownAt of [
      undefined,
      null,
      'not a time',
      new Date(NOW.getTime() + 60_000).toISOString(),
      ago(OPENER_SHOWN_MAX_AGE_MS + 1),
    ]) {
      expect(openerTime(shownAt, NOW)).toEqual(NOW);
    }
    expect(openerTime(ago(OPENER_SHOWN_MAX_AGE_MS), NOW).toISOString()).toBe(ago(OPENER_SHOWN_MAX_AGE_MS));
  });
});
