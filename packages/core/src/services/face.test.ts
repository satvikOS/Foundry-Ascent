import { describe, expect, it } from 'vitest';

import { FakeVoiceProvider } from '../testing/fakes.js';
import { callCanSpeak, callVoiceVendor } from './calls.js';
import { MIN_FACE_SECONDS, faceAllowance, faceMinutesCause, faceStopCause } from './face.js';
import { faceCostUsd, voiceCostUsd, MEDIA_VENDORS } from './media-vendors.js';
import { CloneRest, chooseVoice } from './speech.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

const ON = { facesEnabled: true, faceMinutesPerPrincipalMonth: 60, faceMinutesPerCall: 20 };
const LIKENESS = { likeness: true };
const STAND_IN = { likeness: false };
const READY = { ref: 'avatar-1' };

describe('faceAllowance: whether a call may have a face, and for how long', () => {
  const base = {
    settings: ON,
    provider: LIKENESS,
    callerRoles: [] as const,
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

  it('offers a vendor sandbox (the stock avatar under the EIR’s name) to platform admins only', () => {
    const sandbox = { likeness: true, sandbox: true };
    expect(faceAllowance({ ...base, provider: sandbox })).toEqual({ ok: false, reason: 'sandbox_only' });
    expect(faceAllowance({ ...base, provider: sandbox, callerRoles: ['program_lead', 'eir'] })).toEqual({
      ok: false,
      reason: 'sandbox_only',
    });
    expect(faceAllowance({ ...base, provider: sandbox, callerRoles: ['platform_admin'] }).ok).toBe(true);
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

describe('faceMinutesCause: a face’s video minutes', () => {
  const base = { lasted: 30, maxSeconds: 60, monthSecondsUsed: 600, monthMinutes: 60 };

  it('keeps a face within the call’s limit and the month’s minutes', () => {
    expect(faceMinutesCause(base)).toBeNull();
  });

  it('stops at the per-call limit, at the month’s minutes, and when the month cannot be read', () => {
    expect(faceMinutesCause({ ...base, lasted: 60 })).toBe('face_limit');
    expect(faceMinutesCause({ ...base, monthSecondsUsed: 3600 })).toBe('face_minutes');
    expect(faceMinutesCause({ ...base, monthSecondsUsed: null })).toBe('face_check_failed');
    // The call's limit is the face's own: it holds whatever the month says.
    expect(faceMinutesCause({ ...base, lasted: 61, monthSecondsUsed: null })).toBe('face_limit');
  });
});

describe('CloneRest: a cloned voice that failed is left alone for a while', () => {
  it('rests one voice for the rest period, and only that voice', () => {
    const rest = new CloneRest(60_000);
    expect(rest.resting('elevenlabs:VoiceA', 0)).toBe(false);
    rest.failed('elevenlabs:VoiceA', 1_000);
    expect(rest.resting('elevenlabs:VoiceA', 60_999)).toBe(true);
    expect(rest.resting('elevenlabs:VoiceB', 2_000)).toBe(false);
    expect(rest.resting('elevenlabs:VoiceA', 61_000)).toBe(false);
    expect(rest.resting('elevenlabs:VoiceA', 61_001)).toBe(false);
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
