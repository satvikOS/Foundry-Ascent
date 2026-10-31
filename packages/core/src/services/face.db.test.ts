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
 * - tokens and the control channel are never recorded;
 * - a sandbox or admins-only face is offered to platform admins and the people a platform admin gave video-face
 *   access only; a FULL stock face (the vendor's stock voice speaks admitted text) needs no persona face, takes each signed unit once and in order (never the crisis line, within the spend cap), gets no
 *   face-audio manifest, is billed at the FULL price, and ends at the first words its transcript shows it never
 *   admitted (or an admitted unit said again), checked on every way the face ends, reading only new lines, and
 *   stops when its transcript stays unread;
 * - on a live FULL face, the turn engine admits each unit as it signs it (face pre-approval: the same checks, the
 *   flag under the signature), `face/say` confirms such a unit without reserving it again, and the transcript is
 *   reconciled against pre-approved words like any other.
 */
import { CRISIS_SPOKEN_MESSAGE } from '@foundry/ai';
import {
  AvatarSessionResponse,
  CallConfigResponse,
  CallHeartbeatResponse,
  StartCallResponse,
  TurnStreamEvent,
} from '@foundry/contracts';
import { p, principalsRepo, twinRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformKeyCache } from '../auth/keys.js';
import { type RequestContext } from '../context.js';
import { type Core } from '../core.js';
import { resolveDeps } from '../deps.js';
import { Kit } from '../internal/kit.js';
import { FACE_CHUNK_BYTES } from '../orchestrator/face-audio.js';
import { signSpeechUnit } from '../orchestrator/speech-units.js';
import { type SynthesizedSpeech } from '../ports.js';
import { FACE_TEXT_PLAYS } from './speech.js';
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

  it('offers a sandbox or admins-only face to a founder a platform admin gave video-face access', async () => {
    const presentation = new FakeEmbodimentProvider('fake', false, 0);
    presentation.adminsOnly = true;
    const sandboxFace = new FakeEmbodimentProvider('fake', false, 0);
    sandboxFace.sandbox = true;
    const setAccess = (faceAccess: boolean) =>
      h.t.db.system((sx) =>
        principalsRepo.setFaceAccess(sx, {
          principalId: h.people.maya,
          tenantId: h.seed.tenantId,
          faceAccess,
        }),
      );
    try {
      await setAccess(true);
      for (const provider of [presentation, sandboxFace]) {
        const core = h.withPorts({ speech: polly, embodiment: provider });
        // Read fresh from the database: the same signed-in founder, no new session needed.
        expect(CallConfigResponse.parse(await core.veir.callConfig(ctx.maya, quietquad())).provider).toBe(
          'fake',
        );
        const started = await startCall(core);
        try {
          expect(await faceSession(core, started.call.id)).toMatchObject({ provider: 'fake' });
          expect(provider.sessions).toHaveLength(1);
          expect(await lastAudit('call.avatar_session')).toMatchObject({ outcome: 'succeeded' });
        } finally {
          await core.calls.end(ctx.maya, started.call.id, { reason: 'user' });
        }
      }
      // A teammate of the same venture without face access still gets the presence.
      const presented = h.withPorts({ speech: polly, embodiment: presentation });
      expect(CallConfigResponse.parse(await presented.veir.callConfig(ctx.devin, quietquad())).provider).toBe(
        'builtin',
      );
      // Turned off, the next call has no face (the roles were never involved).
      await setAccess(false);
      expect(CallConfigResponse.parse(await presented.veir.callConfig(ctx.maya, quietquad())).provider).toBe(
        'builtin',
      );
      const again = await startCall(presented);
      try {
        expect(await faceSession(presented, again.call.id)).toMatchObject({
          provider: 'builtin',
          token: null,
        });
        expect(presentation.sessions).toHaveLength(1);
        expect(await lastAudit('call.avatar_session')).toMatchObject({
          outcome: 'denied',
          policy_reason: 'admins_only',
        });
      } finally {
        await presented.calls.end(ctx.maya, again.call.id, { reason: 'user' });
      }
    } finally {
      await setAccess(false);
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
      // The test hands parts 0, 1 and 2 of the intro. Since wave 7 a repeat call's intro is one sentence of at most
      // 90 characters ("Hi Maya, …?"), about three seconds of speech; it used to run two or three sentences.
      expect(Math.ceil(pcm.length / FACE_CHUNK_BYTES)).toBeGreaterThanOrEqual(3);
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

describe('a FULL stock face (the vendor’s stock voice speaks admitted text), for platform admins only', () => {
  const stock = new FakeEmbodimentProvider('heygen', false, 0.19, 'full');
  stock.adminsOnly = true;
  let full: Core;
  let admin: RequestContext;
  let callId: string;
  let sessionId: string;
  let sessionRef: string;
  let intro: { text: string; sig: string } | null;

  const say = (input: { turnId: string | null; seq: number; text: string; sig: string }, who = admin) =>
    full.speech.authorizeFaceText(who, callId, input);
  /** The units of a spoken turn with their face flag (pre-approved on a live FULL face). */
  async function flaggedUnits(text: string) {
    const units: { turnId: string; seq: number; text: string; sig: string; face: boolean }[] = [];
    await full.orchestrator.runTurn(admin, sessionId, { text, channel: 'voice', callId }, (e) => {
      const event = TurnStreamEvent.parse(e);
      if (event.event === 'turn.speech') {
        const { turnId, seq, text: words, sig } = event;
        units.push({ turnId, seq, text: words, sig, face: event.face === true });
      }
    });
    return units;
  }
  /** The units of a spoken turn made while faces were switched off: none is pre-approved, so face/say decides. */
  async function unapprovedUnits(text: string) {
    await setting('faces_enabled', 'false');
    try {
      return await spokenUnits(full, sessionId, callId, text);
    } finally {
      await setting('faces_enabled', 'true');
    }
  }
  /** What the call holds for a face unit: its admitted row, its reservation and the call's characters. */
  async function faceState(unit: { turnId: string; seq: number }) {
    const r = await h.t.db.system((sx) =>
      sx.query(
        `SELECT (SELECT preapproved FROM call_face_texts WHERE call_id = :call AND unit = :unit) AS preapproved,
                (SELECT plays FROM call_speech WHERE call_id = :call AND unit = :face)::int AS plays,
                (SELECT speech_characters FROM calls WHERE id = :call)::int AS characters`,
        {
          call: p.uuid(callId),
          unit: p.text(`unit.${unit.turnId.toLowerCase()}.${String(unit.seq)}`),
          face: p.text(`face.${unit.turnId.toLowerCase()}.${String(unit.seq)}`),
        },
      ),
    );
    const row = r.rows[0] as { preapproved: boolean | null; plays: number | null; characters: number };
    return { preapproved: row.preapproved, plays: row.plays ?? 0, characters: row.characters };
  }
  const refusedWith = async (promise: Promise<unknown>, reason: string) => {
    await expect(promise).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await lastAudit('speech.refused')).toMatchObject({ outcome: 'denied', policy_reason: reason });
  };
  const fullBeat = async (face?: 'live' | 'off') =>
    CallHeartbeatResponse.parse(
      await full.calls.heartbeat(admin, callId, {
        state: 'listening',
        micOpenSeconds: 0,
        ...(face ? { face } : {}),
      }),
    );

  beforeAll(async () => {
    full = h.withPorts({ speech: polly, embodiment: stock });
    await setting('faces_enabled', 'true');
  });

  afterAll(async () => {
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE role_grants SET revoked_at = now()
          WHERE principal_id = :p AND role = 'platform_admin' AND revoked_at IS NULL`,
        { p: p.uuid(h.people.maya) },
      ),
    );
  });

  it('is never offered to founders, even when it is not a sandbox', async () => {
    expect(CallConfigResponse.parse(await full.veir.callConfig(ctx.maya, quietquad())).provider).toBe(
      'builtin',
    );
    const started = await startCall(full);
    try {
      expect(await faceSession(full, started.call.id)).toMatchObject({ provider: 'builtin', token: null });
      expect(stock.sessions).toHaveLength(0);
      expect(await lastAudit('call.avatar_session')).toMatchObject({
        outcome: 'denied',
        policy_reason: 'admins_only',
      });
    } finally {
      await full.calls.end(ctx.maya, started.call.id, { reason: 'user' });
    }
  });

  it('opens for a platform admin with the provider’s own avatar, labelled, needing no persona face', async () => {
    await h.t.db.system((sx) =>
      sx.query(`INSERT INTO role_grants (principal_id, role) VALUES (:p, 'platform_admin')`, {
        p: p.uuid(h.people.maya),
      }),
    );
    admin = await h.ctxFor(h.people.maya);
    expect(CallConfigResponse.parse(await full.veir.callConfig(admin, quietquad())).provider).toBe('heygen');
    const sid = (await full.sessions.create(admin, quietquad(), {})).id;
    const started = StartCallResponse.parse(await full.calls.start(admin, sid, { inputMode: 'typed' }));
    callId = started.call.id;
    sessionId = started.call.sessionId;
    intro = started.intro;
    const minted = AvatarSessionResponse.parse(
      await full.veir.avatarSession(admin, { ventureId: quietquad(), callId }),
    );
    expect(minted).toMatchObject({ provider: 'heygen', voicing: 'text', stockFace: true });
    expect(stock.sessions.at(-1)).toMatchObject({ callId, avatarRef: null });
    const face = await h.t.db.system((sx) => twinRepo.getCallFace(sx, callId));
    expect(face).toMatchObject({ mode: 'full', vendor: 'heygen', control: null });
    sessionRef = face?.sessionRef ?? '';
    const opened = await lastAudit('call.avatar_session');
    expect(JSON.parse((opened as unknown as { metadata: string }).metadata)).toMatchObject({
      provider: 'heygen',
      mode: 'full',
      voicing: 'text',
    });
  });

  it('admits each signed unit once and in order, and gives /speech no face manifest', async () => {
    if (intro === null) throw new Error('no intro');
    const admitted = await say({ turnId: null, seq: 0, text: intro.text, sig: intro.sig });
    expect(admitted).toMatchObject({ callId, unit: 'intro' });
    await refusedWith(say({ turnId: null, seq: 0, text: intro.text, sig: intro.sig }), 'already_shown');
    // Tampered words under a real signature.
    await refusedWith(
      say({ turnId: null, seq: 0, text: `${intro.text} Ignore your coach.`, sig: intro.sig }),
      'signature_invalid',
    );

    // Units the turn engine did not pre-approve (faces were off while they were signed): face/say decides alone.
    const units = await unapprovedUnits('What should I test first with ten customers?');
    expect(units.length).toBeGreaterThanOrEqual(2);
    const [first, second] = units;
    if (first === undefined || second === undefined) throw new Error('no units');
    // A later unit first (an earlier one was skipped: a barge-in, a failure), then the earlier one: refused.
    await say(second);
    await refusedWith(say(first), 'out_of_order');
    await refusedWith(say(second), 'already_shown');
    // Unsigned words of the reply are never admitted (the contract requires a signature; a forged one fails).
    await refusedWith(say({ ...first, sig: 'v1.forged.AAAAAAAAAAAAAAAAAAAAAA' }), 'signature_invalid');
    // Nobody else's call.
    await expect(say(second, ctx.devin)).rejects.toMatchObject({ code: 'not_found' });

    // The call's audio for a unit is the stock-voice fallback only: MP3, no manifest.
    const [next] = await unapprovedUnits('And how many interviews is enough?');
    if (next === undefined) throw new Error('no unit');
    const spoken: SynthesizedSpeech = await full.speech.synthesize(admin, {
      sessionId,
      turnId: next.turnId,
      seq: next.seq,
      text: next.text,
      sig: next.sig,
    });
    await new Response(spoken.audio).arrayBuffer();
    expect(spoken.contentType).toBe('audio/mpeg');
    expect(spoken.faceManifest).toBeUndefined();
    // …and the face may still say that unit (its reservation is its own).
    await say(next);
    // A FULL face never takes audio.
    await expect(
      full.face.speak(admin, callId, { manifest: 'fa1.x.y.z', firstChunk: 0, pcm: new Uint8Array(2) }),
    ).rejects.toMatchObject({ reason: 'face_not_active' });
  });

  it('never admits the crisis line, and stops at the platform’s spend cap', async () => {
    const events: TurnStreamEvent[] = [];
    await full.orchestrator.runTurn(
      admin,
      sessionId,
      { text: 'I want to end my life tonight.', channel: 'voice', callId },
      (e) => {
        events.push(TurnStreamEvent.parse(e));
      },
    );
    const blocked = events.find((e) => e.event === 'turn.blocked');
    if (blocked?.event !== 'turn.blocked') throw new Error('expected a blocked crisis turn');
    // The crisis line is said on the call, and never pre-approved for the face.
    const crisisUnits = events.flatMap((e) => (e.event === 'turn.speech' ? [e] : []));
    expect(crisisUnits.length).toBeGreaterThan(0);
    expect(crisisUnits.every((u) => u.face === undefined)).toBe(true);
    expect(await faceState({ turnId: blocked.turnId, seq: 0 })).toMatchObject({
      preapproved: null,
      plays: 0,
    });
    const key = await keys.signingKey();
    const crisisOfTurn = {
      turnId: blocked.turnId,
      seq: 0,
      text: CRISIS_SPOKEN_MESSAGE,
      sig: signSpeechUnit(key, { sessionId, turnId: blocked.turnId, seq: 0, text: CRISIS_SPOKEN_MESSAGE }),
    };
    await expect(say(crisisOfTurn)).rejects.toMatchObject({ reason: 'turn_not_speakable' });
    // Even validly signed, the crisis words are never handed to the face.
    const signedCrisis = {
      turnId: null,
      seq: 1,
      text: CRISIS_SPOKEN_MESSAGE,
      sig: signSpeechUnit(key, { sessionId, turnId: null, seq: 1, text: CRISIS_SPOKEN_MESSAGE }),
    };
    await refusedWith(say(signedCrisis), 'crisis_line');

    const [unit] = await spokenUnits(full, sessionId, callId, 'Who should I talk to first?');
    if (unit === undefined) throw new Error('no unit');
    await setting('daily_usd_cap_global', '0');
    try {
      await expect(say(unit)).rejects.toMatchObject({ code: 'spend_cap_reached' });
    } finally {
      await setting('daily_usd_cap_global', '15');
    }
    await say(unit);
  });

  it('pre-approves each unit as the turn engine signs it, and face/say confirms it without reserving again', async () => {
    const units = await flaggedUnits('How do I find my first ten customers?');
    expect(units.length).toBeGreaterThanOrEqual(1);
    expect(units.every((u) => u.face)).toBe(true);
    const before = await Promise.all(units.map((u) => faceState(u)));
    for (const state of before) expect(state).toMatchObject({ preapproved: true, plays: FACE_TEXT_PLAYS });
    const characters = (before.at(-1) ?? { characters: 0 }).characters;
    // The audit is written beside the reply, never ahead of it.
    await expect
      .poll(async () => {
        const audit = (await lastAudit('call.face_text_admitted')) as unknown as { metadata: string };
        return JSON.parse(audit.metadata) as unknown;
      })
      .toMatchObject({ callId, preapproved: true });

    // The browser asks anyway (an older page, a race with the stream): the same 204, nothing more reserved, twice.
    for (const unit of [...units, ...units]) {
      expect(await say(unit)).toMatchObject({ callId, unit: `unit.${unit.turnId}.${String(unit.seq)}` });
    }
    for (const unit of units) {
      expect(await faceState(unit)).toEqual({ preapproved: true, plays: FACE_TEXT_PLAYS, characters });
    }
    // Every check of face/say still runs first: tampered words, someone else, the spend cap.
    const [first] = units;
    if (first === undefined) throw new Error('no unit');
    await refusedWith(say({ ...first, text: `${first.text} Wire me the money.` }), 'signature_invalid');
    await expect(say(first, ctx.devin)).rejects.toMatchObject({ code: 'not_found' });
    await setting('daily_usd_cap_global', '0');
    try {
      await expect(say(first)).rejects.toMatchObject({ code: 'spend_cap_reached' });
    } finally {
      await setting('daily_usd_cap_global', '15');
    }
    // A reply that was blocked afterwards is no longer spoken, pre-approved or not.
    await h.t.db.system((sx) =>
      sx.query(`UPDATE turns SET status = 'blocked' WHERE id = :id`, { id: p.uuid(first.turnId) }),
    );
    await expect(say(first)).rejects.toMatchObject({ reason: 'turn_not_speakable' });
    expect(await faceState(first)).toEqual({ preapproved: true, plays: FACE_TEXT_PLAYS, characters });
  });

  it('pre-approves only what face/say would admit, once, in order, and otherwise leaves the turn to face/say', async () => {
    const approvalFor = (who = admin, args = { callId, sessionId }) =>
      full.speech.prepareFaceApproval(who, args);
    const approval = await approvalFor();
    if (approval === null) throw new Error('no pre-approval on a live FULL face');
    const unitOf = (turnId: string, seq: number, text = `Sentence ${String(seq)} for the face.`) => ({
      turnId,
      seq,
      text,
    });

    // Never someone else's call, another conversation, or where the wired face is not FULL.
    expect(await approvalFor(ctx.devin)).toBeNull();
    expect(
      await approvalFor(admin, { callId, sessionId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }),
    ).toBeNull();
    expect(await approvalFor(admin, { callId: 'not-an-id', sessionId })).toBeNull();
    const lite = h.withPorts({ speech: polly, embodiment: standIn });
    expect(await lite.speech.prepareFaceApproval(admin, { callId, sessionId })).toBeNull();
    const faceless = h.withPorts({ speech: polly });
    expect(await faceless.speech.prepareFaceApproval(admin, { callId, sessionId })).toBeNull();

    // Once, and in order: a later unit first, then the earlier one is refused and its characters go back.
    const turnA = crypto.randomUUID();
    expect(await approval.approve(unitOf(turnA, 1))).toBe(true);
    const settled = await faceState({ turnId: turnA, seq: 1 });
    expect(settled).toMatchObject({ preapproved: true, plays: FACE_TEXT_PLAYS });
    expect(await approval.approve(unitOf(turnA, 0))).toBe(false);
    expect(await faceState({ turnId: turnA, seq: 0 })).toEqual({
      preapproved: null,
      plays: 0,
      characters: settled.characters,
    });
    // After a refusal the rest of the turn goes through face/say (so its order holds there).
    expect(await approval.approve(unitOf(turnA, 2))).toBe(false);
    expect(await faceState({ turnId: turnA, seq: 2 })).toMatchObject({ preapproved: null, plays: 0 });
    // A unit admitted once is never admitted again.
    const again = await approvalFor();
    expect(await again?.approve(unitOf(turnA, 1))).toBe(false);
    expect(await faceState({ turnId: turnA, seq: 1 })).toEqual(settled);

    // Each refusal of face/say refuses here too, silently (face/say decides and audits), storing nothing.
    const setSpeechCharacters = (n: number) =>
      h.t.db.system(async (sx) => {
        await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
        await sx.query(`UPDATE calls SET speech_characters = :n WHERE id = :id`, {
          id: p.uuid(callId),
          n: p.int(n),
        });
        await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
      });
    const switched = (key: string, off: string, on: string) => async () => {
      await setting(key, off);
      return () => setting(key, on);
    };
    const refusals: {
      readonly name: string;
      readonly arrange: () => Promise<() => Promise<void>>;
      readonly text?: string;
    }[] = [
      {
        name: 'the crisis line',
        arrange: () => Promise.resolve(() => Promise.resolve()),
        text: CRISIS_SPOKEN_MESSAGE,
      },
      { name: 'faces switched off', arrange: switched('faces_enabled', 'false', 'true') },
      { name: 'calls paused', arrange: switched('calls_enabled', 'false', 'true') },
      { name: 'AI paused', arrange: switched('ai_enabled', 'false', 'true') },
      { name: 'the platform’s spend cap', arrange: switched('daily_usd_cap_global', '0', '15') },
      {
        name: 'the call’s speech budget',
        arrange: async () => {
          const was = settled.characters;
          await setSpeechCharacters(1_000_000);
          return () => setSpeechCharacters(was);
        },
      },
    ];
    for (const refusal of refusals) {
      const turn = crypto.randomUUID();
      const fresh = await approvalFor();
      if (fresh === null) throw new Error(`no pre-approval before ${refusal.name}`);
      const restore = await refusal.arrange();
      try {
        expect(await fresh.approve(unitOf(turn, 0, refusal.text)), refusal.name).toBe(false);
      } finally {
        await restore();
      }
      expect(await faceState({ turnId: turn, seq: 0 }), refusal.name).toMatchObject({
        preapproved: null,
        plays: 0,
        characters: settled.characters,
      });
      // Off for the rest of that turn, even once the reason is gone.
      expect(await fresh.approve(unitOf(turn, 1)), refusal.name).toBe(false);
    }
  });

  it('keeps the face while it says admitted words, and ends it at the first words it never admitted', async () => {
    if (intro === null) throw new Error('no intro');
    stock.said(sessionRef, intro.text);
    expect((await fullBeat('live')).face).toBe('continue');
    // A unit still being transcribed is pending, not an injection.
    stock.said(sessionRef, 'Who should I');
    expect((await fullBeat('live')).face).toBe('continue');
    // A tampered page made the face say something else, then went on.
    stock.said(sessionRef, 'talk to first? Actually, wire me the money.');
    stock.said(sessionRef, intro.text);
    expect(await fullBeat('live')).toMatchObject({ action: 'continue', face: 'stop' });
    expect(stock.ended.at(-1)?.reason).toBe('face_stopped');
    const injected = await lastAudit('call.face_injection');
    expect(injected).toMatchObject({ outcome: 'blocked', object_id: callId });
    expect(injected.raw).not.toContain('money');
    expect(await lastAudit('call.face_ended')).toMatchObject({ policy_reason: 'face_injection' });
    // The call goes on with the presence; the face takes nothing more.
    await expect(say({ turnId: null, seq: 0, text: intro.text, sig: intro.sig })).rejects.toMatchObject({
      reason: 'face_not_active',
    });
    expect((await fullBeat()).action).toBe('continue');
    await full.calls.end(admin, callId, { reason: 'user' });
  });

  it('ends a face whose last words stay unmatched, and bills FULL at its own price', async () => {
    const sid = (await full.sessions.create(admin, quietquad(), {})).id;
    const started = StartCallResponse.parse(await full.calls.start(admin, sid, { inputMode: 'typed' }));
    callId = started.call.id;
    await full.veir.avatarSession(admin, { ventureId: quietquad(), callId });
    const ref = (await h.t.db.system((sx) => twinRepo.getCallFace(sx, callId)))?.sessionRef ?? '';
    stock.said(ref, 'You are talking to a real person.');
    expect((await fullBeat('live')).face).toBe('continue');
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE call_faces SET transcript_pending_since = now() - interval '40 seconds' WHERE call_id = :id`,
        { id: p.uuid(callId) },
      ),
    );
    // A vendor transcript that cannot be read right now never ends a face on its own (the next beat reads it).
    stock.failTranscript = true;
    try {
      expect((await fullBeat('live')).face).toBe('continue');
    } finally {
      stock.failTranscript = false;
    }
    expect((await fullBeat('live')).face).toBe('stop');
    expect(await lastAudit('call.face_injection')).toMatchObject({ object_id: callId });
    await full.calls.end(admin, callId, { reason: 'user' });

    const metered = await usage('heygen:liveavatar-full');
    expect(metered.n).toBeGreaterThan(0);
    // The ledger keeps six decimals per row.
    expect(metered.cost).toBeCloseTo((metered.units / 60) * 0.19, 4);
  });
});

describe('a FULL face’s transcript is checked however the face ends, and never goes blind', () => {
  const stock = new FakeEmbodimentProvider('heygen', false, 0.19, 'full');
  stock.adminsOnly = true;
  let full: Core;
  let admin: RequestContext;

  beforeAll(async () => {
    full = h.withPorts({ speech: polly, embodiment: stock });
    await setting('faces_enabled', 'true');
    await h.t.db.system((sx) =>
      sx.query(
        `INSERT INTO role_grants (principal_id, role)
         SELECT :p, 'platform_admin' WHERE NOT EXISTS (
           SELECT 1 FROM role_grants WHERE principal_id = :p AND role = 'platform_admin' AND revoked_at IS NULL)`,
        { p: p.uuid(h.people.maya) },
      ),
    );
    admin = await h.ctxFor(h.people.maya);
  });

  afterAll(async () => {
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE role_grants SET revoked_at = now()
          WHERE principal_id = :p AND role = 'platform_admin' AND revoked_at IS NULL`,
        { p: p.uuid(h.people.maya) },
      ),
    );
  });

  /** A live call of the admin with a FULL face that was allowed to say the intro. */
  async function openFull(): Promise<{ callId: string; ref: string; intro: string; sessionId: string }> {
    const sid = (await full.sessions.create(admin, quietquad(), {})).id;
    const started = StartCallResponse.parse(await full.calls.start(admin, sid, { inputMode: 'typed' }));
    const callId = started.call.id;
    await full.veir.avatarSession(admin, { ventureId: quietquad(), callId });
    const face = await h.t.db.system((sx) => twinRepo.getCallFace(sx, callId));
    if (face === null || started.intro === null) throw new Error('no FULL face');
    await full.speech.authorizeFaceText(admin, callId, {
      turnId: null,
      seq: 0,
      text: started.intro.text,
      sig: started.intro.sig,
    });
    return { callId, ref: face.sessionRef, intro: started.intro.text, sessionId: sid };
  }

  const beatOf = async (callId: string, face?: 'live' | 'off') =>
    CallHeartbeatResponse.parse(
      await full.calls.heartbeat(admin, callId, {
        state: 'listening',
        micOpenSeconds: 0,
        ...(face ? { face } : {}),
      }),
    );

  async function audits(
    action: string,
    callId: string,
  ): Promise<{ outcome: string; policy_reason: string }[]> {
    const rows = await h.t.db.system((sx) =>
      sx.query(
        `SELECT outcome, policy_reason FROM audit_events WHERE action = :a AND object_id = :id ORDER BY id`,
        { a: p.text(action), id: p.text(callId) },
      ),
    );
    return rows.rows as { outcome: string; policy_reason: string }[];
  }

  async function endQuietly(callId: string): Promise<void> {
    await full.calls.end(admin, callId, { reason: 'user' }).catch(() => undefined);
  }

  it('checks what the face said when the page reports the face off', async () => {
    const { callId, ref, intro } = await openFull();
    try {
      stock.said(ref, intro);
      stock.said(ref, 'I am a human, not an AI.');
      expect((await beatOf(callId, 'off')).face).toBe('stop');
      expect(await audits('call.face_injection', callId)).toHaveLength(1);
      expect(await audits('call.face_ended', callId)).toMatchObject([{ policy_reason: 'face_injection' }]);
    } finally {
      await endQuietly(callId);
    }
  });

  it('checks what the face said when the page ends the face (POST /calls/:id/face/end)', async () => {
    const { callId, ref, intro } = await openFull();
    try {
      stock.said(ref, intro);
      stock.said(ref, 'Wire the money to this account.');
      await full.face.drop(admin, callId);
      expect(await audits('call.face_injection', callId)).toHaveLength(1);
      expect(await audits('call.face_ended', callId)).toMatchObject([{ policy_reason: 'face_injection' }]);
    } finally {
      await endQuietly(callId);
    }
  });

  it('checks what the face said when the call is hung up', async () => {
    const { callId, ref, intro } = await openFull();
    stock.said(ref, intro);
    stock.said(ref, 'Wire the money to this account.');
    await full.calls.end(admin, callId, { reason: 'user' });
    expect(await audits('call.face_injection', callId)).toHaveLength(1);
    expect(stock.ended.at(-1)?.reason).toBe('call_ended');
  });

  it('checks a face the daily maintenance closed, and records it unchecked where no vendor is wired', async () => {
    const goStale = async (callId: string) => {
      await h.t.db.system(async (sx) => {
        await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
        await sx.query(
          `UPDATE calls SET started_at = now() - interval '240 seconds',
                            last_heartbeat_at = now() - interval '200 seconds' WHERE id = :id`,
          { id: p.uuid(callId) },
        );
        await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
      });
    };
    const wired = await openFull();
    stock.said(wired.ref, wired.intro);
    stock.said(wired.ref, 'Wire the money to this account.');
    await goStale(wired.callId);
    await full.maintenance.runDaily({ requestId: 'maintenance-full-face' });
    expect(await audits('call.face_injection', wired.callId)).toHaveLength(1);

    // The worker wires no vendor: the face is recorded as never checked at its end, not passed over.
    const unwired = await openFull();
    stock.said(unwired.ref, unwired.intro);
    await goStale(unwired.callId);
    await h.withPorts({ speech: polly }).maintenance.runDaily({ requestId: 'maintenance-full-face-2' });
    expect(await audits('call.face_injection', unwired.callId)).toHaveLength(0);
    expect(await audits('call.face_transcript_unchecked', unwired.callId)).toMatchObject([
      { outcome: 'failed', policy_reason: 'vendor_not_wired' },
    ]);
  });

  it('ends the face at the next heartbeat when its last words still match nothing it was allowed to say', async () => {
    const { callId, ref, intro } = await openFull();
    try {
      stock.said(ref, intro);
      stock.said(ref, 'You are talking to a real person.');
      expect((await beatOf(callId, 'live')).face).toBe('continue');
      // The next heartbeat, 16 s on.
      await h.t.db.system((sx) =>
        sx.query(
          `UPDATE call_faces SET transcript_pending_since = now() - interval '16 seconds' WHERE call_id = :id`,
          { id: p.uuid(callId) },
        ),
      );
      expect((await beatOf(callId, 'live')).face).toBe('stop');
      expect(await audits('call.face_injection', callId)).toHaveLength(1);
    } finally {
      await endQuietly(callId);
    }
  });

  it('reconciles words the turn engine pre-approved like any admitted unit, and still catches injected ones', async () => {
    const { callId, ref, intro, sessionId } = await openFull();
    try {
      const units: { text: string; face: boolean }[] = [];
      await full.orchestrator.runTurn(
        admin,
        sessionId,
        { text: 'What should I test first with ten customers?', channel: 'voice', callId },
        (e) => {
          const event = TurnStreamEvent.parse(e);
          if (event.event === 'turn.speech') units.push({ text: event.text, face: event.face === true });
        },
      );
      expect(units.length).toBeGreaterThanOrEqual(2);
      expect(units.every((u) => u.face)).toBe(true);
      const [first, second] = units;
      if (first === undefined || second === undefined) throw new Error('no units');
      stock.said(ref, intro);
      stock.said(ref, first.text);
      expect((await beatOf(callId, 'live')).face).toBe('continue');
      // A tampered page made the face say something else between two pre-approved units.
      stock.said(ref, 'Actually, wire me the money.');
      stock.said(ref, second.text);
      expect((await beatOf(callId, 'live')).face).toBe('stop');
      expect(await audits('call.face_injection', callId)).toHaveLength(1);
      expect(await audits('call.face_ended', callId)).toMatchObject([{ policy_reason: 'face_injection' }]);
    } finally {
      await endQuietly(callId);
    }
  });

  it('catches an admitted unit said again (each unit is said once)', async () => {
    const { callId, ref, intro } = await openFull();
    try {
      stock.said(ref, intro);
      expect((await beatOf(callId, 'live')).face).toBe('continue');
      stock.said(ref, intro);
      expect((await beatOf(callId, 'live')).face).toBe('stop');
      expect(await audits('call.face_injection', callId)).toHaveLength(1);
    } finally {
      await endQuietly(callId);
    }
  });

  it('reads only the lines after those it verified, and stops a face whose transcript stays unread', async () => {
    const { callId, ref, intro } = await openFull();
    try {
      stock.said(ref, intro);
      expect((await beatOf(callId, 'live')).face).toBe('continue');
      expect((await beatOf(callId, 'live')).face).toBe('continue');
      // The second check asked from the line it verified on, not the whole session again.
      expect(stock.transcriptReads.at(-1)).toMatchObject({ sessionRef: ref, since: 1 });
      // The vendor stops answering in full: recorded, and after a minute unread the face stops.
      stock.transcriptIncomplete = true;
      try {
        expect((await beatOf(callId, 'live')).face).toBe('continue');
        await h.t.db.system((sx) =>
          sx.query(
            `UPDATE call_faces SET transcript_checked_at = now() - interval '70 seconds' WHERE call_id = :id`,
            { id: p.uuid(callId) },
          ),
        );
        expect((await beatOf(callId, 'live')).face).toBe('stop');
      } finally {
        stock.transcriptIncomplete = false;
      }
      expect(await audits('call.face_ended', callId)).toMatchObject([{ policy_reason: 'face_check_failed' }]);
      expect(await audits('call.face_injection', callId)).toHaveLength(0);
    } finally {
      await endQuietly(callId);
    }
  });
});
