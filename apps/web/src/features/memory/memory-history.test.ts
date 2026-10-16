import { describe, expect, it } from 'vitest';

import { aiEventLine, summariseDiff, systemEventLine } from './memory-history';

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

  it('credits an AI proposal to the AI, never to the founder whose conversation it came from', () => {
    expect(aiEventLine('proposed', { status: 'proposed', origin: 'ai', type: 'insight' })).toBe(
      'Suggested by AI',
    );
    expect(aiEventLine('created', { origin: 'ai' })).toBe('Suggested by AI');
    // What people do with it afterwards, and what people write themselves, keep their names.
    expect(aiEventLine('approved', { origin: 'ai' })).toBeNull();
    expect(aiEventLine('created', { status: 'confirmed', origin: 'founder', type: 'decision' })).toBeNull();
  });
});
