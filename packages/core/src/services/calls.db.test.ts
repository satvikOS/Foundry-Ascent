/**
 * Voice calls through the core services: starting a call (admission, the speech-to-text grant and the signed
 * intro), heartbeats that carry the kill switches, consent, access and budgets and meter speech-to-text,
 * grants refused on a call that has to stop, voice-turn admission, barge-in and the history as heard, the end
 * and its summary, speech of signed units or whole sentences of a stored spoken reply only, and the crisis
 * support message, which no call or budget rule stops.
 */
import {
  COACH_RESPONSE_SCHEMA_NAME,
  CRISIS_SPOKEN_MESSAGE,
  MockModelGateway,
  mockCoachResponse,
  type ChatMessage,
} from '@foundry/ai';
import {
  CallConfigResponse,
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
import { createCore, type Core } from '../core.js';
import { resolveDeps } from '../deps.js';
import { Kit } from '../internal/kit.js';
import { type RunTurnInput, type RunTurnOutcome } from '../orchestrator/run-turn.js';
import { signSpeechUnit, verifySpeechUnit } from '../orchestrator/speech-units.js';
import { type SynthesizedSpeech } from '../ports.js';
import { FakeSpeechSynthesizer, FakeSttGrantIssuer } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness, storeOpenerUnchecked } from '../testing/harness.js';
import { admitVoiceTurn } from './call-admission.js';
import { CALL_LIMITS } from './call-usage.js';
import { speakableText } from './spoken-text.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

let h: CoreHarness;
let kit: Kit;
let keys: PlatformKeyCache;
const speech = new FakeSpeechSynthesizer();
const stt = new FakeSttGrantIssuer();
/** The conversation each model call was given (the history the vEIR sees). */
const prompts: (readonly ChatMessage[])[] = [];
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

/** The stream events of a turn sent while the call is live (spoken: `channel: 'voice'` with the call id). */
async function send(
  who: Person,
  sessionId: string,
  callId: string,
  text: string,
): Promise<TurnStreamEvent[]> {
  const events: TurnStreamEvent[] = [];
  await h.core.orchestrator.runTurn(ctx[who], sessionId, { text, channel: 'voice', callId }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  return events;
}

/** A turn sent while the call is live, answered. */
async function talk(who: Person, sessionId: string, callId: string, text: string): Promise<TurnView> {
  const last = (await send(who, sessionId, callId, text)).at(-1);
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
  await backdateSeconds(callId, minutes * 60, beatMinutesAgo === null ? null : beatMinutesAgo * 60);
}

/** {@link backdate} in seconds. */
async function backdateSeconds(
  callId: string,
  seconds: number,
  beatSecondsAgo: number | null,
): Promise<void> {
  await h.t.db.system(async (sx) => {
    await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
    await sx.query(
      `UPDATE calls SET started_at = now() - make_interval(secs => :s),
              last_heartbeat_at = CASE WHEN :b::integer IS NULL THEN NULL
                                       ELSE now() - make_interval(secs => :b::integer) END
       WHERE id = :id`,
      { id: p.uuid(callId), s: p.int(seconds), b: p.nullable.int(beatSecondsAgo) },
    );
    await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
  });
}

/**
 * Speech as the HTTP route serves it: the audio is read to its end, which is when the synthesis's bookkeeping
 * (usage ledger, the call's counter, the audit) has finished. The bytes are handed back as a fresh stream.
 */
async function speak(
  context: RequestContext,
  input: Parameters<Core['speech']['synthesize']>[1],
): Promise<SynthesizedSpeech> {
  const spoken = await h.core.speech.synthesize(context, input);
  const bytes = await new Response(spoken.audio).arrayBuffer();
  return { ...spoken, audio: new Response(bytes).body ?? new ReadableStream<Uint8Array>() };
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

/** A person's speech-to-text usage rows (purpose `speech`, Transcribe). */
async function transcribedSeconds(person: Person): Promise<number[]> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT input_tokens FROM usage_ledger
       WHERE purpose = 'speech' AND model_id = :model AND principal_id = :me
       ORDER BY id`,
      // A parameter: a ":name" shape inside SQL text is refused (the Data API may read it as one).
      { me: p.uuid(h.people[person]), model: p.text('transcribe:streaming:en-US') },
    ),
  );
  return rows.rows.map((r) => Number(r.input_tokens));
}

/** A person's text-to-speech usage rows (Polly). */
async function pollyRows(person: Person): Promise<number> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT count(*)::int AS n FROM usage_ledger
       WHERE purpose = 'speech' AND model_id LIKE 'polly%' AND principal_id = :me`,
      { me: p.uuid(h.people[person]) },
    ),
  );
  return Number(rows.rows[0]?.n);
}

/** Settles every request at once: what was spoken, and the reasons of the refusals. */
async function concurrently<T>(
  count: number,
  fn: () => Promise<T>,
): Promise<{ fulfilled: number; reasons: (string | undefined)[] }> {
  const settled = await Promise.allSettled(Array.from({ length: count }, fn));
  return {
    fulfilled: settled.filter((r) => r.status === 'fulfilled').length,
    reasons: settled.flatMap((r) =>
      r.status === 'rejected' ? [(r.reason as { reason?: string }).reason] : [],
    ),
  };
}

/** Runs `fn` while the person (and so the platform) is over today's AI spend caps. */
async function withOverspend<T>(person: Person, fn: () => Promise<T>): Promise<T> {
  await h.t.db.system((sx) =>
    usageRepo.recordUsage(sx, {
      tenantId: h.seed.tenantId,
      principalId: h.people[person],
      purpose: 'turn',
      modelId: 'test-overspend',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 50,
    }),
  );
  try {
    return await fn();
  } finally {
    await h.t.db.system((sx) =>
      sx.query(`DELETE FROM usage_ledger WHERE model_id = 'test-overspend' AND principal_id = :p`, {
        p: p.uuid(h.people[person]),
      }),
    );
  }
}

async function voiceConsent(venture: 'solesignal', expired: boolean): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(
      `UPDATE consents SET expires_at = CASE WHEN :expired THEN now() - interval '1 day' END
       WHERE id = (SELECT consent_id FROM personas WHERE id = :persona)`,
      { expired: p.bool(expired), persona: p.uuid(h.ventures[venture].personaId) },
    ),
  );
}

beforeAll(async () => {
  h = await createCoreHarness({
    speech,
    sttGrants: stt,
    gatewayOptions: {
      fixtures: {
        [COACH_RESPONSE_SCHEMA_NAME]: (context) => {
          prompts.push(context.messages);
          return mockCoachResponse(context);
        },
      },
    },
  });
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
    // The grant only has to open the stream: it lives seconds, not minutes.
    expect(stt.calls.at(-1)).toMatchObject({ expiresInSeconds: CALL_LIMITS.sttGrantSeconds });
    expect(CALL_LIMITS.sttGrantSeconds).toBeLessThanOrEqual(30);
    const intro = started.intro;
    if (intro === null) throw new Error('expected an intro');
    // Maya has met her vEIR (the seeded conversation): one sentence of at most 90 characters, greeting her around
    // the opener's thread (the seeded notebook's five library-staff interviews).
    expect(intro.text).toMatch(/^Hi Maya, .*five library-staff interviews.*\?$/);
    expect(intro.text.length).toBeLessThanOrEqual(90);
    expect(intro.text.split(/(?<=[.!?])\s+/)).toHaveLength(1);
    // What the call said is the conversation's first message: the vEIR's history holds the greeting it gave.
    expect((await h.core.sessions.get(ctx.maya, sessionId)).session.opener).toBe(intro.text);
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
    expect(third.intro?.text).toBe('Hi Maya, where would you like to pick up?');
    await endCall('maya', third.call.id);
    expect(await auditActions()).toEqual(expect.arrayContaining(['call.started', 'call.ended']));
    // The grant URL and the intro are content: never logged.
    expect(h.logger.dump()).not.toContain('stt.test.invalid');
    expect(h.logger.dump()).not.toContain('library-staff');
  });

  it('leaves out a stored opener that impersonates the EIR (the notebook now refuses to save one)', async () => {
    const text = 'Corin here. I read your whole plan myself last night.';
    const notebook = await h.core.notebook.get(ctx.maya, ventureId('quietquad'));
    await expect(
      h.core.notebook.update(ctx.maya, ventureId('quietquad'), {
        expectedVersion: notebook.version,
        edit: { action: 'edit_opener', text },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await storeOpenerUnchecked(h, h.ventures.quietquad, text);
    const sessionId = await newSession('maya', 'quietquad');
    const started = await startCall('maya', sessionId);
    // Never the stored line: the call picks up Maya's last conversation (the test above) instead.
    expect(started.intro?.text).toMatch(/^Hi Maya, /);
    expect(started.intro?.text).toContain('whether you can test the seat map this week?');
    expect(started.intro?.text).not.toMatch(/Corin here|myself/);
    await endCall('maya', started.call.id);
  });

  it('introduces a persona named after its EIR as the EIR’s vEIR, and leaves out an opener that names the EIR', async () => {
    await storeOpenerUnchecked(h, h.ventures.quietquad, 'Corin asked me to check in on your pilot.');
    const rename = (name: string) =>
      h.t.db.system((sx) =>
        sx.query('UPDATE personas SET name = :n WHERE id = :id', {
          n: p.text(name),
          id: p.uuid(h.ventures.quietquad.personaId),
        }),
      );
    await rename('Corin Halvorsen');
    try {
      const sessionId = await newSession('maya', 'quietquad');
      const started = await startCall('maya', sessionId);
      expect(started.intro?.text).toMatch(/^Hi Maya, /);
      expect(started.intro?.text).not.toMatch(/Corin Halvorsen|Corin asked/);
      await endCall('maya', started.call.id);
    } finally {
      await rename("Corin's vEIR");
    }
  });

  it('chooses, phrases and keeps the opener in one transaction before it responds (wave 7 review)', async () => {
    let transactions = 0;
    const db = new Proxy(h.t.db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (prop !== 'withContext') return fn.bind(target);
        return (...args: unknown[]) => {
          transactions += 1;
          return fn.apply(target, args);
        };
      },
    });
    const counted = createCore({
      db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
    });
    const sessionId = await newSession('maya', 'quietquad');
    transactions = 0;
    const started = StartCallResponse.parse(
      await counted.calls.start(ctx.maya, sessionId, { inputMode: 'typed' }),
    );
    expect(started.intro).not.toBeNull();
    // The call itself, then its opener chosen, said and kept: no third round before the greeting can be spoken.
    expect(transactions).toBe(2);
    expect((await h.core.sessions.get(ctx.maya, sessionId)).session.opener).toBe(started.intro?.text);
    await endCall('maya', started.call.id);
  });

  it('opens the model and speech connections while it prepares the greeting, without holding it (LAB-P2)', async () => {
    const warmed: string[] = [];
    class Warming extends MockModelGateway {
      prewarm(): Promise<void> {
        warmed.push('model');
        return Promise.resolve();
      }
    }
    const after: Promise<unknown>[] = [];
    const counted = createCore({
      db: h.t.db,
      gateway: new Warming(),
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      speech: Object.assign(new FakeSpeechSynthesizer(), {
        prewarm: () => {
          warmed.push('speech');
          // Never answers: the call starts all the same.
          return new Promise<void>(() => undefined);
        },
      }),
      afterResponse: (task) => {
        after.push(task);
      },
    });
    const sessionId = await newSession('maya', 'quietquad');
    const started = StartCallResponse.parse(
      await counted.calls.start(ctx.maya, sessionId, { inputMode: 'typed' }),
    );
    expect(started.intro).not.toBeNull();
    expect(warmed.sort()).toEqual(['model', 'speech']);
    // Handed to the host to keep alive after the response, never awaited by it.
    expect(after).toHaveLength(1);
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
    // … unless the caller asks to end it and start here …
    const moved = StartCallResponse.parse(
      await h.core.calls.start(ctx.devin, other, { inputMode: 'typed', replace: true }),
    );
    expect(await callRow(live.call.id)).toMatchObject({
      status: 'ended',
      endReason: 'navigated',
      endDetail: 'replaced',
    });
    // … and closed once its client went away.
    await backdate(moved.call.id, 5, 3);
    const next = await startCall('devin', sessionId);
    expect(await callRow(moved.call.id)).toMatchObject({
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
    // Speech-to-text is metered from the microphone seconds a heartbeat adds (never more than the wall time).
    const billed = await transcribedSeconds('priya');
    expect(billed).toHaveLength(1);
    expect(billed[0]).toBeGreaterThan(0);
    expect(billed[0]).toBeLessThanOrEqual(12);
    expect((await callRow(first.call.id)).micOpenSeconds).toBe(billed[0]);

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
    // Charged until the stale window after the last heartbeat (as long as it was usable), not until now.
    expect(reaped.elapsedSeconds).toBeGreaterThanOrEqual(4 * 60 + CALL_LIMITS.staleSeconds - 1);
    expect(reaped.elapsedSeconds).toBeLessThanOrEqual(4 * 60 + CALL_LIMITS.staleSeconds + 1);
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
    // Losing write access (the venture archived) ends the call too.
    const { call: archived } = await startCall('priya', sessionId);
    const archive = (status: 'archived' | 'active') =>
      h.t.db.system((sx) =>
        sx.query('UPDATE ventures SET status = :s WHERE id = :id', {
          s: p.text(status),
          id: p.uuid(ventureId('benchtally')),
        }),
      );
    await archive('archived');
    try {
      expect(await beat('priya', archived.id)).toMatchObject({ action: 'terminate', reason: 'disabled' });
      expect((await callRow(archived.id)).endDetail).toBe('access_revoked');
    } finally {
      await archive('active');
    }
    // A typed call streams no audio: nothing is billed for it.
    const typed = await startCall('priya', sessionId, 'typed');
    const before = (await transcribedSeconds('priya')).length;
    await beat('priya', typed.call.id);
    expect(await transcribedSeconds('priya')).toHaveLength(before);
    await endCall('priya', typed.call.id);
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

  it('meter no more speech-to-text than the call has lasted, however fast or concurrently they come', async () => {
    const sessionId = await newSession('ines', 'emberloop');
    const { call } = await startCall('ines', sessionId);
    const billed = async () => (await transcribedSeconds('ines')).reduce((a, b) => a + b, 0);
    const before = await billed();
    const claimDay = () =>
      h.core.calls.heartbeat(ctx.ines, call.id, { state: 'listening', micOpenSeconds: 86_400 });
    for (let i = 0; i < 40; i += 1) await claimDay();
    await Promise.all(Array.from({ length: 8 }, claimDay));
    const row = await callRow(call.id);
    // Every second added is metered once, and the call has lasted a second or two: the platform cap is safe.
    expect((await billed()) - before).toBe(row.micOpenSeconds);
    expect(row.micOpenSeconds).toBeLessThanOrEqual(row.elapsedSeconds + 1 + callsRepo.MIC_SECONDS_SLACK);
    await endCall('ines', call.id);
  });
});

describe('speech-to-text grants', () => {
  it('are refused on a call that has to stop, and capped per person per day', async () => {
    const sessionId = await newSession('priya', 'benchtally');
    const { call } = await startCall('priya', sessionId);
    expect((await h.core.calls.sttGrant(ctx.priya, call.id)).url).toMatch(/^wss:/);
    const suspend = (status: 'suspended' | 'active') =>
      h.t.db.system((sx) =>
        sx.query('UPDATE personas SET status = :s WHERE id = :id', {
          s: p.text(status),
          id: p.uuid(h.ventures.benchtally.personaId),
        }),
      );
    await suspend('suspended');
    try {
      await expect(h.core.calls.sttGrant(ctx.priya, call.id)).rejects.toMatchObject({
        code: 'persona_suspended',
        reason: 'persona_unavailable',
      });
    } finally {
      await suspend('active');
    }
    await withSetting('daily_call_minutes_per_principal', '0', async () => {
      await expect(h.core.calls.sttGrant(ctx.priya, call.id)).rejects.toMatchObject({
        code: 'rate_limited',
        reason: 'daily_call_minutes',
      });
    });
    await withSetting('calls_enabled', 'false', async () => {
      await expect(h.core.calls.sttGrant(ctx.priya, call.id)).rejects.toMatchObject({
        code: 'ai_disabled',
        reason: 'calls_disabled',
      });
    });
    // The refusals did not end the call; its next heartbeat decides.
    expect((await callRow(call.id)).status).toBe('live');
    // Grants across the day's calls are capped: the next call starts typed, and no grant is minted.
    await h.t.db.system((sx) =>
      sx.query('UPDATE calls SET stt_grants = :n WHERE id = :id', {
        n: p.int(CALL_LIMITS.sttGrantsPerDay),
        id: p.uuid(call.id),
      }),
    );
    await expect(h.core.calls.sttGrant(ctx.priya, call.id)).rejects.toMatchObject({
      code: 'rate_limited',
      reason: 'stt_grant_daily_limit',
    });
    const next = await startCall('priya', sessionId);
    expect(next).toMatchObject({ sttGrant: null, call: { inputMode: 'typed' } });
    await endCall('priya', next.call.id);
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
    // The founder says what is worth remembering in their own words (the coach's framing alone is not kept).
    const turn = await talk(
      'maya',
      sessionId,
      call.id,
      'Willingness to pay has not been tested with a paid commitment yet. How should we price the library pilot?',
    );
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
    // What the call taught was kept automatically: nothing awaits a Keep.
    expect(ended.summary.memoryProposalIds).toEqual([]);
    expect(ended.summary.memoryKeptIds?.length).toBeGreaterThan(0);
    const kept = await h.t.db.system((sx) =>
      sx.query(`SELECT source_refs, status FROM memory_objects WHERE id = ANY (:ids)`, {
        ids: p.uuidArray(ended.summary.memoryKeptIds ?? []),
      }),
    );
    expect(JSON.stringify(kept.rows)).toContain(turn.id);
    expect(kept.rows.every((r) => r.status === 'confirmed')).toBe(true);
    expect(await h.t.db.system((sx) => callsRepo.getCall(sx, call.id))).toMatchObject({
      endDetail: 'client_user',
    });
    const stats = await h.t.db.system((sx) =>
      sx.query('SELECT first_audio_ms_p50, barge_ins FROM calls WHERE id = :id', { id: p.uuid(call.id) }),
    );
    expect(stats.rows[0]).toEqual({ first_audio_ms_p50: 1400, barge_ins: 1 });

    // A client claims only what it knows first-hand; the server's own reasons come from its checks.
    const claimed = await startCall('maya', sessionId);
    const claimedEnd = await h.core.calls.end(ctx.maya, claimed.call.id, { reason: 'budget' });
    expect(claimedEnd.call.endReason).toBe('user');
    expect((await callRow(claimed.call.id)).endDetail).toBe('client_budget');
    const spent = await startCall('maya', sessionId);
    await withSetting('daily_call_minutes_per_principal', '0', async () => {
      const ended = await h.core.calls.end(ctx.maya, spent.call.id, {
        reason: 'user',
        clientStats: { firstAudioMsP50: 900, firstAudioMsP95: 1500, bargeIns: 0, reconnects: 0 },
      });
      expect(ended.call.endReason).toBe('budget');
    });
    expect(await callRow(spent.call.id)).toMatchObject({ endDetail: 'daily_call_minutes' });

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
  async function withSpoken(turnId: string, spoken: string): Promise<void> {
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE turns SET response = jsonb_set(response, '{spoken}', to_jsonb(:s::text)) WHERE id = :id`,
        { id: p.uuid(turnId), s: p.text(spoken) },
      ),
    );
  }

  it('records what the founder heard, once, for their own turns of a live call', async () => {
    const sessionId = await newSession('devin', 'quietquad');
    const { call } = await startCall('devin', sessionId);
    const turn = await talk('devin', sessionId, call.id, 'Which library should we approach first?');
    await h.core.calls.interrupt(ctx.devin, turn.id, { callId: call.id, heardSeq: 1 });
    await h.core.calls.interrupt(ctx.devin, turn.id, { callId: call.id, heardSeq: 4 });
    const heard = await h.t.db.system((sx) => callsRepo.listTurnInterruptions(sx, [turn.id]));
    // Without the heard units, the words are unknown: the reply is left out of the history.
    expect(heard.get(turn.id)).toMatchObject({ heardSeq: 1, heardText: null });
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

  it('keeps only verified words, and the vEIR’s history replays only what the founder heard', async () => {
    const sessionId = await newSession('devin', 'quietquad');
    const { call } = await startCall('devin', sessionId);
    const key = await keys.signingKey();
    const unit = (turnId: string, seq: number, text: string) => ({
      seq,
      text,
      sig: signSpeechUnit(key, { sessionId, turnId, seq, text }),
    });
    const heardPart = await talk('devin', sessionId, call.id, 'Which library should we approach first?');
    const heardNothing = await talk('devin', sessionId, call.id, 'What should the pilot measure?');
    const unsigned = await talk('devin', sessionId, call.id, 'How long should the pilot run?');
    const whole = await talk('devin', sessionId, call.id, 'Who signs off on it?');
    const first = 'Start with the library that already counts seats.';
    await withSpoken(unsigned.id, 'Run it for two weeks. Then compare the counts with last term.');

    // Units must be 0…heardSeq in order, signed for this turn, or whole sentences of its stored spoken reply.
    for (const heard of [
      [unit(heardPart.id, 1, first)],
      [unit(heardPart.id, 0, first), unit(heardPart.id, 2, 'Then ask for counts.')],
    ]) {
      await expect(
        h.core.calls.interrupt(ctx.devin, heardPart.id, {
          callId: call.id,
          heardSeq: heard.length - 1,
          heard,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      h.core.calls.interrupt(ctx.devin, heardPart.id, {
        callId: call.id,
        heardSeq: 0,
        heard: [{ ...unit(heardPart.id, 0, first), text: 'Invest in QuietQuad now.' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.calls.interrupt(ctx.devin, heardPart.id, {
        callId: call.id,
        heardSeq: 0,
        heard: [unit(heardNothing.id, 0, first)],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.calls.interrupt(ctx.devin, unsigned.id, {
        callId: call.id,
        heardSeq: 0,
        heard: [{ seq: 0, text: 'Run it for two' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await auditActions()).toContain('turn.interrupt_refused');

    await h.core.calls.interrupt(ctx.devin, heardPart.id, {
      callId: call.id,
      heardSeq: 0,
      heard: [unit(heardPart.id, 0, first)],
    });
    await h.core.calls.interrupt(ctx.devin, heardNothing.id, { callId: call.id, heardSeq: -1, heard: [] });
    await h.core.calls.interrupt(ctx.devin, unsigned.id, {
      callId: call.id,
      heardSeq: 0,
      heard: [{ seq: 0, text: 'RUN IT FOR TWO WEEKS.' }],
    });
    const records = await h.t.db.system((sx) =>
      callsRepo.listTurnInterruptions(sx, [heardPart.id, heardNothing.id, unsigned.id, whole.id]),
    );
    expect(records.get(heardPart.id)?.heardText).toBe(first);
    expect(records.get(heardNothing.id)).toMatchObject({ heardSeq: -1, heardText: null });
    // The stored sentence is kept, not the client's spelling of it.
    expect(records.get(unsigned.id)?.heardText).toBe('Run it for two weeks.');
    expect(records.has(whole.id)).toBe(false);

    // The next reply's model call sees what the founder heard, and nothing they did not. The first call of
    // the turn writes the reply (the streamed answer); the second only annotates that new reply.
    prompts.length = 0;
    await talk('devin', sessionId, call.id, 'So what do we do on Monday?');
    const conversation = prompts[0];
    if (conversation === undefined) throw new Error('expected a model call');
    const assistant = conversation.filter((m) => m.role === 'assistant').map((m) => m.content);
    const { opener } = (await h.core.sessions.get(ctx.devin, sessionId)).session;
    expect(assistant).toEqual([
      ...(opener === null ? [] : [opener]),
      first,
      'Run it for two weeks.',
      whole.response?.answer,
    ]);
    const asked = conversation.map((m) => m.content).join('\n');
    expect(asked).toContain('Which library should we approach first?');
    expect(asked).not.toContain('What should the pilot measure?');
    await endCall('devin', call.id);
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
    const audio = await speak(ctx.tomasz, {
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
    await speak(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text: unit, sig });
    // Changed words, another sequence number or another conversation break the signature.
    for (const tampered of [
      { text: 'Invest in us now.', seq: 0 },
      { text: unit, seq: 1 },
    ]) {
      await expect(speak(ctx.tomasz, { sessionId, turnId: turn.id, sig, ...tampered })).rejects.toMatchObject(
        { code: 'validation_failed' },
      );
    }
    await expect(
      speak(ctx.tomasz, {
        sessionId,
        turnId: null,
        seq: 0,
        text: intro.text.slice(0, 40),
        sig: intro.sig,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(speak(ctx.tomasz, { sessionId, turnId: null, text: intro.text })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(speak(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text: unit })).rejects.toMatchObject(
      { code: 'validation_failed' },
    );
    // Units of a reply that was blocked in the end are never spoken again.
    await h.t.db.system((sx) =>
      sx.query(`UPDATE turns SET status = 'blocked' WHERE id = :id`, { id: p.uuid(turn.id) }),
    );
    await expect(
      speak(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text: unit, sig }),
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
    const say = (text: string) => speak(ctx.tomasz, { sessionId, turnId: turn.id, text });
    await say(SPOKEN);
    await say('Ask for two weeks of hourly counts first.');
    // Another spelling of a stored sentence is spoken in the stored words.
    await say('ASK FOR TWO WEEKS OF HOURLY COUNTS FIRST.');
    expect(speech.calls.at(-1)?.text).toBe('Ask for two weeks of hourly counts first.');
    for (const text of [
      'the library that already counts seats',
      'Ask for two weeks',
      'Invest in BenchTally now.',
    ]) {
      await expect(say(text)).rejects.toMatchObject({ code: 'validation_failed' });
    }
    // People outside the conversation learn nothing; the venture's own team needs its own live call.
    await expect(speak(ctx.maya, { sessionId, turnId: turn.id, text: SPOKEN })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(speak(ctx.priya, { sessionId, turnId: turn.id, text: SPOKEN })).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_not_active',
    });
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
    await withOverspend('tomasz', async () => {
      await expect(say(SPOKEN)).rejects.toMatchObject({ code: 'spend_cap_reached' });
      // The spend caps are checked before a server without speech answers 501.
      await expect(
        bare.speech.synthesize(ctx.tomasz, { sessionId, turnId: turn.id, text: SPOKEN }),
      ).rejects.toMatchObject({ code: 'spend_cap_reached' });
      // A heartbeat now ends the call for the budget, and speech stops with it.
      expect(await beat('tomasz', call.id)).toMatchObject({ action: 'terminate', reason: 'budget' });
    });
    await expect(say(SPOKEN)).rejects.toMatchObject({ code: 'conflict', reason: 'call_not_active' });
    expect(await auditActions()).toContain('speech.refused');
  });

  it('speaks the intro and each signed unit once per call, however often or concurrently they are asked for', async () => {
    const sessionId = await newSession('tomasz', 'benchtally');
    const { call, intro } = await startCall('tomasz', sessionId);
    if (intro === null) throw new Error('expected an intro');
    const before = await pollyRows('tomasz');
    const introUnit = { sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig };
    await speak(ctx.tomasz, introUnit);
    await expect(speak(ctx.tomasz, introUnit)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'speech_already_played',
      status: 409,
    });
    // A unit of a reply, asked for twelve times at once: spoken (and billed) once.
    const turn = await spokenTurn(sessionId, call.id);
    const text = 'Start with the library that already counts seats.';
    const sig = signSpeechUnit(await keys.signingKey(), { sessionId, turnId: turn.id, seq: 0, text });
    const burst = await concurrently(12, () =>
      speak(ctx.tomasz, { sessionId, turnId: turn.id, seq: 0, text, sig }),
    );
    expect(burst.fulfilled).toBe(1);
    expect(new Set(burst.reasons)).toEqual(new Set(['speech_already_played']));
    expect((await pollyRows('tomasz')) - before).toBe(2);
    expect((await callRow(call.id)).speechCharacters).toBe(speakableText(intro.text).length + text.length);
    // A synthesis that failed can be asked for again: nothing was spoken or billed.
    const next = signSpeechUnit(await keys.signingKey(), { sessionId, turnId: turn.id, seq: 1, text });
    speech.failNext = true;
    const failed = { sessionId, turnId: turn.id, seq: 1, text, sig: next };
    await expect(speak(ctx.tomasz, failed)).rejects.toMatchObject({
      code: 'model_unavailable',
    });
    await speak(ctx.tomasz, failed);
    // A new call (a reload) has its own intro, spoken once again.
    const again = await startCall('tomasz', sessionId);
    if (again.intro === null) throw new Error('expected an intro');
    const sameIntro = { ...introUnit, text: again.intro.text, sig: again.intro.sig };
    await speak(ctx.tomasz, sameIntro);
    await expect(speak(ctx.tomasz, sameIntro)).rejects.toMatchObject({
      reason: 'speech_already_played',
    });
    await endCall('tomasz', again.call.id);
  });

  it('bounds what a call speaks by how long it has lasted, and what a person’s calls speak in a day', async () => {
    const sentences = Array.from(
      { length: 14 },
      (_, i) =>
        `In week ${String(i + 1)}, ask the staff of the second library for hourly seat counts and their busiest days.`,
    );
    const sessionId = await newSession('tomasz', 'benchtally');
    const { call } = await startCall('tomasz', sessionId);
    const turn = await talk('tomasz', sessionId, call.id, 'What should we ask the libraries?');
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE turns SET response = jsonb_set(response, '{spoken}', to_jsonb(:s::text)) WHERE id = :id`,
        { id: p.uuid(turn.id), s: p.text(sentences.join(' ')) },
      ),
    );
    const say = (text: string) => speak(ctx.tomasz, { sessionId, turnId: turn.id, text });
    // Unsigned, the same stored words twice (once, and once more on request), then no more.
    const [first = ''] = sentences;
    await say(first);
    await say(first);
    await expect(say(first)).rejects.toMatchObject({ code: 'conflict', reason: 'speech_already_played' });
    // Other runs of the reply, until the call has said all it may this soon after it started.
    const runs: string[] = [];
    for (let start = 1; start < sentences.length; start += 1) {
      for (let end = start; end < sentences.length; end += 1)
        runs.push(sentences.slice(start, end + 1).join(' '));
    }
    let refusal: unknown = null;
    let refused = '';
    for (const run of runs) {
      try {
        await say(run);
      } catch (err) {
        refusal = err;
        refused = run;
        break;
      }
    }
    expect(refusal).toMatchObject({ code: 'rate_limited', reason: 'call_speech_limit', status: 429 });
    const row = await callRow(call.id);
    expect(row.speechCharacters).toBeLessThanOrEqual(
      CALL_LIMITS.speechHeadroomCharacters + CALL_LIMITS.speechCharactersPerSecond * (row.elapsedSeconds + 1),
    );
    // Refused because it would not fit, not before.
    expect(row.speechCharacters + refused.length).toBeGreaterThan(CALL_LIMITS.speechHeadroomCharacters);
    // A minute later the call may say another minute's worth.
    await backdateSeconds(call.id, 60, 0);
    await say(sentences.slice(2, 5).join(' '));

    // The person's calls of the day share one budget: the rate over the daily minute cap.
    const dailyCap = await h.t.db.system(async (sx) => {
      const r = await sx.query(
        `SELECT value::text AS v FROM platform_settings WHERE key = 'daily_call_minutes_per_principal'`,
      );
      return Number(r.rows[0]?.v ?? 60);
    });
    const daily = CALL_LIMITS.speechCharactersPerSecond * dailyCap * 60;
    const ended = await startCall('tomasz', sessionId, 'typed');
    await endCall('tomasz', ended.call.id);
    const fresh = await startCall('tomasz', sessionId, 'typed');
    await h.t.db.system((sx) =>
      sx.query('UPDATE calls SET speech_characters = :n WHERE id = :id', {
        id: p.uuid(ended.call.id),
        n: p.int(daily),
      }),
    );
    const freshTurn = await spokenTurn(sessionId, fresh.call.id);
    await expect(speak(ctx.tomasz, { sessionId, turnId: freshTurn.id, text: SPOKEN })).rejects.toMatchObject({
      code: 'rate_limited',
      reason: 'daily_speech_limit',
    });
    await h.t.db.system((sx) =>
      sx.query('UPDATE calls SET speech_characters = 0 WHERE id = :id', { id: p.uuid(ended.call.id) }),
    );
    await speak(ctx.tomasz, { sessionId, turnId: freshTurn.id, text: SPOKEN });
    await endCall('tomasz', fresh.call.id);
  });
});

describe('crisis support on a call', () => {
  const CRISIS = 'I want to kill myself tonight.';

  it('speaks the fixed support message of the founder’s own crisis turn whatever the call, switches and caps', async () => {
    const sessionId = await newSession('maya', 'quietquad');
    const { call } = await startCall('maya', sessionId);
    const events = await send('maya', sessionId, call.id, CRISIS);
    const blocked = events.at(-1);
    if (blocked?.event !== 'turn.blocked') throw new Error('expected the crisis path');
    expect(blocked.reason).toBe('crisis_support');
    const turnId = blocked.turnId;
    const sig = signSpeechUnit(await keys.signingKey(), {
      sessionId,
      turnId,
      seq: 0,
      text: CRISIS_SPOKEN_MESSAGE,
    });
    const crisisUnit = { sessionId, turnId, seq: 0, text: CRISIS_SPOKEN_MESSAGE, sig };
    const voice = (await callRow(call.id)).voiceId;

    // The signed unit the turn engine streams, in the call's voice, metered.
    await speak(ctx.maya, crisisUnit);
    expect(speech.calls.at(-1)).toMatchObject({ text: CRISIS_SPOKEN_MESSAGE, voiceId: voice });
    // A changed text under its signature is refused; the message itself unsigned is the same message.
    await expect(speak(ctx.maya, { ...crisisUnit, seq: 1 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    // Spend caps, the kill switches and the call's end do not stand between the founder and support.
    await withOverspend('maya', () =>
      withSetting('ai_enabled', 'false', () =>
        withSetting('calls_enabled', 'false', () =>
          speak(ctx.maya, { sessionId, turnId, text: CRISIS_SPOKEN_MESSAGE }),
        ),
      ),
    );
    await endCall('maya', call.id);
    await speak(ctx.maya, crisisUnit);
    // Someone else, other words of the turn, or another turn of the conversation: the ordinary rules apply.
    await expect(speak(ctx.devin, { sessionId, turnId, text: CRISIS_SPOKEN_MESSAGE })).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_not_active',
    });
    // A server without speech answers 501 once the checks pass.
    const bare = createCore({
      db: h.t.db,
      gateway: h.gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
    });
    await expect(bare.speech.synthesize(ctx.maya, crisisUnit)).rejects.toMatchObject({
      code: 'speech_unavailable',
    });
    // Played a few times at most (reconnects), then it stays on screen.
    await speak(ctx.maya, crisisUnit);
    await speak(ctx.maya, crisisUnit);
    await expect(speak(ctx.maya, crisisUnit)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'crisis_speech_limit',
    });
    const syntheses = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE action = 'speech.synthesized' AND object_id = :t AND policy_reason = 'crisis_support'`,
        { t: p.text(turnId) },
      ),
    );
    expect(syntheses.rows[0]).toEqual({ n: CALL_LIMITS.crisisSpeechReplays });
    // Long after the turn, the ordinary rules apply again.
    await h.t.db.system((sx) =>
      sx.query(`UPDATE turns SET created_at = now() - interval '11 minutes' WHERE id = :id`, {
        id: p.uuid(turnId),
      }),
    );
    await expect(speak(ctx.maya, crisisUnit)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.logger.dump()).not.toContain(CRISIS_SPOKEN_MESSAGE);
  });

  it('speaks it in the platform voice once the EIR’s voice consent lapsed', async () => {
    const sessionId = await newSession('amara', 'solesignal');
    const { call } = await startCall('amara', sessionId);
    expect((await callRow(call.id)).voiceId).toBe('Matthew');
    const blocked = (await send('amara', sessionId, call.id, CRISIS)).at(-1);
    if (blocked?.event !== 'turn.blocked') throw new Error('expected the crisis path');
    await voiceConsent('solesignal', true);
    try {
      await speak(ctx.amara, {
        sessionId,
        turnId: blocked.turnId,
        text: CRISIS_SPOKEN_MESSAGE,
      });
      expect(speech.calls.at(-1)).toMatchObject({
        text: CRISIS_SPOKEN_MESSAGE,
        voiceId: DEFAULT_SPEECH_VOICE,
      });
    } finally {
      await voiceConsent('solesignal', false);
    }
    await endCall('amara', call.id);
  });

  it('plays the support message at most five times, however many requests come at once', async () => {
    const sessionId = await newSession('priya', 'benchtally');
    const { call } = await startCall('priya', sessionId);
    const blocked = (await send('priya', sessionId, call.id, CRISIS)).at(-1);
    if (blocked?.event !== 'turn.blocked') throw new Error('expected the crisis path');
    const turnId = blocked.turnId;
    // Synthesis takes a while, as it does for real: every request is in flight before any finishes.
    speech.delayMs = 100;
    try {
      const burst = await concurrently(20, () =>
        speak(ctx.priya, { sessionId, turnId, text: CRISIS_SPOKEN_MESSAGE }),
      );
      expect(burst.fulfilled).toBe(CALL_LIMITS.crisisSpeechReplays);
      expect(new Set(burst.reasons)).toEqual(new Set(['crisis_speech_limit']));
    } finally {
      speech.delayMs = 0;
    }
    const syntheses = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE action = 'speech.synthesized' AND object_id = :t AND policy_reason = 'crisis_support'`,
        { t: p.text(turnId) },
      ),
    );
    expect(syntheses.rows[0]).toEqual({ n: CALL_LIMITS.crisisSpeechReplays });
    await endCall('priya', call.id);
  });
});

describe('call configuration and avatar sessions', () => {
  it('report the calls switch and follow the call voice rule', async () => {
    const config = CallConfigResponse.parse(await h.core.veir.callConfig(ctx.amara, ventureId('solesignal')));
    expect(config).toMatchObject({ aiEnabled: true, callsEnabled: true });
    await withSetting('calls_enabled', 'false', async () => {
      expect((await h.core.veir.callConfig(ctx.amara, ventureId('solesignal'))).callsEnabled).toBe(false);
      await expect(
        h.core.veir.avatarSession(ctx.amara, { ventureId: ventureId('solesignal') }),
      ).rejects.toMatchObject({ code: 'ai_disabled', reason: 'calls_disabled' });
    });
    expect(await h.core.veir.avatarSession(ctx.amara, { ventureId: ventureId('solesignal') })).toMatchObject({
      voiceId: 'Matthew',
    });
    await voiceConsent('solesignal', true);
    try {
      await expect(
        h.core.veir.avatarSession(ctx.amara, { ventureId: ventureId('solesignal') }),
      ).rejects.toMatchObject({ code: 'persona_suspended', reason: 'voice_consent' });
    } finally {
      await voiceConsent('solesignal', false);
    }
  });
});

describe('the turn engine and the calls service together', () => {
  const unitsOf = (events: readonly TurnStreamEvent[]) =>
    events.flatMap((e) => (e.event === 'turn.speech' ? [e] : []));

  async function turn(
    who: Person,
    sessionId: string,
    input: RunTurnInput,
  ): Promise<{ events: TurnStreamEvent[]; outcome: RunTurnOutcome }> {
    const events: TurnStreamEvent[] = [];
    const outcome = await h.core.orchestrator.runTurn(ctx[who], sessionId, input, (e) => {
      events.push(TurnStreamEvent.parse(e));
    });
    return { events, outcome };
  }

  const voiceTurns = (who: Person) =>
    h.t.db.system((sx) =>
      callsRepo.countRecentVoiceTurns(sx, {
        authorId: h.people[who],
        windowSeconds: CALL_LIMITS.voiceTurnRateWindowSeconds,
      }),
    );

  it('admits a spoken turn through the calls service, signs its units and counts it as a voice turn', async () => {
    const sessionId = await newSession('maya', 'quietquad');
    const { call } = await startCall('maya', sessionId, 'typed');
    const before = await voiceTurns('maya');
    const { events, outcome } = await turn('maya', sessionId, {
      text: 'We did three library interviews. What should we ask next?',
      channel: 'voice',
      callId: call.id,
    });
    expect(outcome.status).toBe('completed');
    const units = unitsOf(events);
    expect(units.length).toBeGreaterThan(0);
    expect(units.map((u) => u.seq)).toEqual(units.map((_, i) => i));
    // Streamed: each unit is sent the moment it is validated, so none waits to be marked final.
    expect(units.at(0)?.final).toBe(false);
    // Signed by the turn engine, verified with the platform key the calls and speech services use.
    const verification = await keys.verificationKeys();
    for (const u of units) {
      expect(
        verifySpeechUnit(verification, { sessionId, turnId: u.turnId, seq: u.seq, text: u.text }, u.sig),
      ).toBe(true);
    }
    const turnId = outcome.turnId;
    if (turnId === null) throw new Error('expected a turn');
    const stored = await h.t.db.system((sx) =>
      sx.query('SELECT channel, call_id FROM turns WHERE id = :id', { id: p.uuid(turnId) }),
    );
    expect(stored.rows).toEqual([{ channel: 'voice', call_id: call.id }]);
    // The voice-turn rate limit counts it.
    expect(await voiceTurns('maya')).toBe(before + 1);
    // A unit as streamed is spoken through /speech, metered as speech.
    const [firstUnit] = units;
    if (firstUnit === undefined) throw new Error('expected a unit');
    const played = await speak(ctx.maya, {
      sessionId,
      turnId,
      seq: firstUnit.seq,
      text: firstUnit.text,
      sig: firstUnit.sig,
    });
    expect(speech.calls.at(-1)).toMatchObject({ text: speakableText(firstUnit.text) });
    const ledger = await h.t.db.system((sx) =>
      sx.query(
        `SELECT purpose, input_tokens FROM usage_ledger
         WHERE request_id = :rid AND model_id LIKE 'polly:%'`,
        { rid: p.text(ctx.maya.requestId) },
      ),
    );
    expect(ledger.rows).toContainEqual({ purpose: 'speech', input_tokens: played.characters });

    // Calls switched off: spoken turns are refused before any model call, typing goes on.
    await withSetting('calls_enabled', 'false', async () => {
      const modelCalls = h.gateway.calls.length;
      const refused = await turn('maya', sessionId, {
        text: 'And after that?',
        channel: 'voice',
        callId: call.id,
      });
      expect(refused.outcome).toMatchObject({
        status: 'rejected',
        turnId: null,
        error: { code: 'ai_disabled', reason: 'calls_disabled' },
      });
      expect(h.gateway.calls.length).toBe(modelCalls);
      expect((await turn('maya', sessionId, { text: 'And after that?' })).outcome.status).toBe('completed');
    });
    await endCall('maya', call.id);
    const ended = await turn('maya', sessionId, {
      text: 'One more thing.',
      channel: 'voice',
      callId: call.id,
    });
    expect(ended.outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict', reason: 'call_not_active' },
    });
  });

  it('replays to the model exactly the streamed units the founder heard before speaking over the vEIR', async () => {
    const sentences = [
      'Start with the library that already counts seats.',
      'Ask the staff for two weeks of hourly counts.',
      'Compare those counts with your own tally.',
      'Which librarian can you reach first?',
    ];
    const seen: (readonly ChatMessage[])[] = [];
    const gateway = new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: (context) => {
        seen.push(context.messages);
        return sentences.join(' ');
      },
    });
    const core = createCore({
      db: h.t.db,
      gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      logger: h.logger,
    });
    const sessionId = (await core.sessions.create(ctx.devin, ventureId('quietquad'), {})).id;
    const { call } = await core.calls.start(ctx.devin, sessionId, { inputMode: 'typed' });
    try {
      const events: TurnStreamEvent[] = [];
      const first = await core.orchestrator.runTurn(
        ctx.devin,
        sessionId,
        { text: 'Which library should we approach first?', channel: 'voice', callId: call.id },
        (e) => {
          events.push(TurnStreamEvent.parse(e));
        },
      );
      expect(first.status).toBe('completed');
      const turnId = first.turnId ?? '';
      const units = unitsOf(events);
      expect(units.map((u) => u.text).slice(0, 3)).toEqual(sentences.slice(0, 3));

      // The founder spoke over the vEIR during unit 1: the client sends back units 0…1 as it played them.
      const k = 1;
      const heard = units.slice(0, k + 1);
      await core.calls.interrupt(ctx.devin, turnId, {
        callId: call.id,
        heardSeq: k,
        heard: heard.map((u) => ({ seq: u.seq, text: u.text, sig: u.sig })),
      });
      const heardText = heard.map((u) => speakableText(u.text)).join(' ');
      const recorded = await h.t.db.system((sx) => callsRepo.listTurnInterruptions(sx, [turnId]));
      expect(recorded.get(turnId)).toMatchObject({ heardSeq: k, heardText });

      seen.length = 0;
      const next = await core.orchestrator.runTurn(
        ctx.devin,
        sessionId,
        { text: 'So what do we do on Monday?', channel: 'voice', callId: call.id },
        () => undefined,
      );
      expect(next.status).toBe('completed');
      const history = seen[0];
      if (history === undefined) throw new Error('expected the answer call');
      const { opener } = (await core.sessions.get(ctx.devin, sessionId)).session;
      expect(history.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
        ...(opener === null ? [] : [opener]),
        heardText,
      ]);
      const asked = history.map((m) => m.content).join('\n');
      expect(asked).not.toContain(sentences[2]);
      expect(asked).not.toContain(sentences[3]);
    } finally {
      await core.calls.end(ctx.devin, call.id, { reason: 'user' });
    }
  });

  it('keeps a spoken turn the founder interrupted before it settled, and replays what they heard of it', async () => {
    const sentences = [
      'Start with the library that already counts seats.',
      'Ask the staff for two weeks of hourly counts.',
      'Compare those counts with your own tally.',
      'Then book a call with the head librarian.',
      'Bring the comparison to that call.',
      'Which librarian can you reach first?',
    ];
    const seen: (readonly ChatMessage[])[] = [];
    // The first reply opens differently: a reply never says what the founder already heard again (the repeat guard).
    let replies = 0;
    const gateway = new MockModelGateway({
      streamDelayMs: 30,
      streamFixture: (context) => {
        seen.push(context.messages);
        replies += 1;
        return replies === 1 ? `First things first. ${sentences.join(' ')}` : sentences.join(' ');
      },
    });
    const core = createCore({
      db: h.t.db,
      gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      logger: h.logger,
    });
    const stored = (turnId: string) =>
      h.t.db.system(async (sx) => {
        const r = await sx.query(
          `SELECT status, founder_text, response ->> 'answer' AS answer,
                  coalesce((validator_results -> 'notes') @> '["interrupted"]'::jsonb, false) AS interrupted
           FROM turns WHERE id = :id`,
          { id: p.uuid(turnId) },
        );
        return r.rows[0];
      });
    /** A spoken turn whose request is cancelled (the client's barge-in) when `cut` says so. */
    const interrupted = async (
      sessionId: string,
      callId: string,
      text: string,
      cut: (event: TurnStreamEvent, events: readonly TurnStreamEvent[]) => boolean,
      channel: 'voice' | 'text' = 'voice',
    ) => {
      const barge = new AbortController();
      const events: TurnStreamEvent[] = [];
      let unitsAtCut = 0;
      const outcome = await core.orchestrator.runTurn(
        ctx.devin,
        sessionId,
        { text, channel, ...(channel === 'voice' ? { callId } : {}) },
        (e) => {
          const event = TurnStreamEvent.parse(e);
          events.push(event);
          if (!barge.signal.aborted && cut(event, events)) {
            barge.abort();
            unitsAtCut = unitsOf(events).length;
          }
        },
        { signal: barge.signal },
      );
      // Nothing more is said once the founder spoke over the vEIR.
      expect(unitsOf(events)).toHaveLength(unitsAtCut);
      return { outcome, events, units: unitsOf(events) };
    };
    const sessionId = (await core.sessions.create(ctx.devin, ventureId('quietquad'), {})).id;
    const { call } = await core.calls.start(ctx.devin, sessionId, { inputMode: 'typed' });
    try {
      // The founder speaks over the first unit while the reply is still streaming.
      const early = await interrupted(
        sessionId,
        call.id,
        'Which library should we approach first?',
        (e) => e.event === 'turn.speech',
      );
      expect(early.outcome.status).toBe('completed');
      const earlyId = early.outcome.turnId ?? '';
      const [heard] = early.units;
      if (heard === undefined) throw new Error('expected a unit');
      expect(await stored(earlyId)).toMatchObject({
        status: 'completed',
        founder_text: 'Which library should we approach first?',
        interrupted: true,
      });
      // The client records what was heard, as calls.md prescribes (stop audio, abort, interrupt).
      await core.calls.interrupt(ctx.devin, earlyId, {
        callId: call.id,
        heardSeq: 0,
        heard: [{ seq: heard.seq, text: heard.text, sig: heard.sig }],
      });

      // … and over the last unit, once the reply was written but before its annotations.
      const late = await interrupted(
        sessionId,
        call.id,
        'And after the counts?',
        (_e, events) => events.filter((x) => x.event === 'turn.delta').length === sentences.length,
      );
      expect(late.outcome.status).toBe('completed');
      expect(await stored(late.outcome.turnId ?? '')).toMatchObject({
        status: 'completed',
        answer: sentences.join(' '),
        interrupted: true,
      });

      // The next reply's model call sees both questions, and of the first reply only what was heard.
      seen.length = 0;
      const next = await core.orchestrator.runTurn(
        ctx.devin,
        sessionId,
        { text: 'So what do we do on Monday?', channel: 'voice', callId: call.id },
        () => undefined,
      );
      expect(next.status).toBe('completed');
      const history = seen[0];
      if (history === undefined) throw new Error('expected the answer call');
      const asked = history.map((m) => m.content).join('\n');
      expect(asked).toContain('Which library should we approach first?');
      expect(asked).toContain('And after the counts?');
      const { opener } = (await core.sessions.get(ctx.devin, sessionId)).session;
      expect(history.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
        ...(opener === null ? [] : [opener]),
        speakableText(heard.text),
        sentences.join(' '),
      ]);

      // Cancelled before a word was spoken, or a typed message cancelled: the turn failed, as before.
      const silent = await interrupted(
        sessionId,
        call.id,
        'Wait, one more thing first.',
        (e) => e.event === 'turn.delta',
      );
      expect(silent.units).toHaveLength(0);
      expect(silent.outcome.status).toBe('failed');
      const typed = await interrupted(
        sessionId,
        call.id,
        'Never mind that.',
        (e) => e.event === 'turn.delta',
        'text',
      );
      expect(typed.outcome.status).toBe('failed');
    } finally {
      await core.calls.end(ctx.devin, call.id, { reason: 'user' });
    }
  });

  it('plays the crisis support unit the turn engine streamed, whatever the switches and budgets', async () => {
    const sessionId = await newSession('maya', 'quietquad');
    const { call } = await startCall('maya', sessionId, 'typed');
    const overAll = <T>(fn: () => Promise<T>): Promise<T> =>
      withOverspend('maya', () =>
        withSetting('ai_enabled', 'false', () => withSetting('calls_enabled', 'false', fn)),
      );
    try {
      const { events, outcome } = await overAll(() =>
        turn('maya', sessionId, {
          text: 'I want to kill myself tonight.',
          channel: 'voice',
          callId: call.id,
        }),
      );
      expect(outcome.status).toBe('blocked');
      // One unit, the fixed support message, final, sent just before the blocked panel.
      const [unit, blocked] = events.slice(-2);
      if (unit?.event !== 'turn.speech' || blocked?.event !== 'turn.blocked') {
        throw new Error('expected the support unit, then the blocked turn');
      }
      expect(unitsOf(events)).toHaveLength(1);
      expect(unit).toMatchObject({
        seq: 0,
        text: CRISIS_SPOKEN_MESSAGE,
        final: true,
        turnId: blocked.turnId,
      });
      expect(blocked.reason).toBe('crisis_support');
      // That exact unit, as the client sends it to /speech, is spoken in the call's voice.
      const request = { sessionId, turnId: unit.turnId, seq: unit.seq, text: unit.text, sig: unit.sig };
      const played = await overAll(() => speak(ctx.maya, request));
      expect(played.characters).toBe(CRISIS_SPOKEN_MESSAGE.length);
      expect(speech.calls.at(-1)).toMatchObject({
        text: CRISIS_SPOKEN_MESSAGE,
        voiceId: (await callRow(call.id)).voiceId,
      });
    } finally {
      await endCall('maya', call.id);
    }
  });

  it('opens a call with the line that is true when it starts, keeps it as the conversation’s opener, and none in a temporary chat', async () => {
    const quietquad = ventureId('quietquad');
    const editOpener = async (text: string) => {
      const notebook = await h.core.notebook.get(ctx.maya, quietquad);
      await h.core.notebook.update(ctx.maya, quietquad, {
        expectedVersion: notebook.version,
        edit: { action: 'edit_opener', text },
      });
    };
    const stored = 'Last time you planned five library-staff interviews. How did they go?';
    await editOpener(stored);
    const session = await h.core.sessions.create(ctx.maya, quietquad, {});
    expect(session.opener).toBe(stored);
    // A line written since the conversation was created (nothing was said in it yet): the call opens with it.
    const since = 'What did the second library say about the seat counts?';
    await editOpener(since);
    const started = await startCall('maya', session.id, 'typed');
    const intro = started.intro;
    if (intro === null) throw new Error('expected an intro');
    expect(intro.text).toBe('Hi Maya, what did the second library say about the seat counts?');
    // What the vEIR believes it opened with (its first history message) is what the call said.
    expect((await h.core.sessions.get(ctx.maya, session.id)).session.opener).toBe(intro.text);
    expect(
      verifySpeechUnit(
        await keys.verificationKeys(),
        { sessionId: session.id, turnId: null, seq: 0, text: intro.text },
        intro.sig,
      ),
    ).toBe(true);
    await endCall('maya', started.call.id);

    const temporary = await h.core.sessions.create(ctx.maya, quietquad, { privacy: 'ephemeral' });
    expect(temporary.opener).toBeNull();
    const call = await startCall('maya', temporary.id, 'typed');
    expect(call.intro?.text).toBe('Hi Maya, what would you like to work on?');
    await endCall('maya', call.call.id);
  });

  it('daily maintenance closes calls whose client went away, without moving their minutes', async () => {
    const sessionId = await newSession('devin', 'quietquad');
    const { call } = await startCall('devin', sessionId, 'typed');
    await backdate(call.id, 10, 5);
    const minutes = () =>
      h.t.db.system((sx) =>
        callsRepo.callSecondsToday(sx, {
          principalId: h.people.devin,
          graceSeconds: CALL_LIMITS.staleSeconds,
        }),
      );
    const before = await minutes();
    const report = await h.core.maintenance.runDaily({ requestId: 'maintenance-stale-calls' });
    expect(report.staleCallsEnded).toBeGreaterThanOrEqual(1);
    expect(await callRow(call.id)).toMatchObject({
      status: 'ended',
      endReason: 'timeout',
      endDetail: 'stale_heartbeat',
    });
    expect(await minutes()).toBe(before);
    expect(await auditActions()).toContain('maintenance.stale_calls');
  });

  it('charges every second a call could be used, so a client that never heartbeats gets no extra minutes', async () => {
    const sessionId = await newSession('amara', 'solesignal');
    const minutes = () =>
      h.t.db.system((sx) =>
        callsRepo.callSecondsToday(sx, {
          principalId: h.people.amara,
          graceSeconds: CALL_LIMITS.staleSeconds,
        }),
      );
    const admit = (callId: string) =>
      kit.inRequest(ctx.amara, (scope) => admitVoiceTurn(scope, { sessionId, callId, now: new Date() }));
    // Never a heartbeat: a minute after the start the call still takes spoken turns …
    const { call } = await startCall('amara', sessionId, 'typed');
    await backdateSeconds(call.id, CALL_LIMITS.staleSeconds, null);
    await admit(call.id);
    // … and a second later it is over: closed at the next start, charged the whole minute it was usable.
    await backdateSeconds(call.id, CALL_LIMITS.staleSeconds + 1, null);
    const next = await startCall('amara', sessionId, 'typed');
    expect(await callRow(call.id)).toMatchObject({
      status: 'ended',
      endDetail: 'stale_heartbeat',
      elapsedSeconds: CALL_LIMITS.staleSeconds,
    });
    await endCall('amara', next.call.id);
    // The same when daily maintenance closes it, and the minutes do not move when it does.
    const reaped = await startCall('amara', sessionId, 'typed');
    await backdateSeconds(reaped.call.id, 5 * 60, null);
    const before = await minutes();
    await h.core.maintenance.runDaily({ requestId: 'maintenance-unheartbeated-call' });
    expect(await callRow(reaped.call.id)).toMatchObject({
      status: 'ended',
      endDetail: 'stale_heartbeat',
      elapsedSeconds: CALL_LIMITS.staleSeconds,
    });
    expect(await minutes()).toBe(before);
  });
});

describe('spend caps on a call', () => {
  /** Runs `fn` while `person` has spent `usd` today on `purpose` (removed afterwards). */
  async function withSpend<T>(
    person: Person,
    purpose: 'speech' | 'turn',
    usd: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    await h.t.db.system((sx) =>
      usageRepo.recordUsage(sx, {
        tenantId: h.seed.tenantId,
        principalId: h.people[person],
        purpose,
        modelId: 'test-spend',
        inputTokens: 1,
        outputTokens: 0,
        costUsd: usd,
      }),
    );
    try {
      return await fn();
    } finally {
      await h.t.db.system((sx) =>
        sx.query(`DELETE FROM usage_ledger WHERE model_id = 'test-spend' AND principal_id = :p`, {
          p: p.uuid(h.people[person]),
        }),
      );
    }
  }

  it('leaves speech out of the per-person AI cap, so a call outlives it; model spend and the platform cap still count', async () => {
    const sessionId = await newSession('maya', 'quietquad');
    const { call } = await startCall('maya', sessionId, 'typed');
    try {
      // $5 of speech today (Polly and Transcribe): five times the $1 per-person cap, under the $15 platform cap.
      await withSpend('maya', 'speech', 5, async () => {
        expect(await beat('maya', call.id)).toMatchObject({ action: 'continue' });
        const events = await send('maya', sessionId, call.id, 'What should we ask the librarians first?');
        expect(events.at(-1)?.event).toBe('turn.completed');
        const unit = events.find((e) => e.event === 'turn.speech');
        if (unit?.event !== 'turn.speech') throw new Error('expected a speech unit');
        await speak(ctx.maya, {
          sessionId,
          turnId: unit.turnId,
          seq: unit.seq,
          text: unit.text,
          sig: unit.sig,
        });
      });
      // $5 of model spend is the founder's AI budget: the next heartbeat ends the call on it.
      await withSpend('maya', 'turn', 5, async () => {
        expect(await beat('maya', call.id)).toMatchObject({ action: 'terminate', reason: 'budget' });
      });
    } finally {
      await endCall('maya', call.id);
    }
    // The platform cap counts every purpose: $20 of anyone's speech stops new calls.
    const next = await newSession('maya', 'quietquad');
    await withSpend('devin', 'speech', 20, async () => {
      await expect(h.core.calls.start(ctx.maya, next, { inputMode: 'typed' })).rejects.toMatchObject({
        code: 'spend_cap_reached',
        reason: 'global_daily_cap',
      });
    });
  });
});
