/**
 * The vEIR's digital twin on calls (docs/architecture/calls.md §4, docs/runbooks/avatars.md), through the core
 * services with fake vendors behind the `EmbodimentProvider` and `VoiceProvider` ports:
 *
 * - faces are off by default; with them on, a face opens once per live call of the caller, within the per-call
 *   and monthly video minutes, and a real likeness only when the persona's face is ready under likeness consent;
 * - the face renders only audio the server synthesized from a signed unit of that call (the face-audio manifest),
 *   once, never the crisis line, and the cloned voice synthesizes only verified units;
 * - withdrawing likeness ends the face at once, withdrawing voice falls back to the platform voice mid-call;
 * - face seconds and clone characters are metered into the usage ledger at the vendors' prices, exactly once;
 * - tokens and the control channel are never recorded.
 */
import { CRISIS_SPOKEN_MESSAGE } from '@foundry/ai';
import {
  AvatarSessionResponse,
  CallConfigResponse,
  CallHeartbeatResponse,
  StartCallResponse,
  TurnStreamEvent,
} from '@foundry/contracts';
import { p, twinRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformKeyCache } from '../auth/keys.js';
import { type RequestContext } from '../context.js';
import { type Core } from '../core.js';
import { resolveDeps } from '../deps.js';
import { Kit } from '../internal/kit.js';
import { FACE_CHUNK_BYTES } from '../orchestrator/face-audio.js';
import { signSpeechUnit } from '../orchestrator/speech-units.js';
import { type SynthesizedSpeech } from '../ports.js';
import { FakeEmbodimentProvider, FakeSpeechSynthesizer, FakeVoiceProvider } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { MIN_FACE_SECONDS } from './face.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

let h: CoreHarness;
let keys: PlatformKeyCache;
const polly = new FakeSpeechSynthesizer();
const standIn = new FakeEmbodimentProvider('fake', false, 0);
const vendorFace = new FakeEmbodimentProvider('heygen', true, 0.093);
const clone = new FakeVoiceProvider('elevenlabs', 0.04);
/** The stand-in face, no cloned voice. */
let local: Core;
/** A real likeness (HeyGen-like) and the cloned voice. */
let vendor: Core;
type Person = 'maya' | 'devin' | 'lead';
const ctx = {} as Record<Person, RequestContext>;

const quietquad = (): string => h.ventures.quietquad.id;
const corinPersona = (): string => h.ventures.quietquad.personaId;

async function setting(key: string, value: string): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(
      `INSERT INTO platform_settings (key, value) VALUES (:k, :v::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      { k: p.text(key), v: p.text(value) },
    ),
  );
}

async function startCall(core: Core, who: Person = 'maya') {
  const sessionId = (await core.sessions.create(ctx[who], quietquad(), {})).id;
  return StartCallResponse.parse(await core.calls.start(ctx[who], sessionId, { inputMode: 'typed' }));
}

async function faceSession(core: Core, callId?: string, who: Person = 'maya') {
  return AvatarSessionResponse.parse(
    await core.veir.avatarSession(ctx[who], { ventureId: quietquad(), ...(callId ? { callId } : {}) }),
  );
}

async function beat(core: Core, callId: string, face?: 'live' | 'off') {
  return CallHeartbeatResponse.parse(
    await core.calls.heartbeat(ctx.maya, callId, {
      state: 'listening',
      micOpenSeconds: 0,
      ...(face ? { face } : {}),
    }),
  );
}

/** Speech as the route serves it: the audio read to its end (when its bookkeeping is done). */
async function speak(core: Core, input: Parameters<Core['speech']['synthesize']>[1]) {
  const spoken: SynthesizedSpeech = await core.speech.synthesize(ctx.maya, input);
  return { ...spoken, bytes: new Uint8Array(await new Response(spoken.audio).arrayBuffer()) };
}

/** The signed `turn.speech` units of a spoken turn sent on the call (the real turn engine signs them). */
async function spokenUnits(core: Core, sessionId: string, callId: string, text: string) {
  const units: { turnId: string; seq: number; text: string; sig: string }[] = [];
  await core.orchestrator.runTurn(ctx.maya, sessionId, { text, channel: 'voice', callId }, (e) => {
    const event = TurnStreamEvent.parse(e);
    if (event.event === 'turn.speech') {
      units.push({ turnId: event.turnId, seq: event.seq, text: event.text, sig: event.sig });
    }
  });
  return units;
}

async function lastAudit(action: string) {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT outcome, policy_reason, object_id, metadata::text AS metadata FROM audit_events
       WHERE action = :action ORDER BY id DESC LIMIT 1`,
      { action: p.text(action) },
    ),
  );
  const row = rows.rows[0];
  if (!row) throw new Error(`no ${action} audit`);
  return { ...row, raw: JSON.stringify(row) };
}

async function usage(modelId: string): Promise<{ n: number; units: number; cost: number }> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT count(*)::int AS n, coalesce(sum(input_tokens), 0)::int AS units,
              coalesce(sum(cost_usd), 0)::float8 AS cost
         FROM usage_ledger WHERE model_id = :m AND purpose = 'speech'`,
      { m: p.text(modelId) },
    ),
  );
  return { n: Number(r.rows[0]?.n), units: Number(r.rows[0]?.units), cost: Number(r.rows[0]?.cost) };
}

/** Moves a call's face start back (owner role), as if it had been showing for `seconds`. */
async function ageFace(callId: string, seconds: number): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(`UPDATE call_faces SET started_at = now() - make_interval(secs => :s) WHERE call_id = :id`, {
      id: p.uuid(callId),
      s: p.int(seconds),
    }),
  );
}

beforeAll(async () => {
  h = await createCoreHarness({ speech: polly });
  local = h.withPorts({ speech: polly, embodiment: standIn });
  vendor = h.withPorts({ speech: polly, embodiment: vendorFace, clonedVoice: clone });
  keys = new PlatformKeyCache(
    new Kit(
      resolveDeps({
        db: h.t.db,
        gateway: h.gateway,
        config: h.config,
        objectStore: h.objectStore,
        jobQueue: h.jobQueue,
      }),
    ),
    3600,
  );
  ctx.maya = await h.ctxFor(h.people.maya);
  ctx.devin = await h.ctxFor(h.people.devin);
  ctx.lead = await h.ctxFor(h.people.lead);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('the face of a call: off by default, then the stand-in', () => {
  it('names no face and keeps the presence while faces are off (the default)', async () => {
    const config = CallConfigResponse.parse(await local.veir.callConfig(ctx.maya, quietquad()));
    expect(config.provider).toBe('builtin');
    expect(config.faceMinutesLeft).toBeUndefined();
    const started = await startCall(local);
    const before = standIn.sessions.length;
    expect(await faceSession(local, started.call.id)).toMatchObject({
      provider: 'builtin',
      token: null,
      voicing: 'engine',
      url: null,
    });
    expect(standIn.sessions.length).toBe(before);
    expect(await lastAudit('call.avatar_session')).toMatchObject({
      outcome: 'denied',
      policy_reason: 'faces_disabled',
    });
    // A heartbeat of a call without a face says nothing about one.
    expect((await beat(local, started.call.id)).face).toBeUndefined();
    await local.calls.end(ctx.maya, started.call.id, { reason: 'user' });
  });

  it('opens the stand-in once per live call of the caller, within the per-call limit, never recording the token', async () => {
    await setting('faces_enabled', 'true');
    const config = CallConfigResponse.parse(await local.veir.callConfig(ctx.maya, quietquad()));
    expect(config).toMatchObject({ provider: 'fake', faceMinutesLeft: 60 });
    // No call named: the presence, no vendor round trip.
    expect(await faceSession(local)).toMatchObject({ provider: 'builtin', token: null });

    const started = await startCall(local);
    const callId = started.call.id;
    const minted = await faceSession(local, callId);
    expect(minted).toMatchObject({ provider: 'fake', voicing: 'audio', url: null });
    expect(minted.token).toMatch(/^fake\.session-\d+$/);
    // The vendor session ends by itself at the per-call video limit (20 minutes, inside a 30-minute call).
    expect(standIn.sessions.at(-1)).toMatchObject({ callId, avatarRef: null, maxSeconds: 20 * 60 });
    const audited = await lastAudit('call.avatar_session');
    expect(audited).toMatchObject({ outcome: 'succeeded', object_id: callId });
    expect(audited.raw).not.toContain(minted.token ?? 'never');

    // One face per call: asking again (a dropped face, a second tab) opens nothing more.
    const sessions = standIn.sessions.length;
    expect(await faceSession(local, callId)).toMatchObject({ provider: 'builtin', token: null });
    expect(standIn.sessions.length).toBe(sessions);
    expect(await lastAudit('call.avatar_session')).toMatchObject({ policy_reason: 'face_already_used' });
    // Nobody else opens a face on this call.
    await expect(faceSession(local, callId, 'devin')).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_not_active',
    });

    // The heartbeat keeps a face that may go on; ending the call ends it at the vendor.
    expect((await beat(local, callId, 'live')).face).toBe('continue');
    await local.calls.end(ctx.maya, callId, { reason: 'user' });
    expect(standIn.ended.at(-1)).toMatchObject({
      reason: 'call_ended',
      handle: { sessionRef: `sess-${String(sessions)}` },
    });
    const row = await h.t.db.system((sx) => twinRepo.getCallFace(sx, callId));
    expect(row).toMatchObject({ endReason: 'call_ended', control: null });
    await expect(faceSession(local, callId)).rejects.toMatchObject({ reason: 'call_not_active' });
  });

  it('offers a vendor sandbox face to platform admins only (never a stock avatar to founders)', async () => {
    const sandboxFace = new FakeEmbodimentProvider('fake', false, 0);
    sandboxFace.sandbox = true;
    const sandboxed = h.withPorts({ speech: polly, embodiment: sandboxFace });
    expect(CallConfigResponse.parse(await sandboxed.veir.callConfig(ctx.maya, quietquad())).provider).toBe(
      'builtin',
    );
    const started = await startCall(sandboxed);
    try {
      expect(await faceSession(sandboxed, started.call.id)).toMatchObject({
        provider: 'builtin',
        token: null,
      });
      expect(sandboxFace.sessions).toHaveLength(0);
      expect(await lastAudit('call.avatar_session')).toMatchObject({
        outcome: 'denied',
        policy_reason: 'sandbox_only',
      });
    } finally {
      await sandboxed.calls.end(ctx.maya, started.call.id, { reason: 'user' });
    }
    // The owner running the first live checks, on a venture they belong to.
    await h.t.db.system((sx) =>
      sx.query(`INSERT INTO role_grants (principal_id, role) VALUES (:p, 'platform_admin')`, {
        p: p.uuid(h.people.maya),
      }),
    );
    try {
      const admin = await h.ctxFor(h.people.maya);
      expect(CallConfigResponse.parse(await sandboxed.veir.callConfig(admin, quietquad())).provider).toBe(
        'fake',
      );
      const sessionId = (await sandboxed.sessions.create(admin, quietquad(), {})).id;
      const call = StartCallResponse.parse(
        await sandboxed.calls.start(admin, sessionId, { inputMode: 'typed' }),
      ).call;
      const minted = AvatarSessionResponse.parse(
        await sandboxed.veir.avatarSession(admin, { ventureId: quietquad(), callId: call.id }),
      );
      expect(minted).toMatchObject({ provider: 'fake', token: 'fake.session-1' });
      await sandboxed.calls.end(admin, call.id, { reason: 'user' });
    } finally {
      await h.t.db.system((sx) =>
        sx.query(
          `UPDATE role_grants SET revoked_at = now() WHERE principal_id = :p AND role = 'platform_admin'`,
          {
            p: p.uuid(h.people.maya),
          },
        ),
      );
    }
  });

  it('keeps the presence when the vendor is down or the call is about to end', async () => {
    const started = await startCall(local);
    try {
      standIn.failNext = true;
      expect(await faceSession(local, started.call.id)).toMatchObject({ provider: 'builtin', token: null });
      expect(await lastAudit('call.avatar_session')).toMatchObject({
        outcome: 'failed',
        policy_reason: 'vendor_unavailable',
      });
    } finally {
      await local.calls.end(ctx.maya, started.call.id, { reason: 'user' });
    }
    const late = await startCall(local);
    try {
      await h.t.db.system(async (sx) => {
        await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
        await sx.query(
          `UPDATE calls SET started_at = now() - make_interval(secs => :s), last_heartbeat_at = now() WHERE id = :id`,
          { id: p.uuid(late.call.id), s: p.int(30 * 60 - (MIN_FACE_SECONDS - 5)) },
        );
        await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
      });
      const before = standIn.sessions.length;
      expect(await faceSession(local, late.call.id)).toMatchObject({ provider: 'builtin', token: null });
      expect(standIn.sessions.length).toBe(before);
      expect(await lastAudit('call.avatar_session')).toMatchObject({ policy_reason: 'too_short' });
    } finally {
      await local.calls.end(ctx.maya, late.call.id, { reason: 'user' });
    }
  });

  it('meters a face from the server’s clock into the ledger, once, and stops it at the month’s minutes', async () => {
    const started = await startCall(local);
    const callId = started.call.id;
    await faceSession(local, callId);
    await ageFace(callId, 90);
    expect((await beat(local, callId, 'live')).face).toBe('continue');
    const first = await usage('fake:face');
    expect(first.units).toBeGreaterThanOrEqual(90);
    // A second beat right after adds (almost) nothing: nothing is metered twice.
    await beat(local, callId, 'live');
    expect((await usage('fake:face')).units - first.units).toBeLessThanOrEqual(2);
    // The month's video minutes used up: the face stops, the call goes on.
    await setting('face_minutes_per_principal_month', '1');
    try {
      const stopped = await beat(local, callId, 'live');
      expect(stopped).toMatchObject({ action: 'continue', face: 'stop' });
      expect(standIn.ended.at(-1)?.reason).toBe('face_stopped');
      expect(await lastAudit('call.face_ended')).toMatchObject({ policy_reason: 'face_minutes' });
      expect((await beat(local, callId)).face).toBeUndefined();
    } finally {
      await setting('face_minutes_per_principal_month', '60');
      await local.calls.end(ctx.maya, callId, { reason: 'user' });
    }
  });

  it('bills the seconds since the last heartbeat when the call ends: the ledger holds the face’s seconds', async () => {
    const before = await usage('fake:face');
    const started = await startCall(local);
    const callId = started.call.id;
    await faceSession(local, callId);
    await ageFace(callId, 90);
    expect((await beat(local, callId, 'live')).face).toBe('continue');
    await ageFace(callId, 300);
    await local.calls.end(ctx.maya, callId, { reason: 'user' });
    const face = await h.t.db.system((sx) => twinRepo.getCallFace(sx, callId));
    expect(face?.meteredSeconds).toBeGreaterThanOrEqual(300);
    expect((await usage('fake:face')).units - before.units).toBe(face?.meteredSeconds);
  });

  it('bills the face of a call the daily maintenance closed, once', async () => {
    const before = await usage('fake:face');
    const started = await startCall(local);
    const callId = started.call.id;
    await faceSession(local, callId);
    await ageFace(callId, 240);
    // The browser went away 200 s ago: no heartbeat since.
    await h.t.db.system(async (sx) => {
      await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
      await sx.query(
        `UPDATE calls SET started_at = now() - interval '240 seconds',
                          last_heartbeat_at = now() - interval '200 seconds' WHERE id = :id`,
        { id: p.uuid(callId) },
      );
      await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
    });
    await local.maintenance.runDaily({ requestId: 'maintenance-call-faces' });
    const face = await h.t.db.system((sx) => twinRepo.getCallFace(sx, callId));
    expect(face?.endReason).toBe('call_ended');
    // The reaper ends the call at its last heartbeat plus the stale window: 240 - 200 + 60 seconds of face.
    expect(face?.meteredSeconds).toBeGreaterThanOrEqual(99);
    expect(face?.meteredSeconds).toBeLessThanOrEqual(102);
    expect((await usage('fake:face')).units - before.units).toBe(face?.meteredSeconds);
    await local.maintenance.runDaily({ requestId: 'maintenance-call-faces-again' });
    expect((await usage('fake:face')).units - before.units).toBe(face?.meteredSeconds);
  });

  it('ends a face at its per-call limit, whatever the month still leaves', async () => {
    await setting('face_minutes_per_call', '1');
    const started = await startCall(local);
    try {
      await faceSession(local, started.call.id);
      expect(standIn.sessions.at(-1)?.maxSeconds).toBe(60);
      await ageFace(started.call.id, 30);
      expect((await beat(local, started.call.id, 'live')).face).toBe('continue');
      await ageFace(started.call.id, 75);
      expect(await beat(local, started.call.id, 'live')).toMatchObject({ action: 'continue', face: 'stop' });
      expect(standIn.ended.at(-1)?.reason).toBe('face_stopped');
      expect(await lastAudit('call.face_ended')).toMatchObject({ policy_reason: 'face_limit' });
    } finally {
      await setting('face_minutes_per_call', '20');
      await local.calls.end(ctx.maya, started.call.id, { reason: 'user' });
    }
  });

  it('stops the face when the month’s video minutes cannot be read, never waving it through', async () => {
    let monthFails = false;
    const flaky = h.withPorts(
      { speech: polly, embodiment: standIn },
      {
        db: (db) => ({
          driver: db.driver,
          withContext: (c, fn) => db.withContext(c, fn),
          ping: (o) => db.ping(o),
          close: () => db.close(),
          system: (fn, o) =>
            db.system(
              (sx) =>
                fn({
                  ...sx,
                  query: (sql, params) =>
                    monthFails && sql.includes("date_trunc('month'")
                      ? Promise.reject(new Error('statement timeout'))
                      : sx.query(sql, params),
                }),
              o,
            ),
        }),
      },
    );
    const started = await startCall(flaky);
    try {
      await faceSession(flaky, started.call.id);
      expect((await beat(flaky, started.call.id, 'live')).face).toBe('continue');
      monthFails = true;
      expect(await beat(flaky, started.call.id, 'live')).toMatchObject({ action: 'continue', face: 'stop' });
      expect(standIn.ended.at(-1)?.reason).toBe('face_stopped');
      expect(await lastAudit('call.face_ended')).toMatchObject({ policy_reason: 'face_check_failed' });
    } finally {
      monthFails = false;
      await flaky.calls.end(ctx.maya, started.call.id, { reason: 'user' });
    }
  });

  it('asks the vendor to stop a session again when the first stop fails', async () => {
    const started = await startCall(local);
    await faceSession(local, started.call.id);
    const ended = standIn.ended.length;
    standIn.failEnds = 1;
    await local.calls.end(ctx.maya, started.call.id, { reason: 'user' });
    expect(standIn.ended.length).toBe(ended + 2);
    expect(standIn.ended.at(-1)?.reason).toBe('call_ended');
    expect(standIn.failEnds).toBe(0);
  });

  it('ends a face the browser stopped showing, so it stops billing', async () => {
    const started = await startCall(local);
    await faceSession(local, started.call.id);
    expect((await beat(local, started.call.id, 'off')).face).toBe('stop');
    expect(standIn.ended.at(-1)?.reason).toBe('face_dropped');
    await local.calls.end(ctx.maya, started.call.id, { reason: 'user' });
  });

  it('takes each part of a unit once, in order, one unit at a time, and nothing of it after barge-in', async () => {
    const started = await startCall(local);
    const callId = started.call.id;
    const sessionId = started.call.sessionId;
    const intro = started.intro;
    if (intro === null) throw new Error('no intro');
    try {
      await faceSession(local, callId);
      const spoken = await speak(local, {
        sessionId,
        turnId: null,
        seq: 0,
        text: intro.text,
        sig: intro.sig,
      });
      const manifest = spoken.faceManifest ?? '';
      const pcm = spoken.bytes.subarray(44);
      expect(Math.ceil(pcm.length / FACE_CHUNK_BYTES)).toBeGreaterThanOrEqual(4);
      /** One second of the intro, as its own part. */
      const second = (i: number) =>
        pcm.subarray(i * FACE_CHUNK_BYTES, Math.min(pcm.length, (i + 1) * FACE_CHUNK_BYTES));
      const hand = (i: number) =>
        local.face.speak(ctx.maya, callId, { manifest, firstChunk: i, pcm: second(i) });
      const refused = async (i: number, reason: string) => {
        await expect(hand(i)).rejects.toMatchObject({ code: 'validation_failed' });
        expect(await lastAudit('call.face_refused')).toMatchObject({ policy_reason: reason });
      };
      const shown = standIn.spoken.length;

      // Every part passes the manifest on its own; the server still takes them only in order, once each.
      await refused(1, 'part_out_of_order');
      await hand(0);
      await refused(2, 'part_out_of_order');
      await hand(1);
      await refused(1, 'part_out_of_order');
      await refused(0, 'already_shown');
      expect(standIn.spoken.length).toBe(shown + 2);
      expect(standIn.spoken.slice(shown).map((s) => s.audio.pcm.byteLength)).toEqual([
        FACE_CHUNK_BYTES,
        FACE_CHUNK_BYTES,
      ]);

      // Another unit starts: the rest of the intro can no longer be spliced in after it.
      const units = await spokenUnits(
        local,
        sessionId,
        callId,
        'What should I test first with ten customers?',
      );
      const unit = units.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      const other = await speak(local, {
        sessionId,
        turnId: unit.turnId,
        seq: unit.seq,
        text: unit.text,
        sig: unit.sig,
      });
      const otherPcm = other.bytes.subarray(44);
      expect(Math.ceil(otherPcm.length / FACE_CHUNK_BYTES)).toBeGreaterThanOrEqual(2);
      await local.face.speak(ctx.maya, callId, {
        manifest: other.faceManifest ?? '',
        firstChunk: 0,
        pcm: otherPcm.subarray(0, FACE_CHUNK_BYTES),
      });
      await refused(2, 'part_out_of_order');

      // Barge-in: what the face was saying is over, so its next part is refused too.
      await local.face.interrupt(ctx.maya, callId);
      await expect(
        local.face.speak(ctx.maya, callId, {
          manifest: other.faceManifest ?? '',
          firstChunk: 1,
          pcm: otherPcm.subarray(FACE_CHUNK_BYTES, Math.min(otherPcm.length, 2 * FACE_CHUNK_BYTES)),
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(await lastAudit('call.face_refused')).toMatchObject({ policy_reason: 'part_out_of_order' });
      expect(standIn.spoken.length).toBe(shown + 3);
    } finally {
      await local.calls.end(ctx.maya, callId, { reason: 'user' });
    }
  });
});

describe('a real likeness and the cloned voice', () => {
  let callId: string;
  let sessionId: string;
  let intro: { text: string; sig: string } | null;

  it('needs the persona’s face ready under likeness consent', async () => {
    await setting('faces_enabled', 'true');
    // Corin's seeded consent covers voice but not likeness: no face.
    expect(CallConfigResponse.parse(await vendor.veir.callConfig(ctx.maya, quietquad())).provider).toBe(
      'builtin',
    );
    await expect(
      vendor.twin.setMedia(ctx.lead, corinPersona(), 'face', { vendorRef: 'avatar-1', status: 'ready' }),
    ).rejects.toMatchObject({ code: 'conflict', reason: 'likeness_consent_required' });
    // Corin is a fictional EIR: the program lead records the wider consent for them.
    await vendor.personas.recordConsent(ctx.lead, corinPersona(), {
      assetTypes: ['doctrine', 'style', 'voice', 'likeness', 'cases', 'first_person'],
    });
    const twin = await vendor.twin.setMedia(ctx.lead, corinPersona(), 'face', {
      vendorRef: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
      status: 'ready',
    });
    expect(twin).toMatchObject({ scopes: { likeness: true, voice: true }, face: { status: 'ready' } });
    await vendor.twin.setMedia(ctx.lead, corinPersona(), 'voice', {
      vendorRef: 'VoiceClone01',
      status: 'ready',
    });
    // A founder never reads the twin.
    await expect(vendor.twin.get(ctx.maya, corinPersona())).rejects.toMatchObject({ code: 'forbidden' });
    expect(CallConfigResponse.parse(await vendor.veir.callConfig(ctx.maya, quietquad())).provider).toBe(
      'heygen',
    );
  });

  it('opens the vendor face with the persona’s avatar, its control channel stored only encrypted', async () => {
    await setting('cloned_voice_enabled', 'true');
    const started = await startCall(vendor);
    callId = started.call.id;
    sessionId = started.call.sessionId;
    intro = started.intro;
    const minted = await faceSession(vendor, callId);
    expect(minted).toMatchObject({ provider: 'heygen', voicing: 'audio' });
    expect(minted.url).toMatch(/^wss:\/\/room-\d+\.test\.invalid$/);
    expect(vendorFace.sessions.at(-1)).toMatchObject({
      callId,
      avatarRef: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
    });
    const stored = await h.t.db.system((sx) =>
      sx.query(`SELECT encode(control_ciphertext, 'escape') AS c FROM call_faces WHERE call_id = :id`, {
        id: p.uuid(callId),
      }),
    );
    expect(String(stored.rows[0]?.c)).not.toContain('wss://');
    expect((await lastAudit('call.avatar_session')).raw).not.toContain('control');
  });

  it('speaks the intro with the cloned voice and hands the face exactly that audio, once', async () => {
    if (intro === null) throw new Error('no intro');
    const calls = clone.calls.length;
    const spoken = await speak(vendor, { sessionId, turnId: null, seq: 0, text: intro.text, sig: intro.sig });
    // The clone was handed the verified unit, as PCM for the face; the browser gets a WAV of it.
    expect(clone.calls.length).toBe(calls + 1);
    expect(clone.calls.at(-1)).toMatchObject({ voiceRef: 'VoiceClone01', format: 'pcm_24000' });
    expect(clone.calls.at(-1)?.unit).toMatchObject({ sig: intro.sig, turnId: null, seq: 0 });
    expect(spoken.contentType).toBe('audio/wav');
    expect(spoken.faceManifest).toMatch(/^fa1\./);
    const meteredClone = await usage('elevenlabs:test_model');
    expect(meteredClone).toMatchObject({ n: 1, units: intro.text.length });
    expect(meteredClone.cost).toBeCloseTo((intro.text.length / 1000) * 0.04, 8);

    const pcm = spoken.bytes.subarray(44);
    const part = pcm.subarray(0, Math.min(pcm.length, 18 * FACE_CHUNK_BYTES));
    const shown = vendorFace.spoken.length;
    await vendor.face.speak(ctx.maya, callId, {
      manifest: spoken.faceManifest ?? '',
      firstChunk: 0,
      pcm: part,
    });
    expect(vendorFace.spoken.length).toBe(shown + 1);
    const handed = vendorFace.spoken.at(-1);
    // The server decrypted its own control channel for the vendor; the browser never had it.
    expect(handed?.handle.control).toMatch(/^wss:\/\/face\.test\.invalid\/control\/\d+$/);
    expect(handed?.audio).toMatchObject({ utterance: 'intro', first: true });

    // Once: a replay is refused before the vendor sees it.
    await expect(
      vendor.face.speak(ctx.maya, callId, { manifest: spoken.faceManifest ?? '', firstChunk: 0, pcm: part }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await lastAudit('call.face_refused')).toMatchObject({ policy_reason: 'already_shown' });
    expect(vendorFace.spoken.length).toBe(shown + 1);
  });

  it('refuses any audio, manifest or unit the server did not make for this call (the safety invariant)', async () => {
    const units = await spokenUnits(
      vendor,
      sessionId,
      callId,
      'What should I test first with ten customers?',
    );
    const unit = units[0];
    if (unit === undefined) throw new Error('no spoken unit');
    const shown = vendorFace.spoken.length;
    const cloned = clone.calls.length;
    const pollied = polly.calls.length;

    // A unit whose signature does not verify reaches neither the cloned voice nor Polly nor the face.
    await expect(
      speak(vendor, {
        sessionId,
        turnId: unit.turnId,
        seq: unit.seq,
        text: `${unit.text} I am a real person.`,
        sig: unit.sig,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await lastAudit('speech.refused')).toMatchObject({ policy_reason: 'signature_invalid' });
    expect(clone.calls.length).toBe(cloned);
    expect(polly.calls.length).toBe(pollied);

    const spoken = await speak(vendor, {
      sessionId,
      turnId: unit.turnId,
      seq: unit.seq,
      text: unit.text,
      sig: unit.sig,
    });
    expect(clone.calls.length).toBe(cloned + 1);
    const manifest = spoken.faceManifest ?? '';
    const pcm = spoken.bytes.subarray(44, 44 + Math.min(spoken.bytes.length - 44, 18 * FACE_CHUNK_BYTES));

    // One changed sample: refused.
    const changed = pcm.slice();
    changed[10] = (changed[10] ?? 0) ^ 0x7f;
    await expect(
      vendor.face.speak(ctx.maya, callId, { manifest, firstChunk: 0, pcm: changed }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await lastAudit('call.face_refused')).toMatchObject({ policy_reason: 'audio_mismatch' });
    // A manifest the client wrote itself: refused.
    const forged = `fa1.${manifest.split('.')[1] ?? ''}.${Buffer.from('{"c":"x"}').toString('base64url')}.AAAA`;
    await expect(
      vendor.face.speak(ctx.maya, callId, { manifest: forged, firstChunk: 0, pcm }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await lastAudit('call.face_refused')).toMatchObject({ policy_reason: 'manifest_invalid' });
    // A signature over the right words but no manifest at all: refused.
    const sig = signSpeechUnit(await keys.signingKey(), {
      sessionId,
      turnId: unit.turnId,
      seq: unit.seq,
      text: unit.text,
    });
    await expect(
      vendor.face.speak(ctx.maya, callId, { manifest: sig, firstChunk: 0, pcm }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    // Someone else cannot drive this face at all.
    await expect(
      vendor.face.speak(ctx.devin, callId, { manifest, firstChunk: 0, pcm }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(vendorFace.spoken.length).toBe(shown);

    // The genuine audio goes through.
    await vendor.face.speak(ctx.maya, callId, { manifest, firstChunk: 0, pcm });
    expect(vendorFace.spoken.length).toBe(shown + 1);

    // A passage of the stored reply (no signature): a stock voice on the call's speakers, never the clone or the face.
    const clonedBefore = clone.calls.length;
    const run = await speak(vendor, { sessionId, turnId: unit.turnId, text: unit.text });
    expect(clone.calls.length).toBe(clonedBefore);
    expect(run.faceManifest).toBeUndefined();
    expect(run.contentType).toBe('audio/mpeg');
    expect(polly.calls.at(-1)?.format).toBe('mp3');
    // Barge-in reaches the face from the server.
    await vendor.face.interrupt(ctx.maya, callId);
    expect(vendorFace.interrupts.length).toBeGreaterThan(0);
  });

  it('never gives the crisis line to the cloned voice or the face', async () => {
    const events: TurnStreamEvent[] = [];
    await vendor.orchestrator.runTurn(
      ctx.maya,
      sessionId,
      { text: 'I want to end my life tonight.', channel: 'voice', callId },
      (e) => {
        events.push(TurnStreamEvent.parse(e));
      },
    );
    const blocked = events.find((e) => e.event === 'turn.blocked');
    if (blocked?.event !== 'turn.blocked') throw new Error('expected a blocked crisis turn');
    const cloned = clone.calls.length;
    const spoken = await speak(vendor, { sessionId, turnId: blocked.turnId, text: CRISIS_SPOKEN_MESSAGE });
    expect(clone.calls.length).toBe(cloned);
    expect(spoken.faceManifest).toBeUndefined();
    expect(spoken.contentType).toBe('audio/mpeg');
    expect(polly.calls.at(-1)?.voiceId).not.toBe('VoiceClone01');
  });

  it('speaks with the stock voice when the cloned voice fails, and leaves the clone alone for a while', async () => {
    const callVoice = String(
      (
        await h.t.db.system((sx) =>
          sx.query('SELECT voice_id FROM calls WHERE id = :id', { id: p.uuid(callId) }),
        )
      ).rows[0]?.voice_id,
    );
    const [first] = await spokenUnits(vendor, sessionId, callId, 'How should I price the first pilot?');
    if (first === undefined) throw new Error('no spoken unit');
    const cloned = clone.calls.length;
    const pollied = polly.calls.length;
    const billedClone = await usage('elevenlabs:test_model');
    clone.failNext = true;
    const spoken = await speak(vendor, {
      sessionId,
      turnId: first.turnId,
      seq: first.seq,
      text: first.text,
      sig: first.sig,
    });
    // The clone was tried once; the same verified unit was then spoken in the call's stock voice, face included.
    expect(clone.calls.length).toBe(cloned + 1);
    expect(polly.calls.length).toBe(pollied + 1);
    expect(polly.calls.at(-1)).toMatchObject({ voiceId: callVoice, format: 'pcm_16000' });
    expect(callVoice).not.toBe('VoiceClone01');
    expect(spoken.contentType).toBe('audio/wav');
    expect(spoken.faceManifest).toMatch(/^fa1\./);
    // Billed as the voice that spoke: no clone characters.
    expect(await usage('elevenlabs:test_model')).toEqual(billedClone);
    expect((await lastAudit('speech.synthesized')).raw).toContain(callVoice);

    // The next units skip the clone for a while instead of waiting on it again.
    const [next] = await spokenUnits(vendor, sessionId, callId, 'And what if they say no?');
    if (next === undefined) throw new Error('no spoken unit');
    await speak(vendor, { sessionId, turnId: next.turnId, seq: next.seq, text: next.text, sig: next.sig });
    expect(clone.calls.length).toBe(cloned + 1);
    expect(polly.calls.length).toBe(pollied + 2);
  });

  it('withdrawing likeness ends the face at once; withdrawing voice falls back to the platform voice', async () => {
    const consentId = (await vendor.twin.get(ctx.lead, corinPersona())).consentId;
    if (consentId === null) throw new Error('no consent in force');
    const withdrawn = await vendor.twin.withdrawScope(ctx.lead, consentId, { assetType: 'likeness' });
    expect(withdrawn.consent.assetTypes).not.toContain('likeness');
    expect(withdrawn.previousConsentId).toBe(consentId);
    // Nobody was suspended: the vEIR keeps coaching, now without its face.
    const twin = await vendor.twin.get(ctx.lead, corinPersona());
    expect(twin).toMatchObject({ consentId: withdrawn.consent.id, scopes: { likeness: false, voice: true } });
    expect(twin.face?.status).toBe('withdrawn');

    // The face takes nothing more, and the next heartbeat ends it; the call goes on.
    await expect(
      vendor.face.speak(ctx.maya, callId, { manifest: 'fa1.x.y.z', firstChunk: 0, pcm: new Uint8Array(2) }),
    ).rejects.toMatchObject({ reason: 'face_not_active' });
    const after = await beat(vendor, callId, 'live');
    expect(after).toMatchObject({ action: 'continue', face: 'stop' });
    expect(vendorFace.ended.at(-1)?.reason).toBe('face_stopped');
    expect(await lastAudit('call.face_ended')).toMatchObject({ policy_reason: 'likeness_withdrawn' });

    // Voice withdrawn mid-call: the next unit is the platform voice, the call carries on.
    await vendor.twin.withdrawScope(ctx.lead, withdrawn.consent.id, { assetType: 'voice' });
    expect((await beat(vendor, callId)).action).toBe('continue');
    const units = await spokenUnits(vendor, sessionId, callId, 'And after that, how do I price it?');
    const unit = units[0];
    if (unit === undefined) throw new Error('no spoken unit');
    const cloned = clone.calls.length;
    const spoken = await speak(vendor, {
      sessionId,
      turnId: unit.turnId,
      seq: unit.seq,
      text: unit.text,
      sig: unit.sig,
    });
    expect(clone.calls.length).toBe(cloned);
    expect(polly.calls.at(-1)?.voiceId).toBe(DEFAULT_SPEECH_VOICE);
    expect(spoken.contentType).toBe('audio/mpeg');
    await vendor.calls.end(ctx.maya, callId, { reason: 'user' });
  });

  it('meters the vendor face at its per-minute price', async () => {
    const metered = await usage('heygen:liveavatar-lite');
    expect(metered.n).toBeGreaterThan(0);
    expect(metered.cost).toBeCloseTo((metered.units / 60) * 0.093, 8);
  });
});
