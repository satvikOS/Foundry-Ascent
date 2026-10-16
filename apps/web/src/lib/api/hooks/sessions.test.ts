import { describe, expect, it } from 'vitest';

import { awaitingDigest } from './sessions';

describe('awaitingDigest', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const ended = {
    id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02',
    status: 'ended' as const,
    privacy: 'standard' as const,
    digest: null,
    endedAt: '2026-10-16T11:59:00.000Z',
  };

  it('waits for the digest of a conversation that just ended', () => {
    expect(awaitingDigest(ended, now)).toBe(true);
  });

  it('stops waiting after two minutes, once the digest is there, and never for temporary chats', () => {
    expect(awaitingDigest({ ...ended, endedAt: '2026-10-16T11:57:00.000Z' }, now)).toBe(false);
    expect(
      awaitingDigest(
        {
          ...ended,
          digest: {
            summary: 'S',
            topics: [],
            commitments: [],
            openQuestions: [],
            generatedAt: '2026-10-16T11:59:30.000Z',
          },
        },
        now,
      ),
    ).toBe(false);
    expect(awaitingDigest({ ...ended, privacy: 'ephemeral' }, now)).toBe(false);
    expect(awaitingDigest({ ...ended, status: 'active', endedAt: null }, now)).toBe(false);
    expect(awaitingDigest(undefined, now)).toBe(false);
  });
});
