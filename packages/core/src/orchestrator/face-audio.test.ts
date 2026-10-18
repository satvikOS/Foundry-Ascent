import { describe, expect, it } from 'vitest';

import {
  FACE_CHUNK_BYTES,
  FACE_MAX_UNIT_CHUNKS,
  decryptControl,
  encryptControl,
  pcmToWav,
  resamplePcm16,
  signFaceAudio,
  verifyFaceAudio,
} from './face-audio.js';
import { signSpeechUnit, verifiedSpeechUnit } from './speech-units.js';

const KEY = { id: 'k1', bytes: new Uint8Array(32).fill(7) };
const OTHER = { id: 'k2', bytes: new Uint8Array(32).fill(9) };
const CALL = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CLAIMS = { callId: CALL, sessionRef: 'sess-1', unit: 'unit.0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01.0' };

/** `seconds` of distinct PCM (each chunk differs). */
function pcm(seconds: number): Uint8Array {
  const out = new Uint8Array(Math.round(seconds * FACE_CHUNK_BYTES));
  for (let i = 0; i < out.length; i += 1) out[i] = (i * 31 + Math.floor(i / FACE_CHUNK_BYTES)) % 251;
  return out;
}

describe('face audio: the manifest that lets only our audio reach the face', () => {
  it('verifies the exact audio it covers, whole or in parts, for its own call and face session', () => {
    const audio = pcm(2.5);
    const manifest = signFaceAudio(KEY, CLAIMS, audio);
    if (manifest === null) throw new Error('no manifest');
    const whole = verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: 0, pcm: audio });
    expect(whole).toMatchObject({ ok: true, unit: CLAIMS.unit, chunks: 3 });
    if (!whole.ok) throw new Error('refused');
    expect(whole.audio).toMatchObject({ first: true, last: true, utterance: CLAIMS.unit });
    // A later part on its own: the chunks it starts at.
    const tail = verifyFaceAudio([KEY, OTHER], manifest, CLAIMS, {
      firstChunk: 1,
      pcm: audio.subarray(FACE_CHUNK_BYTES),
    });
    expect(tail).toMatchObject({ ok: true });
    if (tail.ok) expect(tail.audio).toMatchObject({ first: false, last: true });
    const head = verifyFaceAudio([KEY], manifest, CLAIMS, {
      firstChunk: 0,
      pcm: audio.subarray(0, FACE_CHUNK_BYTES),
    });
    if (!head.ok) throw new Error('refused');
    expect(head.audio).toMatchObject({ first: true, last: false });
  });

  it('refuses one changed byte, other audio, a shifted part, a truncated end and extra bytes', () => {
    const audio = pcm(2);
    const manifest = signFaceAudio(KEY, CLAIMS, audio) ?? '';
    const changed = audio.slice();
    changed[100] = (changed[100] ?? 0) ^ 1;
    expect(verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: 0, pcm: changed })).toEqual({
      ok: false,
      reason: 'audio_mismatch',
    });
    expect(verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: 0, pcm: pcm(2).reverse() }).ok).toBe(false);
    expect(
      verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: 1, pcm: audio.subarray(0, FACE_CHUNK_BYTES) })
        .ok,
    ).toBe(false);
    expect(
      verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: 0, pcm: audio.subarray(0, audio.length - 2) })
        .ok,
    ).toBe(false);
    const longer = new Uint8Array(audio.length + 2);
    longer.set(audio);
    expect(verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: 0, pcm: longer }).ok).toBe(false);
    expect(verifyFaceAudio([KEY], manifest, CLAIMS, { firstChunk: -1, pcm: audio }).ok).toBe(false);
  });

  it('refuses a manifest of another call or face session, a forged or re-keyed one, and garbage', () => {
    const audio = pcm(1);
    const manifest = signFaceAudio(KEY, CLAIMS, audio) ?? '';
    const part = { firstChunk: 0, pcm: audio };
    expect(verifyFaceAudio([KEY], manifest, { ...CLAIMS, sessionRef: 'sess-2' }, part)).toEqual({
      ok: false,
      reason: 'wrong_call',
    });
    expect(
      verifyFaceAudio([KEY], manifest, { ...CLAIMS, callId: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01' }, part)
        .ok,
    ).toBe(false);
    // Signed with a key the server does not have.
    expect(verifyFaceAudio([KEY], signFaceAudio(OTHER, CLAIMS, audio) ?? '', CLAIMS, part)).toEqual({
      ok: false,
      reason: 'manifest_invalid',
    });
    // The payload edited (to cover other audio) without the key.
    const [v, k, , mac] = manifest.split('.');
    const forgedPayload = (signFaceAudio(KEY, CLAIMS, pcm(1).reverse()) ?? '').split('.')[2];
    expect(verifyFaceAudio([KEY], `${v}.${k}.${forgedPayload}.${mac}`, CLAIMS, part).ok).toBe(false);
    for (const junk of ['', 'fa1', 'fa1.k1.x.y', `su1.${k}.x`, 'x'.repeat(9000)]) {
      expect(verifyFaceAudio([KEY], junk, CLAIMS, part).ok).toBe(false);
    }
  });

  it('covers nothing longer than a unit can be', () => {
    expect(signFaceAudio(KEY, CLAIMS, pcm(FACE_MAX_UNIT_CHUNKS + 1))).toBeNull();
    expect(signFaceAudio(KEY, CLAIMS, new Uint8Array(0))).toBeNull();
  });
});

describe('face audio: PCM helpers', () => {
  it('wraps PCM in a 44-byte WAV header that says 16-bit mono at the given rate', () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]), 24_000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it('resamples 16 kHz to 24 kHz: 1.5 times the samples, interpolated', () => {
    const input = new Uint8Array(8);
    const view = new DataView(input.buffer);
    [0, 300, 600, 900].forEach((v, i) => {
      view.setInt16(i * 2, v, true);
    });
    const out = resamplePcm16(input, 16_000, 24_000);
    expect(out.byteLength).toBe(12);
    const values = Array.from({ length: 6 }, (_, i) => new DataView(out.buffer).getInt16(i * 2, true));
    expect(values).toEqual([0, 200, 400, 600, 800, 900]);
    expect(resamplePcm16(input, 24_000, 24_000)).toEqual(input);
  });
});

describe('face audio: the control channel at rest', () => {
  it('opens only with a known key and the same call binding', () => {
    const stored = encryptControl(KEY, 'wss://webrtc.test.invalid/v1/ws?token=secret', 'aad-1');
    expect(stored).not.toContain('secret');
    expect(decryptControl([OTHER, KEY], stored, 'aad-1')).toBe(
      'wss://webrtc.test.invalid/v1/ws?token=secret',
    );
    expect(decryptControl([OTHER], stored, 'aad-1')).toBeNull();
    expect(decryptControl([KEY], stored, 'aad-2')).toBeNull();
    const tampered = Buffer.from(stored, 'base64').toString('utf8').slice(0, -2) + 'AA';
    expect(decryptControl([KEY], Buffer.from(tampered).toString('base64'), 'aad-1')).toBeNull();
    expect(decryptControl([KEY], 'not base64 at all', 'aad-1')).toBeNull();
  });
});

describe('verifiedSpeechUnit: the only way to hand words to the cloned voice or the face', () => {
  const claims = { sessionId: CALL, turnId: null, seq: 0, text: 'Hi Maya.' };

  it('is made only from a signature that verifies for exactly those words', () => {
    const sig = signSpeechUnit(KEY, claims);
    expect(verifiedSpeechUnit([KEY], claims, sig)).toMatchObject({ text: 'Hi Maya.', sig });
    expect(verifiedSpeechUnit([KEY], { ...claims, text: 'Hi Maya, I am human.' }, sig)).toBeNull();
    expect(verifiedSpeechUnit([OTHER], claims, sig)).toBeNull();
    expect(verifiedSpeechUnit([KEY], claims, undefined)).toBeNull();
    expect(verifiedSpeechUnit([KEY], claims, 'su1.k1.AAAA')).toBeNull();
  });
});
