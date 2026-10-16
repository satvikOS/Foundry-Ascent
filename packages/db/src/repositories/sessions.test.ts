import { describe, expect, it } from 'vitest';

import { decodeSessionCursor, encodeSessionCursor, microsToIso } from './sessions.js';

const A = '6f1c6d0e-1a2b-5c3d-8e4f-0123456789aa';

function legacyCursor(activityKey: string, id: string): string {
  return Buffer.from(`${activityKey}|${id}`, 'utf8').toString('base64url');
}

describe('recents cursor', () => {
  it('round-trips microsecond positions exactly, as ISO timestamps for the query', () => {
    const cursor = encodeSessionCursor('1790000000123456', A);
    expect(decodeSessionCursor(cursor)).toEqual({ activityMicros: '1790000000123456', id: A });
    expect(microsToIso('1790000000123456')).toBe('2026-09-21T14:13:20.123456Z');
    expect(microsToIso('1790000000000007')).toBe('2026-09-21T14:13:20.000007Z');
    expect(decodeSessionCursor('not-a-cursor')).toBeNull();
  });

  it('reads a cursor issued in the earlier ISO form as the same position', () => {
    expect(decodeSessionCursor(legacyCursor('2026-09-21T14:13:20.123456Z', A.toUpperCase()))).toEqual({
      activityMicros: '1790000000123456',
      id: A,
    });
    expect(decodeSessionCursor(legacyCursor('2026-09-21T14:13:20.000007Z', A))?.activityMicros).toBe(
      '1790000000000007',
    );
    for (const bad of ['2026-02-30T10:00:00.000000Z', '2026-09-21T14:13:20.123Z', '2026-09-21 14:13:20']) {
      expect(decodeSessionCursor(legacyCursor(bad, A))).toBeNull();
    }
    expect(decodeSessionCursor(legacyCursor('1790000000123456', 'not-an-id'))).toBeNull();
  });
});
