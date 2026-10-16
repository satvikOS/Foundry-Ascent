import { describe, expect, it } from 'vitest';

import { summariseDiff, systemEventLine } from './memory-history';

describe('memory history lines', () => {
  it('says a proposal expired because nobody reviewed it, never “by” the person it was for', () => {
    expect(systemEventLine('expired', { system: true, reason: 'not_reviewed', days: 30 })).toBe(
      'Expired, not reviewed in 30 days',
    );
    expect(systemEventLine('expired', { system: true, reason: 'not_reviewed' })).toBe(
      'Expired, not reviewed',
    );
  });

  it('leaves events people made to the usual line', () => {
    expect(systemEventLine('rejected', { reason: 'Not accurate' })).toBeNull();
    expect(summariseDiff({ content: 'x', reason: 'Not accurate' })).toEqual({
      fields: ['details'],
      reason: 'Not accurate',
    });
  });
});
