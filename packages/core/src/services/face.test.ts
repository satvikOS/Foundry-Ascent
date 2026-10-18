import { describe, expect, it } from 'vitest';

import { FakeVoiceProvider } from '../testing/fakes.js';
import { callCanSpeak, callVoiceVendor } from './calls.js';
import { MIN_FACE_SECONDS, faceAllowance, faceStopCause } from './face.js';
import { faceCostUsd, voiceCostUsd, MEDIA_VENDORS } from './media-vendors.js';
import { chooseVoice } from './speech.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

const ON = { facesEnabled: true, faceMinutesPerPrincipalMonth: 60, faceMinutesPerCall: 20 };
const LIKENESS = { likeness: true };
const STAND_IN = { likeness: false };
const READY = { ref: 'avatar-1' };

describe('faceAllowance: whether a call may have a face, and for how long', () => {
  const base = {
    settings: ON,
    provider: LIKENESS,
    twinFace: READY,
    monthSecondsUsed: 0,
    callSecondsLeft: 1800,
    spendCapReached: false,
  };

  it('opens a face for at most the per-call limit, the call’s time left and the month’s minutes left', () => {
    expect(faceAllowance(base)).toEqual({ ok: true, maxSeconds: 20 * 60 });
    expect(faceAllowance({ ...base, callSecondsLeft: 300 })).toEqual({ ok: true, maxSeconds: 300 });
    expect(faceAllowance({ ...base, monthSecondsUsed: 59 * 60 })).toEqual({ ok: true, maxSeconds: 60 });
  });

  it('is off by default, without a provider, and for a likeness without a ready face', () => {
    expect(faceAllowance({ ...base, settings: { ...ON, facesEnabled: false } })).toEqual({
      ok: false,
      reason: 'faces_disabled',
    });
    expect(faceAllowance({ ...base, provider: undefined })).toEqual({ ok: false, reason: 'no_provider' });
    expect(faceAllowance({ ...base, twinFace: null })).toEqual({ ok: false, reason: 'no_face' });
    // The stand-in draws no one: no face record is needed.
    expect(faceAllowance({ ...base, provider: STAND_IN, twinFace: null }).ok).toBe(true);
  });

  it('stops at the spend cap, the month’s minutes and a call about to end', () => {
    expect(faceAllowance({ ...base, spendCapReached: true })).toEqual({ ok: false, reason: 'spend_cap' });
    expect(faceAllowance({ ...base, monthSecondsUsed: 60 * 60 })).toEqual({
      ok: false,
      reason: 'face_minutes',
    });
    expect(faceAllowance({ ...base, callSecondsLeft: MIN_FACE_SECONDS - 1 })).toEqual({
      ok: false,
      reason: 'too_short',
    });
    expect(faceAllowance({ ...base, settings: { ...ON, faceMinutesPerPrincipalMonth: 0 } }).ok).toBe(false);
  });
});

describe('faceStopCause: when a live face has to go', () => {
  const base = {
    settings: ON,
    provider: LIKENESS,
    twinFace: READY,
    monthSecondsUsed: 0,
    spendCapReached: false,
    clientOff: false,
  };

  it('keeps a face that may go on', () => {
    expect(faceStopCause(base)).toBeNull();
  });

  it('stops for the switch, withdrawn likeness, the spend cap, the minutes and a face the browser dropped', () => {
    expect(faceStopCause({ ...base, settings: { ...ON, facesEnabled: false } })).toBe('faces_disabled');
    expect(faceStopCause({ ...base, provider: undefined })).toBe('faces_disabled');
    expect(faceStopCause({ ...base, twinFace: null })).toBe('likeness_withdrawn');
    expect(faceStopCause({ ...base, provider: STAND_IN, twinFace: null })).toBeNull();
    expect(faceStopCause({ ...base, spendCapReached: true })).toBe('spend_cap');
    expect(faceStopCause({ ...base, monthSecondsUsed: 3600 })).toBe('face_minutes');
    expect(faceStopCause({ ...base, clientOff: true })).toBe('face_dropped');
  });
});

describe('the voice of a call', () => {
  const clone = new FakeVoiceProvider('elevenlabs');
  const eir = {
    kind: 'eir_persona' as const,
    embodiment: { provider: 'builtin' as const, voiceId: 'Matthew', portraitKey: null },
  };
  const cloneCall = { voiceId: 'Matthew', voiceVendor: 'elevenlabs' as const };
  const stockCall = { voiceId: 'Matthew', voiceVendor: 'polly' as const };
  const base = {
    call: cloneCall,
    persona: eir,
    assets: ['doctrine', 'voice'],
    clonedVoiceEnabled: true,
    provider: clone,
    twinVoice: { ref: 'VoiceClone01' },
    verified: true,
    crisis: false,
  };

  it('starts with the clone only while it is on, wired and ready under voice consent', () => {
    expect(callVoiceVendor({ clonedVoiceEnabled: true, provider: clone, twinVoice: { ref: 'v' } })).toBe(
      'elevenlabs',
    );
    expect(callVoiceVendor({ clonedVoiceEnabled: false, provider: clone, twinVoice: { ref: 'v' } })).toBe(
      'polly',
    );
    expect(callVoiceVendor({ clonedVoiceEnabled: true, provider: undefined, twinVoice: { ref: 'v' } })).toBe(
      'polly',
    );
    expect(callVoiceVendor({ clonedVoiceEnabled: true, provider: clone, twinVoice: null })).toBe('polly');
  });

  it('speaks a verified unit of a clone call with the clone', () => {
    expect(chooseVoice(base)).toEqual({ kind: 'clone', provider: clone, ref: 'VoiceClone01' });
  });

  it('never gives the clone an unverified unit, the crisis line, or a call that started without it', () => {
    expect(chooseVoice({ ...base, verified: false })).toEqual({ kind: 'polly', voiceId: 'Matthew' });
    expect(chooseVoice({ ...base, crisis: true })).toEqual({ kind: 'polly', voiceId: 'Matthew' });
    expect(chooseVoice({ ...base, call: stockCall })).toEqual({ kind: 'polly', voiceId: 'Matthew' });
  });

  it('falls back at once when the clone is switched off or withdrawn: the platform voice without consent', () => {
    expect(chooseVoice({ ...base, clonedVoiceEnabled: false })).toEqual({
      kind: 'polly',
      voiceId: 'Matthew',
    });
    // Voice consent withdrawn: the clone is gone, and so is the EIR's own stock voice.
    expect(chooseVoice({ ...base, assets: ['doctrine'], twinVoice: null })).toEqual({
      kind: 'polly',
      voiceId: DEFAULT_SPEECH_VOICE,
    });
    // A clone call goes on speaking; a stock-voice call without consent stops (the existing rule).
    expect(callCanSpeak(cloneCall, eir, ['doctrine'])).toBe(true);
    expect(callCanSpeak(stockCall, eir, ['doctrine'])).toBe(false);
    expect(callCanSpeak(stockCall, eir, ['doctrine', 'voice'])).toBe(true);
  });
});

describe('media vendor prices', () => {
  it('meters a face per minute and a clone per thousand characters, from the shared price file', () => {
    expect(MEDIA_VENDORS.face.heygen.usdPerMinute).toBe(0.093);
    expect(MEDIA_VENDORS.voice.elevenlabs.usdPer1kCharacters).toBe(0.04);
    expect(MEDIA_VENDORS.face.heygen.secretName).toBe('foundry-ascent/media/heygen');
    expect(MEDIA_VENDORS.voice.elevenlabs.secretName).toBe('foundry-ascent/media/elevenlabs');
    expect(faceCostUsd(120, 0.093)).toBeCloseTo(0.186, 6);
    expect(voiceCostUsd(2500, 0.04)).toBeCloseTo(0.1, 6);
    expect(faceCostUsd(-5, 0.093)).toBe(0);
  });
});
