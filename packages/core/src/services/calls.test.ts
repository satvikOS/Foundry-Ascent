/**
 * Calls (pure rules): admission of spoken turns, the heartbeat's stop rules and minute accounting, the voice a
 * call may use, the intro, the summary's actions, and what unsigned speech requests may say.
 */
import { rewriteIdentity } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { refusalError, timeLimitRefusal, voiceTurnRefusal, type VoiceTurnFacts } from './call-admission.js';
import {
  CALL_LIMITS,
  STOP_REASON,
  callStopCause,
  callTimeLeft,
  newCallMaxSeconds,
  remainingDailyMinutes,
  remainingDailySeconds,
  type CallConditions,
} from './call-usage.js';
import { callIntroText, callVoiceFor, distinctActions, greetingName, voiceApproved } from './calls.js';
import { heardPortion, isSpeakableRun, speakableText, splitSentences } from './speech.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

const CAPS = { maxCallMinutes: 30, dailyCallMinutesPerPrincipal: 60 };

describe('call minutes', () => {
  it('measures what is left today and caps a new call', () => {
    expect(remainingDailySeconds(0, 60)).toBe(3600);
    expect(remainingDailySeconds(3700, 60)).toBe(0);
    expect(remainingDailyMinutes(41 * 60 + 50, 60)).toBe(18.1);
    expect(newCallMaxSeconds(0, CAPS)).toBe(1800);
    expect(newCallMaxSeconds(50 * 60, CAPS)).toBe(600);
    expect(newCallMaxSeconds(0, { maxCallMinutes: 30, dailyCallMinutesPerPrincipal: 0 })).toBe(0);
  });

  it('reports the binding limit of a live call', () => {
    // 10 minutes in, 25 minutes used today: the call's own 30 minutes bind (20 left vs 35 left today).
    expect(
      callTimeLeft({ elapsedSeconds: 600, maxSeconds: 1800, usedSecondsToday: 1500, caps: CAPS }),
    ).toEqual({ seconds: 1200, limit: 'call' });
    // 55 minutes used today: 5 minutes left today bind.
    expect(
      callTimeLeft({ elapsedSeconds: 600, maxSeconds: 1800, usedSecondsToday: 3300, caps: CAPS }),
    ).toEqual({ seconds: 300, limit: 'daily' });
    // A per-call cap lowered mid-call applies at once.
    expect(
      callTimeLeft({
        elapsedSeconds: 700,
        maxSeconds: 1800,
        usedSecondsToday: 700,
        caps: { maxCallMinutes: 10, dailyCallMinutesPerPrincipal: 60 },
      }),
    ).toEqual({ seconds: 0, limit: 'call' });
  });
});

describe('heartbeat stop rules', () => {
  const healthy: CallConditions = {
    aiEnabled: true,
    callsEnabled: true,
    sessionActive: true,
    personaAvailable: true,
    voiceApproved: true,
    idleSeconds: 15,
    spendCapReached: false,
    timeLeft: { seconds: 600, limit: 'call' },
  };

  it('keeps a healthy call going', () => {
    expect(callStopCause(healthy)).toBeNull();
    expect(callStopCause({ ...healthy, idleSeconds: CALL_LIMITS.staleSeconds })).toBeNull();
  });

  it('stops for each switch, consent, budget, time and a client that went away', () => {
    const cases: [Partial<CallConditions>, string, string][] = [
      [{ aiEnabled: false }, 'kill_switch', 'disabled'],
      [{ callsEnabled: false }, 'calls_disabled', 'disabled'],
      [{ sessionActive: false }, 'session_closed', 'user'],
      [{ personaAvailable: false }, 'persona_unavailable', 'disabled'],
      [{ voiceApproved: false }, 'voice_consent', 'disabled'],
      [{ idleSeconds: CALL_LIMITS.staleSeconds + 1 }, 'stale_heartbeat', 'timeout'],
      [{ spendCapReached: true }, 'spend_cap', 'budget'],
      [{ timeLeft: { seconds: 0, limit: 'daily' } }, 'daily_call_minutes', 'budget'],
      [{ timeLeft: { seconds: 0, limit: 'call' } }, 'max_duration', 'timeout'],
    ];
    for (const [change, cause, reason] of cases) {
      const got = callStopCause({ ...healthy, ...change });
      expect(got, cause).toBe(cause);
      if (got !== null) expect(STOP_REASON[got]).toBe(reason);
    }
  });

  it('names the most fundamental cause first', () => {
    expect(callStopCause({ ...healthy, aiEnabled: false, callsEnabled: false, spendCapReached: true })).toBe(
      'kill_switch',
    );
    expect(callStopCause({ ...healthy, voiceApproved: false, timeLeft: { seconds: 0, limit: 'call' } })).toBe(
      'voice_consent',
    );
  });
});

describe('voice-turn admission', () => {
  const facts: VoiceTurnFacts = {
    call: { status: 'live', idleSeconds: 10 },
    callsEnabled: true,
    timeLeft: { seconds: 300, limit: 'call' },
    recentVoiceTurns: 3,
    callTurns: 4,
  };

  it('admits a turn of a live call with time and turns left', () => {
    expect(voiceTurnRefusal(facts)).toBeNull();
  });

  it('refuses ended or abandoned calls, the calls switch, time, rate and turn caps', () => {
    const reason = (change: Partial<VoiceTurnFacts>): string | null =>
      voiceTurnRefusal({ ...facts, ...change })?.reason ?? null;
    expect(reason({ call: { status: 'ended', idleSeconds: 0 } })).toBe('call_not_active');
    expect(reason({ call: { status: 'live', idleSeconds: CALL_LIMITS.staleSeconds + 5 } })).toBe(
      'call_not_active',
    );
    expect(reason({ callsEnabled: false })).toBe('calls_disabled');
    expect(reason({ timeLeft: { seconds: 0, limit: 'call' } })).toBe('call_minutes');
    expect(reason({ timeLeft: { seconds: 0, limit: 'daily' } })).toBe('daily_call_minutes');
    expect(reason({ recentVoiceTurns: CALL_LIMITS.voiceTurnRateLimit })).toBe('voice_turn_rate_limit');
    expect(reason({ recentVoiceTurns: CALL_LIMITS.voiceTurnRateLimit - 1 })).toBeNull();
    expect(reason({ callTurns: CALL_LIMITS.maxTurnsPerCall })).toBe('call_turn_limit');
  });

  it('maps refusals to errors with the right status and wait', () => {
    const noon = new Date('2026-10-16T12:00:00.000Z');
    const daily = timeLimitRefusal({ seconds: 0, limit: 'daily' });
    expect(daily).not.toBeNull();
    if (daily === null) return;
    expect(refusalError(daily, noon)).toMatchObject({
      code: 'rate_limited',
      status: 429,
      reason: 'daily_call_minutes',
      retryAfterSeconds: 12 * 3600,
    });
    const callOver = voiceTurnRefusal({ ...facts, call: { status: 'ended', idleSeconds: 0 } });
    if (callOver === null) throw new Error('expected a refusal');
    expect(refusalError(callOver, noon)).toMatchObject({ code: 'conflict', status: 409 });
    expect(refusalError(callOver, noon).retryAfterSeconds).toBeUndefined();
    const paused = voiceTurnRefusal({ ...facts, callsEnabled: false });
    if (paused === null) throw new Error('expected a refusal');
    expect(refusalError(paused, noon)).toMatchObject({ code: 'ai_disabled', status: 503 });
    expect(timeLimitRefusal({ seconds: 1, limit: 'daily' })).toBeNull();
  });
});

describe('the voice of a call', () => {
  const eir = (voiceId: string | null) =>
    ({ kind: 'eir_persona', embodiment: { provider: 'builtin', voiceId, portraitKey: null } }) as const;
  const guide = {
    kind: 'neutral_guide',
    embodiment: { provider: 'builtin', voiceId: 'Joanna', portraitKey: null },
  } as const;

  it('speaks with the EIR’s voice only under voice consent, and never falls back to another voice', () => {
    expect(callVoiceFor(eir('Matthew'), ['doctrine', 'voice'])).toBe('Matthew');
    expect(callVoiceFor(eir('Matthew'), ['doctrine'])).toBeNull();
    expect(callVoiceFor(eir(null), [])).toBe(DEFAULT_SPEECH_VOICE);
    expect(callVoiceFor(guide, [])).toBe('Joanna');
  });

  it('keeps a call’s voice approved while consent holds; the platform voice always is', () => {
    expect(voiceApproved('Matthew', eir('Matthew'), ['voice'])).toBe(true);
    expect(voiceApproved('Matthew', eir('Matthew'), [])).toBe(false);
    expect(voiceApproved(DEFAULT_SPEECH_VOICE, eir(null), [])).toBe(true);
    expect(voiceApproved('Joanna', guide, [])).toBe(true);
  });
});

describe('the call intro', () => {
  it('greets by first name, says it is an AI, then picks up the notebook opener', () => {
    expect(greetingName('Maya Okafor')).toBe('Maya');
    expect(greetingName('  Ines  ')).toBe('Ines');
    expect(greetingName('[admin] Maya')).toBeNull();
    expect(
      callIntroText({
        firstName: 'Maya',
        personaName: "Corin's vEIR",
        opener: 'Last time you planned five library-staff interviews. How did they go?',
        conversationStarted: false,
      }),
    ).toBe(
      "Hi Maya, this is Corin's vEIR, an AI coach. Last time you planned five library-staff interviews. How did they go?",
    );
    expect(
      callIntroText({
        firstName: null,
        personaName: 'Foundry Guide',
        opener: null,
        conversationStarted: true,
      }),
    ).toBe('Hi, this is Foundry Guide, an AI coach. Where would you like to pick up?');
    expect(
      callIntroText({
        firstName: 'Priya',
        personaName: "Ruth's vEIR",
        opener: null,
        conversationStarted: false,
      }),
    ).toBe("Hi Priya, this is Ruth's vEIR, an AI coach. What would you like to work on?");
  });

  it('passes the identity rules for every persona', () => {
    for (const personaName of ["Corin's vEIR", "Ruth's vEIR", 'Foundry Guide']) {
      const text = callIntroText({
        firstName: 'Maya',
        personaName,
        opener: null,
        conversationStarted: false,
      });
      const checked = rewriteIdentity(text, {
        personaName,
        eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'],
        checkHumanClaims: true,
      });
      expect(checked.findings, personaName).toEqual([]);
    }
    // An opener a person edited to impersonate the EIR is caught by the same rules (it is then left out).
    expect(
      rewriteIdentity('Corin here, I reviewed your plan myself.', {
        personaName: "Corin's vEIR",
        eirNames: ['Corin Halvorsen'],
        checkHumanClaims: true,
      }).findings.length,
    ).toBeGreaterThan(0);
  });
});

describe('call summary', () => {
  it('lists each next action once, at most ten', () => {
    const action = (text: string) => ({ owner: 'founder', action: text, target_date: null });
    expect(
      distinctActions([
        action('Interview five library staff'),
        action('interview five library staff!'),
        action(''),
      ]),
    ).toEqual([action('Interview five library staff')]);
    expect(distinctActions(Array.from({ length: 14 }, (_, i) => action(`Step ${String(i)}`)))).toHaveLength(
      10,
    );
  });
});

describe('unsigned speech', () => {
  const spoken = 'Run the map only in exam weeks. Under fifteen percent means stop! Is 19.5% enough?';

  it('reads Markdown answers as plain sentences', () => {
    expect(
      speakableText(
        'Not yet. **38 of 200** is 19% [E1], below your bar.\n\n- Rerun in [finals](https://x.test) weeks (E2)',
      ),
    ).toBe('Not yet. 38 of 200 is 19%, below your bar. Rerun in finals weeks');
  });

  it('splits sentences at their ends only', () => {
    expect(splitSentences(spoken)).toEqual([
      'Run the map only in exam weeks.',
      'Under fifteen percent means stop!',
      'Is 19.5% enough?',
    ]);
    expect(splitSentences('She said "stop." Then left.')).toEqual(['She said "stop."', 'Then left.']);
  });

  it('accepts the whole spoken reply, a whole sentence or a run of consecutive sentences', () => {
    expect(isSpeakableRun(spoken, spoken)).toBe(true);
    expect(isSpeakableRun('run the map only in exam weeks.', spoken)).toBe(true);
    expect(isSpeakableRun('Under fifteen percent means stop! Is 19.5% enough?', spoken)).toBe(true);
    expect(isSpeakableRun('Run the map only in exam weeks.  Under fifteen percent means stop!', spoken)).toBe(
      true,
    );
  });

  it('refuses fragments, reordered or skipped sentences, other text and replies without a spoken form', () => {
    expect(isSpeakableRun('38 of 200 is 19%', spoken)).toBe(false);
    expect(isSpeakableRun('Run the map', spoken)).toBe(false);
    expect(isSpeakableRun('only in exam weeks.', spoken)).toBe(false);
    expect(isSpeakableRun('Is 19.5% enough? Run the map only in exam weeks.', spoken)).toBe(false);
    expect(isSpeakableRun('Run the map only in exam weeks. Is 19.5% enough?', spoken)).toBe(false);
    expect(isSpeakableRun('Run the map every week.', spoken)).toBe(false);
    expect(isSpeakableRun('   ', spoken)).toBe(false);
    expect(isSpeakableRun('Run the map only in exam weeks.', null)).toBe(false);
  });

  it('refuses short sentences unless they are the whole reply', () => {
    const short = 'No. Not yet. Try the library first.';
    expect(isSpeakableRun('No.', short)).toBe(false);
    expect(isSpeakableRun('Not yet.', short)).toBe(false);
    expect(isSpeakableRun('No. Not yet.', short)).toBe(true);
    expect(isSpeakableRun('Try the library first.', short)).toBe(true);
    expect(isSpeakableRun('Yes.', 'Yes.')).toBe(true);
  });

  it('replays what the founder heard of an interrupted reply', () => {
    expect(heardPortion(spoken, 0)).toBe('Run the map only in exam weeks.');
    expect(heardPortion(spoken, 1)).toBe('Run the map only in exam weeks. Under fifteen percent means stop!');
    expect(heardPortion(spoken, 9)).toBe(splitSentences(spoken).join(' '));
    expect(heardPortion(spoken, -1)).toBe('');
  });
});
