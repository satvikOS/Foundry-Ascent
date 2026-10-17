/**
 * The face of a call (docs/architecture/calls.md §4): `POST /calls/avatar-session` with a vendor face behind
 * the `EmbodimentSessionIssuer` port (here the development stand-in, `fake`). A session token is minted only
 * for the caller's own live call, ends with the call's time left, is never recorded, and every way the face
 * can be unavailable leaves the call on the built-in presence instead of failing it.
 */
import { AvatarSessionResponse, CallConfigResponse, StartCallResponse } from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { FakeEmbodimentSessionIssuer } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { MIN_FACE_SECONDS } from './veir.js';

let h: CoreHarness;
const face = new FakeEmbodimentSessionIssuer('fake', 'audio', false);
type Person = 'maya' | 'devin';
const ctx = {} as Record<Person, RequestContext>;

const quietquad = (): string => h.ventures.quietquad.id;

async function startCall(who: Person): Promise<string> {
  const sessionId = (await h.core.sessions.create(ctx[who], quietquad(), {})).id;
  const started = StartCallResponse.parse(
    await h.core.calls.start(ctx[who], sessionId, { inputMode: 'typed' }),
  );
  return started.call.id;
}

async function session(who: Person, callId?: string) {
  return AvatarSessionResponse.parse(
    await h.core.veir.avatarSession(ctx[who], { ventureId: quietquad(), ...(callId ? { callId } : {}) }),
  );
}

/** The newest audit event of an action, with its metadata. */
async function lastAudit(action: string) {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT outcome, object_type, object_id, metadata::text AS metadata FROM audit_events
       WHERE action = :action ORDER BY id DESC LIMIT 1`,
      { action: p.text(action) },
    ),
  );
  const row = rows.rows[0];
  if (!row) throw new Error(`no ${action} audit`);
  return {
    outcome: row.outcome,
    objectType: row.object_type,
    objectId: row.object_id,
    metadata: JSON.parse(String(row.metadata)) as unknown,
    raw: JSON.stringify(row),
  };
}

async function callsEnabled(on: boolean): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(
      `INSERT INTO platform_settings (key, value) VALUES ('calls_enabled', :v::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      { v: p.text(on ? 'true' : 'false') },
    ),
  );
}

/** Moves a live call's start back in time (owner role), so it is close to its time limit. */
async function backdate(callId: string, seconds: number): Promise<void> {
  await h.t.db.system(async (sx) => {
    await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
    await sx.query(
      `UPDATE calls SET started_at = now() - make_interval(secs => :s), last_heartbeat_at = now() WHERE id = :id`,
      { id: p.uuid(callId), s: p.int(seconds) },
    );
    await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
  });
}

beforeAll(async () => {
  h = await createCoreHarness({ embodiment: face });
  for (const person of ['maya', 'devin'] as const) ctx[person] = await h.ctxFor(h.people[person]);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('the face of a call', () => {
  it('names the stand-in in the call settings and mints a session only for a live call', async () => {
    const config = CallConfigResponse.parse(await h.core.veir.callConfig(ctx.maya, quietquad()));
    expect(config.provider).toBe('fake');
    // The persona's own record is unchanged: the stand-in is not stored anywhere.
    expect(config.veir.embodiment.provider).toBe('builtin');

    // No call named: the presence, no vendor round trip.
    const before = face.calls.length;
    expect(await session('maya')).toEqual({
      provider: 'builtin',
      token: null,
      expiresAt: null,
      voiceId: 'Matthew',
      voicing: 'engine',
    });
    expect(face.calls.length).toBe(before);

    const callId = await startCall('maya');
    const minted = await session('maya', callId);
    expect(minted).toMatchObject({ provider: 'fake', voiceId: 'Matthew', voicing: 'audio' });
    expect(minted.token).toMatch(/^fake\.session-\d+$/);
    expect(Date.parse(minted.expiresAt ?? '')).toBeGreaterThan(Date.now());
    // Bound to the call and its time left (a 30-minute call), so the vendor stops billing with it.
    expect(face.calls.at(-1)).toMatchObject({ callId, personaId: h.ventures.quietquad.personaId });
    expect(face.calls.at(-1)?.maxSeconds).toBeGreaterThan(29 * 60);
    expect(face.calls.at(-1)?.maxSeconds).toBeLessThanOrEqual(30 * 60);

    // Audited with identifiers only: the token is a credential.
    const audited = await lastAudit('call.avatar_session');
    expect(audited).toMatchObject({ outcome: 'succeeded', objectType: 'call', objectId: callId });
    expect(audited.metadata).toEqual({ provider: 'fake', voicing: 'audio' });
    expect(audited.raw).not.toContain(minted.token ?? 'never');

    await h.core.calls.end(ctx.maya, callId, { reason: 'user' });
    // An ended call opens no face.
    await expect(session('maya', callId)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'call_not_active',
    });
  });

  it("refuses a face for someone else's call", async () => {
    const callId = await startCall('maya');
    try {
      await expect(session('devin', callId)).rejects.toMatchObject({
        code: 'conflict',
        reason: 'call_not_active',
      });
    } finally {
      await h.core.calls.end(ctx.maya, callId, { reason: 'user' });
    }
  });

  it('keeps the presence when the vendor is down or the call is about to end', async () => {
    const callId = await startCall('maya');
    try {
      face.failNext = true;
      expect(await session('maya', callId)).toMatchObject({
        provider: 'builtin',
        token: null,
        voicing: 'engine',
      });
      expect((await lastAudit('call.avatar_session')).outcome).toBe('failed');

      // Less than MIN_FACE_SECONDS left: not worth a vendor session.
      await backdate(callId, 30 * 60 - (MIN_FACE_SECONDS - 5));
      const calls = face.calls.length;
      expect(await session('maya', callId)).toMatchObject({ provider: 'builtin', token: null });
      expect(face.calls.length).toBe(calls);
      expect((await lastAudit('call.avatar_session')).outcome).toBe('denied');
    } finally {
      await h.core.calls.end(ctx.maya, callId, { reason: 'user' });
    }
  });

  it('applies the call switches before any vendor round trip', async () => {
    const callId = await startCall('maya');
    const calls = face.calls.length;
    await callsEnabled(false);
    try {
      await expect(session('maya', callId)).rejects.toMatchObject({
        code: 'ai_disabled',
        reason: 'calls_disabled',
      });
      expect(face.calls.length).toBe(calls);
    } finally {
      await callsEnabled(true);
      await h.core.calls.end(ctx.maya, callId, { reason: 'user' });
    }
  });
});
