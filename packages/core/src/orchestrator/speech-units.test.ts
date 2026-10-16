import { describe, expect, it } from 'vitest';

import { signSpeechUnit, verifySpeechUnit, type SpeechUnitClaims } from './speech-units.js';

const keyA = { id: '11111111-1111-4111-8111-111111111111', bytes: new Uint8Array(32).fill(7) };
const keyB = { id: '22222222-2222-4222-8222-222222222222', bytes: new Uint8Array(32).fill(9) };

const unit: SpeechUnitClaims = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  turnId: '44444444-4444-4444-8444-444444444444',
  seq: 2,
  text: 'Talk to five library staff before you build anything else.',
};

describe('speech units', () => {
  it('verifies a unit it signed', () => {
    const sig = signSpeechUnit(keyA, unit);
    expect(sig.startsWith(`su1.${keyA.id}.`)).toBe(true);
    expect(verifySpeechUnit([keyA], unit, sig)).toBe(true);
  });

  it('keeps verifying through a key rotation while the old key is in its grace window', () => {
    const sig = signSpeechUnit(keyA, unit);
    expect(verifySpeechUnit([keyB, keyA], unit, sig)).toBe(true);
    expect(verifySpeechUnit([keyB], unit, sig)).toBe(false);
  });

  it('refuses any change to the text, sequence, turn or conversation', () => {
    const sig = signSpeechUnit(keyA, unit);
    expect(verifySpeechUnit([keyA], { ...unit, text: `${unit.text} Then raise.` }, sig)).toBe(false);
    expect(verifySpeechUnit([keyA], { ...unit, seq: 3 }, sig)).toBe(false);
    expect(verifySpeechUnit([keyA], { ...unit, turnId: null }, sig)).toBe(false);
    expect(
      verifySpeechUnit([keyA], { ...unit, sessionId: '55555555-5555-4555-8555-555555555555' }, sig),
    ).toBe(false);
  });

  it('signs the call intro (no turn) distinctly from turn units', () => {
    const intro = { ...unit, turnId: null, seq: 0 };
    const sig = signSpeechUnit(keyA, intro);
    expect(verifySpeechUnit([keyA], intro, sig)).toBe(true);
    expect(verifySpeechUnit([keyA], { ...intro, turnId: unit.turnId }, sig)).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    for (const bad of ['', 'su1', 'su1.x', `su2.${keyA.id}.AAAA`, `su1.${keyA.id}.!!!`, 'a'.repeat(500)]) {
      expect(verifySpeechUnit([keyA], unit, bad)).toBe(false);
    }
  });

  it('rejects a tampered signature', () => {
    const sig = signSpeechUnit(keyA, unit);
    const at = sig.length - 6;
    const forged = `${sig.slice(0, at)}${sig[at] === 'A' ? 'B' : 'A'}${sig.slice(at + 1)}`;
    expect(verifySpeechUnit([keyA], unit, forged)).toBe(false);
  });
});
