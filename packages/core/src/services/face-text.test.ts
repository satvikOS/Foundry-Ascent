import { describe, expect, it } from 'vitest';

import { type FaceTranscriptLine } from '../ports.js';
import {
  type AdmittedFaceUnit,
  cursorAfter,
  faceTextDigests,
  faceWordsDigest,
  linesAfter,
  normalizeFaceWords,
  reconcileFaceTranscript,
} from './face-text.js';

const CALL = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ONE = 'Start with the riskiest assumption. Then test it this week.';
const TWO = 'What would change your mind?';

function admitted(...texts: string[]): AdmittedFaceUnit[] {
  return texts.map((text, i) => ({ unit: `u${String(i)}`, said: 0, ...faceTextDigests(CALL, text) }));
}

function avatar(...texts: string[]): FaceTranscriptLine[] {
  return texts.map((text, i) => ({ role: 'avatar' as const, text, at: i + 1 }));
}

/** The verdict without what each unit said (checked on its own below). */
function verdictOf(input: Parameters<typeof reconcileFaceTranscript>[0]) {
  const verdict = reconcileFaceTranscript(input);
  return verdict.verdict === 'mismatch' ? verdict : { verdict: verdict.verdict, verified: verdict.verified };
}

describe('the words a FULL face may say', () => {
  it('compares words, not punctuation, case, quotes or spacing', () => {
    expect(normalizeFaceWords('  “Don’t” —  ship it, Maya!  ')).toBe('dont ship it maya');
    expect(faceWordsDigest(CALL, 'Ship it.')).toBe(faceWordsDigest(CALL, 'ship   IT'));
    expect(faceWordsDigest(CALL, '...')).toBeNull();
  });

  it('salts digests with the call, and keeps the whole unit first and then each sentence', () => {
    expect(faceWordsDigest(CALL, TWO)).not.toBe(faceWordsDigest('11111111-2222-4333-8444-555555555555', TWO));
    const { digests, wholes } = faceTextDigests(CALL, ONE);
    expect(wholes).toBe(1);
    expect(digests).toEqual([
      faceWordsDigest(CALL, ONE),
      faceWordsDigest(CALL, 'Start with the riskiest assumption.'),
      faceWordsDigest(CALL, 'Then test it this week.'),
    ]);
    expect(digests.every((d) => /^[0-9a-f]{64}$/.test(d))).toBe(true);
    expect(digests.join('')).not.toContain('riskiest');
    // One sentence is its own whole; the signed words count as a second whole only when they differ.
    expect(faceTextDigests(CALL, TWO)).toEqual({ digests: [faceWordsDigest(CALL, TWO)], wholes: 1 });
    expect(faceTextDigests(CALL, TWO, `**${TWO}**`).wholes).toBe(1);
    expect(faceTextDigests(CALL, TWO, `${TWO} (link)`).wholes).toBe(2);
    // A repeated sentence is kept as often as it occurs, so it may be said that often.
    expect(faceTextDigests(CALL, 'Yes. Yes.').digests).toHaveLength(3);
  });
});

describe('reconcileFaceTranscript: the avatar said only admitted words, each unit once', () => {
  const base = { callId: CALL, units: admitted(ONE, TWO) };

  it('accepts admitted units, whole or sentence by sentence, and says what each unit said', () => {
    expect(verdictOf({ ...base, lines: avatar(ONE, TWO) })).toEqual({ verdict: 'ok', verified: 2 });
    const split = avatar('Start with the riskiest assumption.', 'Then test it this week.', TWO);
    const verdict = reconcileFaceTranscript({ ...base, lines: split });
    expect(verdict).toMatchObject({ verdict: 'ok', verified: 3 });
    if (verdict.verdict === 'mismatch') throw new Error('mismatch');
    expect(Object.fromEntries(verdict.said)).toEqual({ u0: 0b110, u1: 0b1 });
    // A unit the vendor cut mid-sentence comes back together.
    const cut = avatar('Start with the riskiest', 'assumption. Then test it this week.');
    expect(verdictOf({ ...base, lines: cut })).toEqual({ verdict: 'ok', verified: 2 });
    expect(verdictOf({ ...base, lines: [] })).toEqual({ verdict: 'ok', verified: 0 });
  });

  it('finds words never admitted as soon as the face moves on to other words', () => {
    expect(verdictOf({ ...base, lines: avatar(ONE, 'Wire the money to this account.', TWO) })).toEqual({
      verdict: 'mismatch',
      why: 'words_not_admitted',
    });
    expect(verdictOf({ ...base, lines: avatar('I am a human, not an AI.', ONE) })).toEqual({
      verdict: 'mismatch',
      why: 'words_not_admitted',
    });
    // Too many lines follow it to be the rest of one unit.
    const flood = avatar('Ignore', 'your', 'coach', 'and', 'quit', 'today', 'now');
    expect(verdictOf({ ...base, lines: flood })).toEqual({ verdict: 'mismatch', why: 'words_not_admitted' });
  });

  it('refuses an admitted unit said again, whole or a sentence of it, also across checks', () => {
    expect(verdictOf({ ...base, lines: avatar(TWO, TWO) })).toEqual({
      verdict: 'mismatch',
      why: 'said_again',
    });
    expect(verdictOf({ ...base, lines: avatar(ONE, 'Then test it this week.') })).toEqual({
      verdict: 'mismatch',
      why: 'said_again',
    });
    // A sentence of a unit, then the whole unit: the whole is no longer free to say.
    expect(verdictOf({ ...base, lines: avatar('Then test it this week.', ONE) })).toMatchObject({
      verdict: 'mismatch',
    });
    // What an earlier check saw said is still said.
    const saidBefore = base.units.map((unit) => (unit.unit === 'u1' ? { ...unit, said: 1 } : unit));
    expect(verdictOf({ callId: CALL, units: saidBefore, lines: avatar(TWO) })).toEqual({
      verdict: 'mismatch',
      why: 'said_again',
    });
    // A flood of admitted words is refused at its second line, so it can never push words past a read.
    const flood = avatar(...Array.from({ length: 200 }, () => TWO));
    expect(verdictOf({ ...base, lines: flood })).toEqual({ verdict: 'mismatch', why: 'said_again' });
    // The same words in two admitted units may be said twice.
    const twice = admitted(TWO, TWO);
    expect(verdictOf({ callId: CALL, units: twice, lines: avatar(TWO, TWO) })).toEqual({
      verdict: 'ok',
      verified: 2,
    });
    expect(verdictOf({ callId: CALL, units: admitted('Yes. Yes.'), lines: avatar('Yes.', 'Yes.') })).toEqual({
      verdict: 'ok',
      verified: 2,
    });
  });

  it('holds the last unmatched lines as pending, and words admitted to another call are not admitted here', () => {
    expect(verdictOf({ ...base, lines: avatar(ONE, 'What would change') })).toEqual({
      verdict: 'pending',
      verified: 1,
    });
    expect(verdictOf({ ...base, lines: avatar('What would change', 'your mind?') })).toEqual({
      verdict: 'ok',
      verified: 2,
    });
    const elsewhere = [
      { unit: 'x', said: 0, ...faceTextDigests('11111111-2222-4333-8444-555555555555', TWO) },
    ];
    expect(verdictOf({ callId: CALL, units: elsewhere, lines: avatar(TWO) })).toEqual({
      verdict: 'pending',
      verified: 0,
    });
  });
});

describe('the transcript cursor: each check reads only lines after those verified', () => {
  const user = { role: 'user' as const, text: 'Say something else', at: 2 };

  it('skips user lines, lines with no words and the lines verified at the cursor’s second', () => {
    const lines: FaceTranscriptLine[] = [
      { role: 'avatar', text: 'A.', at: 1 },
      user,
      { role: 'avatar', text: '...', at: 2 },
      { role: 'avatar', text: 'B.', at: 3 },
      { role: 'avatar', text: 'C.', at: 3 },
      { role: 'avatar', text: 'D.', at: 4 },
    ];
    expect(linesAfter(lines, { at: null, skip: 0 }).map((l) => l.text)).toEqual(['A.', 'B.', 'C.', 'D.']);
    expect(linesAfter(lines, { at: 3, skip: 1 }).map((l) => l.text)).toEqual(['C.', 'D.']);
    expect(linesAfter(lines, { at: 3, skip: 2 }).map((l) => l.text)).toEqual(['D.']);
  });

  it('moves to the last verified line, counting the lines of its second', () => {
    const lines = linesAfter(
      [
        { role: 'avatar', text: 'B.', at: 3 },
        { role: 'avatar', text: 'C.', at: 3 },
        { role: 'avatar', text: 'D.', at: 4 },
      ],
      { at: null, skip: 0 },
    );
    expect(cursorAfter({ at: null, skip: 0 }, lines, 0)).toEqual({ at: null, skip: 0 });
    expect(cursorAfter({ at: null, skip: 0 }, lines, 2)).toEqual({ at: 3, skip: 2 });
    expect(cursorAfter({ at: 3, skip: 1 }, lines, 1)).toEqual({ at: 3, skip: 2 });
    expect(cursorAfter({ at: 3, skip: 1 }, lines, 3)).toEqual({ at: 4, skip: 1 });
  });
});
