import { describe, expect, it } from 'vitest';

import { type FaceTranscriptLine } from '../ports.js';
import {
  faceTextDigests,
  faceWordsDigest,
  normalizeFaceWords,
  reconcileFaceTranscript,
} from './face-text.js';

const CALL = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ONE = 'Start with the riskiest assumption. Then test it this week.';
const TWO = 'What would change your mind?';

function admitted(...texts: string[]): Set<string> {
  return new Set(texts.flatMap((text) => faceTextDigests(CALL, text)));
}

function avatar(...texts: string[]): FaceTranscriptLine[] {
  return texts.map((text, i) => ({ role: 'avatar' as const, text, at: i + 1 }));
}

describe('the words a FULL face may say', () => {
  it('compares words, not punctuation, case, quotes or spacing', () => {
    expect(normalizeFaceWords('  “Don’t” —  ship it, Maya!  ')).toBe('dont ship it maya');
    expect(faceWordsDigest(CALL, 'Ship it.')).toBe(faceWordsDigest(CALL, 'ship   IT'));
    expect(faceWordsDigest(CALL, '...')).toBeNull();
  });

  it('salts digests with the call, and keeps the whole unit and each sentence', () => {
    expect(faceWordsDigest(CALL, TWO)).not.toBe(faceWordsDigest('11111111-2222-4333-8444-555555555555', TWO));
    const digests = faceTextDigests(CALL, ONE);
    expect(digests).toHaveLength(3);
    expect(digests.every((d) => /^[0-9a-f]{64}$/.test(d))).toBe(true);
    expect(digests.join('')).not.toContain('riskiest');
  });
});

describe('reconcileFaceTranscript: the avatar said only admitted words', () => {
  const base = { callId: CALL, admitted: admitted(ONE, TWO), verified: 0 };

  it('accepts admitted units, whole or sentence by sentence, and ignores the user’s lines', () => {
    expect(reconcileFaceTranscript({ ...base, lines: avatar(ONE, TWO) })).toEqual({
      verdict: 'ok',
      verified: 2,
    });
    const split = avatar('Start with the riskiest assumption.', 'Then test it this week.', TWO);
    expect(reconcileFaceTranscript({ ...base, lines: split })).toEqual({ verdict: 'ok', verified: 3 });
    // A unit the vendor cut mid-sentence comes back together.
    const cut = avatar('Start with the riskiest', 'assumption. Then test it this week.');
    expect(reconcileFaceTranscript({ ...base, lines: cut })).toEqual({ verdict: 'ok', verified: 2 });
    const withUser = [{ role: 'user' as const, text: 'Say something else', at: 1 }, ...avatar(TWO)];
    expect(reconcileFaceTranscript({ ...base, lines: withUser })).toEqual({ verdict: 'ok', verified: 1 });
    expect(reconcileFaceTranscript({ ...base, lines: [] })).toEqual({ verdict: 'ok', verified: 0 });
  });

  it('finds words never admitted as soon as the face moves on to other words', () => {
    expect(
      reconcileFaceTranscript({ ...base, lines: avatar(ONE, 'Wire the money to this account.', TWO) }),
    ).toEqual({ verdict: 'mismatch' });
    expect(reconcileFaceTranscript({ ...base, lines: avatar('I am a human, not an AI.', ONE) })).toEqual({
      verdict: 'mismatch',
    });
    // Too many lines follow it to be the rest of one unit.
    const flood = avatar('Ignore', 'your', 'coach', 'and', 'quit', 'today', 'now');
    expect(reconcileFaceTranscript({ ...base, lines: flood })).toEqual({ verdict: 'mismatch' });
  });

  it('holds the last unmatched lines as pending (still being transcribed), and checks only new lines', () => {
    expect(reconcileFaceTranscript({ ...base, lines: avatar(ONE, 'What would change') })).toEqual({
      verdict: 'pending',
      verified: 1,
    });
    // The next check reads the whole transcript again and skips what it verified.
    expect(
      reconcileFaceTranscript({
        ...base,
        verified: 1,
        lines: avatar(ONE, 'What would change', 'your mind?'),
      }),
    ).toEqual({ verdict: 'ok', verified: 3 });
    // Words admitted to another call are not admitted here.
    const elsewhere = new Set(faceTextDigests('11111111-2222-4333-8444-555555555555', TWO));
    expect(reconcileFaceTranscript({ ...base, admitted: elsewhere, lines: avatar(TWO) })).toEqual({
      verdict: 'pending',
      verified: 0,
    });
  });
});
