/**
 * Voice calls through the core services: starting a call (admission, the speech-to-text grant and the signed
 * intro), heartbeats that carry the kill switches, consent and budgets, voice-turn admission, barge-in, the
 * end and its summary, and speech of signed units or whole sentences of a stored spoken reply only.
 */
import {
  CallDetailResponse,
  CallHeartbeatResponse,
  EndCallResponse,
  StartCallResponse,
  TurnStreamEvent,
  type TurnView,
} from '@foundry/contracts';
import { auditRepo, callsRepo, p, usageRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformKeyCache } from '../auth/keys.js';
import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { resolveDeps } from '../deps.js';
import { Kit } from '../internal/kit.js';
import { signSpeechUnit, verifySpeechUnit } from '../orchestrator/speech-units.js';
import { FakeSpeechSynthesizer, FakeSttGrantIssuer } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { admitVoiceTurn } from './call-admission.js';
import { CALL_LIMITS } from './call-usage.js';
import { speakableText } from './speech.js';

let h: CoreHarness;
let kit: Kit;
let keys: PlatformKeyCache;
const speech = new FakeSpeechSynthesizer();
const stt = new FakeSttGrantIssuer();
type Person = 'maya' | 'devin' | 'priya' | 'tomasz' | 'amara' | 'graham' | 'jonah' | 'ines';
const ctx = {} as Record<Person, RequestContext>;

const ventureId = (key: 'quietquad' | 'benchtally' | 'solesignal' | 'emberloop'): string =>
  h.ventures[key].id;

async function newSession(who: Person, venture: Parameters<typeof ventureId>[0]): Promise<string> {
  return (await h.core.sessions.create(ctx[who], ventureId(venture), {})).id;
}

async function startCall(who: Person, sessionId: string, inputMode: 'transcribe' | 'typed' = 'transcribe') {
  return StartCallResponse.parse(await h.core.calls.start(ctx[who], sessionId, { inputMode }));
}

async function endCall(who: Person, callId: string) {
  return EndCallResponse.parse(await h.core.calls.end(ctx[who], callId, { reason: 'user' }));
}

async function beat(who: Person, callId: string) {
  return CallHeartbeatResponse.parse(
    await h.core.calls.heartbeat(ctx[who], callId, { state: 'listening', micOpenSeconds: 12 }),
  );
}

/** A turn sent while the call is live (spoken: `channel: 'voice'` with the call id). */
async function talk(who: Person, sessionId: string, callId: string, text: string): Promise<TurnView> {
  const events: TurnStreamEvent[] = [];
  await h.core.orchestrator.runTurn(ctx[who], sessionId, { text, channel: 'voice', callId }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${last?.event ?? 'none'}`);
  return last.turn;
}

async function setting(key: string, value: string): Promise<string> {
  return h.t.db.system(async (sx) => {
    const before = await sx.query('SELECT value::text AS v FROM platform_settings WHERE key = :k', {
      k: p.text(key),
    });
    await sx.query(
      `INSERT INTO platform_settings (key, value) VALUES (:k, :v::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      { k: p.text(key), v: p.text(value) },
    );
    const previous = before.rows[0]?.v;
    return typeof previous === 'string' ? previous : value;
  });
}

async function withSetting<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const before = await setting(key, value);
  try {
    return await fn();
  } finally {
    await setting(key, before);
  }
}

/** Moves a call back in time (owner role): started `minutes` ago, last heartbeat `beatMinutesAgo` ago. */
async function backdate(callId: string, minutes: number, beatMinutesAgo: number | null): Promise<void> {
  await h.t.db.system(async (sx) => {
    await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
    await sx.query(
      `UPDATE calls SET started_at = now() - make_interval(mins => :m),
              last_heartbeat_at = CASE WHEN :b::integer IS NULL THEN NULL
                                       ELSE now() - make_interval(mins => :b::integer) END
       WHERE id = :id`,
      { id: p.uuid(callId), m: p.int(minutes), b: p.nullable.int(beatMinutesAgo) },
    );
    await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
  });
}

async function callRow(callId: string): Promise<callsRepo.CallRecord> {
  const call = await h.t.db.system((sx) => callsRepo.getCall(sx, callId));
  if (call === null) throw new Error('no call');
  return call;
}

async function auditActions(): Promise<string[]> {
  const page = await h.t.db.system((sx) => auditRepo.listAuditEvents(sx, { limit: 500 }));
  return page.items.map((e) => e.action);
}

beforeAll(async () => {
  h = await createCoreHarness({ speech, sttGrants: stt });
  kit = new Kit(
    resolveDeps({
      db: h.t.db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
    }),
  );
  keys = new PlatformKeyCache(kit, h.config.session.keyGraceSeconds);
  for (const person of ['maya', 'devin', 'priya', 'tomasz', 'amara', 'graham', 'jonah', 'ines'] as const) {
    ctx[person] = await h.ctxFor(h.people[person]);
  }
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('starting a call', () => {
  it('starts with a speech-to-text grant and a signed intro that picks up the notebook opener', async () => {
    const sessionId = await newSession('maya', 'quietquad');
    const started = await startCall('maya', sessionId);
    expect(started.call).toMatchObject({
      sessionId,
      ventureId: ventureId('quietquad'),
      personaId: h.ventures.quietquad.personaId,
      status: 'live',
      provider: 'builtin',
      inputMode: 'transcribe',
      maxSeconds: 30 * 60,
      endedAt: null,
      durationSeconds: null,
    });
    expect(started.sttGrant).toMatchObject({
      languageCode: 'en-US',
      sampleRateHertz: 16000,
      mediaEncoding: 'pcm',
    });
    expect(started.sttGrant?.url).toMatch(/^wss:\/\//);
    expect(stt.calls.at(-1)).toMatchObject({ expiresInSeconds: 300 });
    const intro = started.intro;
    if (intro === null) throw new Error('expected an intro');
    expect(intro.text).toMatch(/^Hi Maya, this is Corin's vEIR, an AI coach\. Last time you planned five/);
    expect(
      verifySpeechUnit(
        await keys.verificationKeys(),
        { sessionId, turnId: null, seq: 0, text: intro.text },
        intro.sig,
      ),
    ).toBe(true);
    expect((await callRow(started.call.id)).sttGrants).toBe(1);
    // Starting again in the same conversation (a reload) replaces the call.
    const again = await startCall('maya', sessionId, 'typed');
    expect(again.sttGrant).toBeNull();
    expect(again.call.inputMode).toBe('typed');
    expect(await callRow(started.call.id)).toMatchObject({ status: 'ended', endReason: 'navigated' });
    // A conversation under way gets an invitation to continue instead of the opener.
    await talk('maya', sessionId, again.call.id, 'Can we test the seat map this week?');
    const third = await startCall('maya', sessionId);
    expect(third.intro?.text).toBe(
      "Hi Maya, this is Corin's vEIR, an AI coach. Where would you like to pick up?",
    );
    await endCall('maya', third.call.id);
    expect(await auditActions()).toEqual(expect.arrayContaining(['call.started', 'call.ended']));
    // The grant URL and the intro are content: never logged.
    expect(h.logger.dump()).not.toContain('stt.test.invalid');
    expect(h.logger.dump()).not.toContain('library-staff');
  });

  it('leaves out an opener a person edited into an impersonation', async () => {
    const notebook = await h.core.notebook.get(ctx.maya, ventureId('quietquad'));
    await h.core.notebook.update(ctx.maya, ventureId('quietquad'), {
      expectedVersion: notebook.version,
      edit: { action: 'edit_opener', text: 'Corin here. I read your whole plan myself last night.' },
    });
    const sessionId = await newSession('maya', 'quietquad');
    const started = await startCall('maya', sessionId);
    expect(started.intro?.text).toBe(
      "Hi Maya, this is Corin's vEIR, an AI coach. What would you like to work on?",
    );
    await endCall('maya', started.call.id);
  });

  it('starts with typed input where speech recognition is unavailable or fails', async () => {
    const bare = createCore({
      db: h.t.db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
    });
    const sessionId = await newSession('devin', 'quietquad');
    const started = StartCallResponse.parse(await bare.calls.start(ctx.devin, sessionId, {}));
    expect(started).toMatchObject({ sttGrant: null, call: { inputMode: 'typed' } });
    await expect(bare.calls.sttGrant(ctx.devin, started.call.id)).rejects.toMatchObject({
      code: 'speech_unavailable',
      status: 501,
    });
    // A signing failure leaves the call running; the client asks again or types.
    stt.failNext = true;
    const retry = await startCall('devin', sessionId);
    expect(retry.sttGrant).toBeNull();
    expect(retry.call.status).toBe('live');
    const grant = await h.core.calls.sttGrant(ctx.devin, retry.call.id);
    expect(grant.url).toMatch(/^wss:/);
    await endCall('devin', retry.call.id);
  });

  it('refuses outsiders, closed switches, a live call elsewhere, a suspended vEIR and spent minutes', async () => {
    const sessionId = await newSession('devin', 'quietquad');
    await expect(h.core.calls.start(ctx.jonah, sessionId, {})).rejects.toMatchObject({ code: 'not_found' });
    // An advisor does not see the venture's conversations at all.
    const soleSession = await newSession('amara', 'solesignal');
    await expect(h.core.calls.start(ctx.graham, soleSession, {})).rejects.toMatchObject({
      code: 'not_found',
    });
    await withSetting('calls_enabled', 'false', async () => {
      await expect(h.core.calls.start(ctx.devin, sessionId, {})).rejects.toMatchObject({
        code: 'ai_disabled',
        reason: 'calls_disabled',
      });
    });
    await withSetting('ai_enabled', 'false', async () => {
      await expect(h.core.calls.start(ctx.devin, sessionId, {})).rejects.toMatchObject({
        code: 'ai_disabled',
        reason: 'kill_switch',
      });
    });
    await withSetting('daily_call_minutes_per_principal', '0', async () => {
      await expect(h.core.calls.start(ctx.devin, sessionId, {})).rejects.toMatchObject({
        code: 'rate_limited',
        reason: 'daily_call_minutes',
      });
    });
    // One live call per person: a call in another conversation is refused while it is alive …
    const live = await startCall('devin', sessionId);
    const other = await newSession('devin', 'quietquad');
    await expect(h.core.calls.start(ctx.devin, other, {})).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_in_progress',
      status: 409,
    });
    // … and closed once its client went away.
    await backdate(live.call.id, 5, 3);
    const next = await startCall('devin', other);
    expect(await callRow(live.call.id)).toMatchObject({
      status: 'ended',
      endReason: 'timeout',
      endDetail: 'stale_heartbeat',
    });
    await endCall('devin', next.call.id);
    // A suspended vEIR takes no calls.
    await h.t.db.system((sx) =>
      sx.query(`UPDATE personas SET status = 'suspended' WHERE id = :id`, {
        id: p.uuid(h.ventures.quietquad.personaId),
      }),
    );
    try {
      await expect(h.core.calls.start(ctx.devin, other, {})).rejects.toMatchObject({
        code: 'persona_suspended',
      });
    } finally {
      await h.t.db.system((sx) =>
        sx.query(`UPDATE personas SET status = 'active' WHERE id = :id`, {
          id: p.uuid(h.ventures.quietquad.personaId),
        }),
      );
    }
    // An ended conversation takes no calls.
    await h.core.sessions.end(ctx.devin, other);
    await expect(h.core.calls.start(ctx.devin, other, {})).rejects.toMatchObject({ code: 'session_ended' });
    expect(await auditActions()).toContain('call.refused');
  });

  it('refuses a call in the EIR’s own voice once the voice consent is no longer in force', async () => {
    const consent = await h.t.db.system(async (sx) => {
      const r = await sx.query('SELECT consent_id FROM personas WHERE id = :id', {
        id: p.uuid(h.ventures.solesignal.personaId),
      });
      return String(r.rows[0]?.consent_id);
    });
    const sessionId = await newSession('amara', 'solesignal');
    const live = await startCall('amara', sessionId);
    expect((await callRow(live.call.id)).voiceId).toBe('Matthew');
    await h.t.db.system((sx) =>
      sx.query(`UPDATE consents SET expires_at = now() - interval '1 day' WHERE id = :id`, {
        id: p.uuid(consent),
      }),
    );
    try {
      expect(await beat('amara', live.call.id)).toEqual({
        remainingSeconds: 0,
        action: 'terminate',
        reason: 'disabled',
      });
      expect((await callRow(live.call.id)).endDetail).toBe('voice_consent');
      await expect(h.core.calls.start(ctx.amara, sessionId, {})).rejects.toMatchObject({
        code: 'persona_suspended',
        reason: 'voice_consent',
      });
    } finally {
      await h.t.db.system((sx) =>
        sx.query('UPDATE consents SET expires_at = NULL WHERE id = :id', { id: p.uuid(consent) }),
      );
    }
  });
});

describe('heartbeats', () => {
  it('report the time left and end the call on a switch, a suspension, the budget, the time limit or silence', async () => {
    const sessionId = await newSession('priya', 'benchtally');
    const first = await startCall('priya', sessionId);
    const ok = await beat('priya', first.call.id);
    expect(ok.action).toBe('continue');
    expect(ok.remainingSeconds).toBeGreaterThan(29 * 60);
    expect(ok.remainingSeconds).toBeLessThanOrEqual(30 * 60);
    expect((await callRow(first.call.id)).lastHeartbeatAt).not.toBeNull();

    // A setting changed while the call is live ends it at the next heartbeat.
    const terminated = async (
      key: string,
      value: string,
      expected: string,
      detail: string,
    ): Promise<void> => {
      const { call } = await startCall('priya', sessionId);
      await withSetting(key, value, async () => {
        expect(await beat('priya', call.id)).toEqual({
          remainingSeconds: 0,
          action: 'terminate',
          reason: expected,
        });
        // Later heartbeats keep saying so.
        expect((await beat('priya', call.id)).action).toBe('terminate');
      });
      expect(await callRow(call.id)).toMatchObject({
        status: 'ended',
        endReason: expected,
        endDetail: detail,
      });
    };
    await terminated('calls_enabled', 'false', 'disabled', 'calls_disabled');
    await terminated('ai_enabled', 'false', 'disabled', 'kill_switch');
    await terminated('daily_call_minutes_per_principal', '0', 'budget', 'daily_call_minutes');
    // The call this beat belongs to is checked for its own time limit and for silence.
    const { call: long } = await startCall('priya', sessionId);
    await backdate(long.id, 31, 0);
    expect(await beat('priya', long.id)).toMatchObject({ action: 'terminate', reason: 'timeout' });
    expect((await callRow(long.id)).endDetail).toBe('max_duration');
    const { call: silent } = await startCall('priya', sessionId);
    await backdate(silent.id, 6, 2);
    expect(await beat('priya', silent.id)).toMatchObject({ action: 'terminate', reason: 'timeout' });
    const reaped = await callRow(silent.id);
    expect(reaped.endDetail).toBe('stale_heartbeat');
    // Charged until a little after the last heartbeat, not until now.
    expect(reaped.elapsedSeconds).toBeLessThanOrEqual(4 * 60 + CALL_LIMITS.staleGraceSeconds + 1);
    // A suspended vEIR ends the call.
    const { call: suspended } = await startCall('priya', sessionId);
    await h.t.db.system((sx) =>
      sx.query(`UPDATE personas SET status = 'suspended' WHERE id = :id`, {
        id: p.uuid(h.ventures.benchtally.personaId),
      }),
    );
    try {
      expect(await beat('priya', suspended.id)).toMatchObject({ action: 'terminate', reason: 'disabled' });
      expect((await callRow(suspended.id)).endDetail).toBe('persona_unavailable');
    } finally {
      await h.t.db.system((sx) =>
        sx.query(`UPDATE personas SET status = 'active' WHERE id = :id`, {
          id: p.uuid(h.ventures.benchtally.personaId),
        }),
      );
    }
    // Only the caller's own calls.
    const { call: mine } = await startCall('priya', sessionId);
    await expect(beat('tomasz', mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.core.calls.end(ctx.tomasz, mine.id, { reason: 'user' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.core.calls.sttGrant(ctx.tomasz, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await endCall('priya', mine.id);
    expect(await auditActions()).toContain('call.terminated');
  });
});

describe('voice-turn admission', () => {
  async function admit(who: Person, sessionId: string, callId: string | undefined): Promise<void> {
    await kit.inRequest(ctx[who], (scope) => admitVoiceTurn(scope, { sessionId, callId, now: new Date() }));
  }

  it('admits spoken turns of a live call of the caller in that conversation only', async () => {
    const sessionId = await newSession('ines', 'emberloop');
    const { call } = await startCall('ines', sessionId);
    await admit('ines', sessionId, call.id);
    await expect(admit('ines', sessionId, undefined)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_required',
    });
    const other = await newSession('ines', 'emberloop');
    await expect(admit('ines', other, call.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(admit('jonah', sessionId, call.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(admit('ines', sessionId, 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    await withSetting('calls_enabled', 'false', async () => {
      await expect(admit('ines', sessionId, call.id)).rejects.toMatchObject({
        code: 'ai_disabled',
        reason: 'calls_disabled',
      });
    });
    await withSetting('daily_call_minutes_per_principal', '0', async () => {
      await expect(admit('ines', sessionId, call.id)).rejects.toMatchObject({
        code: 'rate_limited',
        reason: 'daily_call_minutes',
      });
    });
    // The voice-turn rate limit and the turn cap per call.
    const insertTurns = (count: number, channel: 'voice' | 'text') =>
      h.t.db.system((sx) =>
        sx.query(
          `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, channel, status)
           SELECT :t, :v, :s, 1000 + g + coalesce((SELECT max(ordinal) FROM turns WHERE session_id = :s), 0), :ines,
                  'coach', 'x', :channel, 'completed'
           FROM generate_series(1, :n) AS g`,
          {
            t: p.uuid(h.seed.tenantId),
            v: p.uuid(ventureId('emberloop')),
            s: p.uuid(sessionId),
            ines: p.uuid(h.people.ines),
            channel: p.text(channel),
            n: p.int(count),
          },
        ),
      );
    await insertTurns(CALL_LIMITS.voiceTurnRateLimit, 'voice');
    await expect(admit('ines', sessionId, call.id)).rejects.toMatchObject({
      code: 'rate_limited',
      reason: 'voice_turn_rate_limit',
    });
    await h.t.db.system((sx) =>
      sx.query(`UPDATE turns SET created_at = now() - interval '11 minutes' WHERE session_id = :s`, {
        s: p.uuid(sessionId),
      }),
    );
    await insertTurns(CALL_LIMITS.maxTurnsPerCall - CALL_LIMITS.voiceTurnRateLimit, 'text');
    await expect(admit('ines', sessionId, call.id)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_turn_limit',
    });
    await endCall('ines', call.id);
    await expect(admit('ines', sessionId, call.id)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_not_active',
    });
  });
});

describe('ending a call', () => {
  it('ends once, summarizes what the call produced, and shows the summary to the team', async () => {
    const sessionId = await newSession('maya', 'quietquad');
    const { call } = await startCall('maya', sessionId);
    const turn = await talk('maya', sessionId, call.id, 'How should we price the library pilot?');
    await talk('maya', sessionId, call.id, 'What should the second library see first?');
    const live = CallDetailResponse.parse(await h.core.calls.get(ctx.devin, call.id));
    expect(live).toMatchObject({ call: { status: 'live' }, summary: null });

    const ended = await h.core.calls.end(ctx.maya, call.id, {
      reason: 'user',
      clientStats: { firstAudioMsP50: 1400, firstAudioMsP95: 2600, bargeIns: 1, reconnects: 0 },
    });
    expect(ended.call).toMatchObject({ status: 'ended', endReason: 'user' });
    expect(ended.call.durationSeconds).toBe(ended.summary.durationSeconds);
    expect(ended.summary.turnCount).toBe(2);
    expect(ended.summary.nextActions.length).toBeGreaterThan(0);
    expect(ended.summary.memoryProposalIds.length).toBeGreaterThan(0);
    const proposals = await h.t.db.system((sx) =>
      sx.query(`SELECT source_refs FROM memory_objects WHERE id = ANY (:ids)`, {
        ids: p.uuidArray(ended.summary.memoryProposalIds),
      }),
    );
    expect(JSON.stringify(proposals.rows)).toContain(turn.id);
    expect(await h.t.db.system((sx) => callsRepo.getCall(sx, call.id))).toMatchObject({
      endDetail: 'client_user',
    });
    const stats = await h.t.db.system((sx) =>
      sx.query('SELECT first_audio_ms_p50, barge_ins FROM calls WHERE id = :id', { id: p.uuid(call.id) }),
    );
    expect(stats.rows[0]).toEqual({ first_audio_ms_p50: 1400, barge_ins: 1 });

    // Idempotent: ending again returns the same call and summary, and keeps the first reason.
    const again = await h.core.calls.end(ctx.maya, call.id, { reason: 'error' });
    expect(again).toEqual(ended);
    // The team sees the summary; people outside the venture see nothing.
    expect(CallDetailResponse.parse(await h.core.calls.get(ctx.devin, call.id))).toEqual(ended);
    await expect(h.core.calls.get(ctx.amara, call.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.core.calls.get(ctx.graham, call.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('barge-in', () => {
  it('records what the founder heard, once, for their own turns of a live call', async () => {
    const sessionId = await newSession('devin', 'quietquad');
    const { call } = await startCall('devin', sessionId);
    const turn = await talk('devin', sessionId, call.id, 'Which library should we approach first?');
    await h.core.calls.interrupt(ctx.devin, turn.id, { callId: call.id, heardSeq: 1 });
    await h.core.calls.interrupt(ctx.devin, turn.id, { callId: call.id, heardSeq: 4 });
    const heard = await h.t.db.system((sx) => callsRepo.listTurnInterruptions(sx, [turn.id]));
    expect(heard.get(turn.id)?.heardSeq).toBe(1);
    // Someone else's turn, or another call.
    await expect(
      h.core.calls.interrupt(ctx.maya, turn.id, { callId: call.id, heardSeq: 0 }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.core.calls.interrupt(ctx.devin, '00000000-0000-4000-8000-000000000000', {
        callId: call.id,
        heardSeq: 0,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.core.calls.interrupt(ctx.devin, turn.id, { callId: call.id, heardSeq: 20_000 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await endCall('devin', call.id);
    await expect(
      h.core.calls.interrupt(ctx.devin, turn.id, { callId: call.id, heardSeq: 0 }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await auditActions()).toContain('turn.interrupted');
  });
});

describe('speech', () => {
  const SPOKEN =
    'Start with the library that already counts seats. Ask for two weeks of hourly counts first.';

  async function spokenTurn(sessionId: string, callId: string): Promise<TurnView> {
    const turn = await talk('tomasz', sessionId, callId, 'Which lab should we pilot with?');
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE turns SET response = jsonb_set(response, '{spoken}', to_jsonb(:s::text)) WHERE id = :id`,
        {
          id: p.uuid(turn.id),
          s: p.text(SPOKEN),
        },
      ),
    );
    return turn;
  }

  it('speaks the signed intro and signed units, metered, in the call’s voice', async () => {
    const sessionId = await newSession('tomasz', 'benchtally');
    const { call, intro } = await startCall('tomasz', sessionId);
    if (intro === null) throw new Error('expected an intro');
    const audio = await h.core.speech.synthesize(ctx.tomasz, {
      sessionId,
      turnId: null,
      seq: 0,
      text: intro.text,
      sig: intro.sig,
    });
    const voice = (await callRow(call.id)).voiceId;
    expect(audio).toMatchObject({ contentType: 'audio/mpeg', voiceId: voice });
    expect(new TextDecoder().decode(await new Response(audio.audio).arrayBuffer())).toBe(`MP3:${intro.text}`);
    // A unit of a turn, signed the way the turn stream signs it.
    const turn = await spokenTurn(sessionId, call.id);
    const unit = 'Start with the library that already counts seats.';
    const sig = signSpeechUnit(await keys.signingKey(), { sessionId, turnId: turn.id, seq: 0, text: unit });
    await h.core.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text: unit, sig });
    // Changed words, another sequence number or another conversation break the signature.
    for (const tampered of [
      { text: 'Invest in us now.', seq: 0 },
      { text: unit, seq: 1 },
    ]) {
      await expect(
        h.core.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, sig, ...tampered }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      h.core.speech.synthesize(ctx.tomasz, {
        sessionId,
        turnId: null,
        seq: 0,
        text: intro.text.slice(0, 40),
        sig: intro.sig,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.speech.synthesize(ctx.tomasz, { sessionId, turnId: null, text: intro.text }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text: unit }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // Units of a reply that was blocked in the end are never spoken again.
    await h.t.db.system((sx) =>
      sx.query(`UPDATE turns SET status = 'blocked' WHERE id = :id`, { id: p.uuid(turn.id) }),
    );
    await expect(
      h.core.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text: unit, sig }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const ledger = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM usage_ledger WHERE purpose = 'speech' AND principal_id = :me`,
        {
          me: p.uuid(h.people.tomasz),
        },
      ),
    );
    expect(ledger.rows[0]).toEqual({ n: 2 });
    expect((await callRow(call.id)).speechCharacters).toBe(speakableText(intro.text).length + unit.length);
    expect(h.logger.dump()).not.toContain(unit);
    await endCall('tomasz', call.id);
  });

  it('speaks unsigned text only as whole sentences of a completed turn’s spoken reply, during the call', async () => {
    const sessionId = await newSession('tomasz', 'benchtally');
    const { call } = await startCall('tomasz', sessionId);
    const turn = await spokenTurn(sessionId, call.id);
    const say = (text: string) => h.core.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, text });
    await say(SPOKEN);
    await say('Ask for two weeks of hourly counts first.');
    for (const text of [
      'the library that already counts seats',
      'Ask for two weeks',
      'Invest in BenchTally now.',
    ]) {
      await expect(say(text)).rejects.toMatchObject({ code: 'validation_failed' });
    }
    // People outside the conversation learn nothing; the venture's own team needs its own live call.
    await expect(
      h.core.speech.synthesize(ctx.maya, { sessionId, turnId: turn.id, text: SPOKEN }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.core.speech.synthesize(ctx.priya, { sessionId, turnId: turn.id, text: SPOKEN }),
    ).rejects.toMatchObject({ code: 'conflict', reason: 'call_not_active' });
    // Kill switches and spend caps apply; local development answers 501 after the checks.
    await withSetting('calls_enabled', 'false', async () => {
      await expect(say(SPOKEN)).rejects.toMatchObject({ code: 'ai_disabled' });
    });
    const bare = createCore({
      db: h.t.db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
    });
    await expect(
      bare.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, text: SPOKEN }),
    ).rejects.toMatchObject({ code: 'speech_unavailable', status: 501 });
    await expect(
      bare.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, text: 'Not something it said.' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    speech.failNext = true;
    await expect(say(SPOKEN)).rejects.toMatchObject({ code: 'model_unavailable' });
    await h.t.db.system((sx) =>
      usageRepo.recordUsage(sx, {
        tenantId: h.seed.tenantId,
        principalId: h.people.tomasz,
        purpose: 'turn',
        modelId: 'test',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 5,
      }),
    );
    await expect(say(SPOKEN)).rejects.toMatchObject({ code: 'spend_cap_reached' });
    // A heartbeat now ends the call for the budget, and speech stops with it.
    expect(await beat('tomasz', call.id)).toMatchObject({ action: 'terminate', reason: 'budget' });
    await expect(say(SPOKEN)).rejects.toMatchObject({ code: 'conflict', reason: 'call_not_active' });
    expect(await auditActions()).toContain('speech.refused');
  });
});
