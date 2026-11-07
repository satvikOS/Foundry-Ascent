/**
 * Call recordings (migration 0031): only a person's own call in a remembered conversation can be recorded, nobody
 * else ever sees the recording (not the venture's team, its EIR or a program lead), its files and size never change,
 * deleting it or its conversation deletes it, and the purge reads find exactly the files still to remove.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as callsRepo from './calls.js';
import * as recordingsRepo from './recordings.js';
import * as sessionsRepo from './sessions.js';

let t: TestDatabase;
let seed: SeedResult;
type Ctx = ReturnType<typeof makeContext>;
let maya: Ctx;
let devin: Ctx;
let corin: Ctx;
let lead: Ctx;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

const quietquad = (): SeedResult['ventures'][number] =>
  must(seed.ventures.find((v) => v.key === 'quietquad'));

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof DbError) return err.sqlState;
    throw err;
  }
}

async function newSession(ctx: Ctx, privacy: 'standard' | 'ephemeral' = 'standard'): Promise<string> {
  const v = quietquad();
  return t.db.withContext(ctx, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, v.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: v.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: ctx.principalId,
      mode: 'coach',
      privacy,
      policyVersion: 'test',
    });
    return session.id;
  });
}

async function callIn(ctx: Ctx, sessionId: string): Promise<callsRepo.CallRecord> {
  const v = quietquad();
  return t.db.withContext(ctx, async (tx) => {
    const call = await callsRepo.startCall(tx, {
      tenantId: seed.tenantId,
      ventureId: v.id,
      sessionId,
      personaId: v.personaId,
      startedBy: ctx.principalId,
      provider: 'builtin',
      inputMode: 'typed',
      voiceId: 'Matthew',
      maxSeconds: 1800,
    });
    await callsRepo.endCall(tx, { callId: call.id, reason: 'user', detail: 'client_user' });
    return call;
  });
}

function input(
  ctx: Ctx,
  call: callsRepo.CallRecord,
  overrides: Partial<recordingsRepo.CreateRecordingInput> = {},
): recordingsRepo.CreateRecordingInput {
  const id = overrides.id ?? randomUUID();
  const prefix = `tenants/${seed.tenantId}/ventures/${call.ventureId}/sessions/${call.sessionId}/recordings/${id}`;
  return {
    id,
    tenantId: seed.tenantId,
    ventureId: call.ventureId,
    sessionId: call.sessionId,
    callId: call.id,
    recordedBy: ctx.principalId,
    mimeType: 'video/webm',
    bytes: 1_024,
    durationMs: 12_000,
    storageKey: `${prefix}/call.webm`,
    captions: { key: `${prefix}/captions.vtt`, bytes: 120, cues: 3 },
    ...overrides,
  };
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  seed = must(t.seed);
  const ctx = (key: string): Ctx => makeContext(must(seed.principals[key]), seed.tenantId);
  maya = ctx('maya');
  devin = ctx('devin');
  corin = ctx('eir-corin');
  lead = makeContext(must(seed.programLeadId), seed.tenantId);
});
afterAll(async () => {
  await t.cleanup();
});

describe('call recordings (0031)', () => {
  it('a founder records their own call; only they see it, ready once its files arrived', async () => {
    const session = await newSession(maya);
    const call = await callIn(maya, session);
    const created = await t.db.withContext(maya, (tx) =>
      recordingsRepo.createRecording(tx, input(maya, call)),
    );
    expect(created).toMatchObject({
      status: 'pending',
      completedAt: null,
      cues: 3,
      recordedBy: maya.principalId,
    });
    expect(recordingsRepo.toRecordingView(created)).toMatchObject({ kind: 'video', hasCaptions: true });

    // Pending recordings are never listed.
    expect(
      await t.db.withContext(maya, (tx) => recordingsRepo.listRecordings(tx, { sessionId: session })),
    ).toEqual([]);
    const ready = must(await t.db.withContext(maya, (tx) => recordingsRepo.markReady(tx, created.id)));
    expect(ready.status).toBe('ready');
    expect(ready.completedAt).not.toBeNull();
    // Ready once: a second completion changes nothing.
    expect(await t.db.withContext(maya, (tx) => recordingsRepo.markReady(tx, created.id))).toBeNull();

    const listed = await t.db.withContext(maya, (tx) =>
      recordingsRepo.listRecordings(tx, { sessionId: session }),
    );
    expect(listed.map((r) => r.id)).toEqual([created.id]);
    expect(
      (
        await t.db.withContext(maya, (tx) => recordingsRepo.listRecordings(tx, { ventureId: quietquad().id }))
      ).map((r) => r.id),
    ).toContain(created.id);
    expect(await t.db.withContext(maya, (tx) => recordingsRepo.recordingsToday(tx, maya.principalId))).toBe(
      1,
    );

    // Nobody else: the venture's team member, its EIR, the program lead.
    for (const other of [devin, corin, lead]) {
      expect(await t.db.withContext(other, (tx) => recordingsRepo.getRecording(tx, created.id))).toBeNull();
      expect(await t.db.withContext(other, (tx) => recordingsRepo.listRecordings(tx))).toEqual([]);
      expect(
        await t.db.withContext(other, (tx) => recordingsRepo.softDeleteRecording(tx, created.id, 'founder')),
      ).toBe(null);
    }
  });

  it('refuses someone else’s call, a private conversation, a deleted one and an unsupported container', async () => {
    const session = await newSession(maya);
    const call = await callIn(maya, session);
    // Devin works on the venture, but the call is Maya's.
    expect(
      await sqlState(t.db.withContext(devin, (tx) => recordingsRepo.createRecording(tx, input(devin, call)))),
    ).toBe('42501');
    // Recording as someone else.
    expect(
      await sqlState(
        t.db.withContext(devin, (tx) =>
          recordingsRepo.createRecording(tx, input(devin, call, { recordedBy: maya.principalId })),
        ),
      ),
    ).toBe('42501');

    const temporary = await newSession(maya, 'ephemeral');
    const privateCall = await callIn(maya, temporary);
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) => recordingsRepo.createRecording(tx, input(maya, privateCall))),
      ),
    ).toBe('42501');

    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          recordingsRepo.createRecording(
            tx,
            input(maya, call, { mimeType: 'video/x-matroska' as 'video/webm' }),
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          recordingsRepo.createRecording(tx, input(maya, call, { storageKey: 'elsewhere/call.webm' })),
        ),
      ),
    ).toBe('23514');

    const gone = await newSession(maya);
    const goneCall = await callIn(maya, gone);
    await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, gone));
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) => recordingsRepo.createRecording(tx, input(maya, goneCall))),
      ),
    ).toBe('42501');
  });

  it('a recording’s files never change; deleted stays deleted; purged stays purged', async () => {
    const session = await newSession(maya);
    const call = await callIn(maya, session);
    const created = await t.db.withContext(maya, (tx) =>
      recordingsRepo.createRecording(tx, input(maya, call)),
    );
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          tx.query("UPDATE call_recordings SET storage_key = 'tenants/x/call.webm' WHERE id = :id", {
            id: p.uuid(created.id),
          }),
        ),
      ),
    ).toBe('55000');
    expect(
      must(
        await t.db.withContext(maya, (tx) => recordingsRepo.softDeleteRecording(tx, created.id, 'founder')),
      ).deletedReason,
    ).toBe('founder');
    expect(
      await t.db.withContext(maya, (tx) => recordingsRepo.softDeleteRecording(tx, created.id, 'founder')),
    ).toBe(null);
    expect(await t.db.withContext(maya, (tx) => recordingsRepo.markReady(tx, created.id))).toBeNull();

    const purgeable = await t.db.system((sx) =>
      recordingsRepo.listPurgeable(sx, { limit: 10, id: created.id }),
    );
    expect(purgeable).toEqual([
      {
        id: created.id,
        tenantId: seed.tenantId,
        ventureId: call.ventureId,
        storageKey: created.storageKey,
        captionsKey: created.captionsKey,
      },
    ]);
    expect(await t.db.system((sx) => recordingsRepo.markPurged(sx, [created.id]))).toBe(1);
    expect(await t.db.system((sx) => recordingsRepo.markPurged(sx, [created.id]))).toBe(0);
    expect(
      await t.db.system((sx) => recordingsRepo.listPurgeable(sx, { limit: 10, id: created.id })),
    ).toEqual([]);
  });

  it('deleting the conversation deletes every recording of it, whoever deletes it', async () => {
    const session = await newSession(maya);
    const call = await callIn(maya, session);
    const first = await t.db.withContext(maya, (tx) => recordingsRepo.createRecording(tx, input(maya, call)));
    await t.db.withContext(maya, (tx) => recordingsRepo.markReady(tx, first.id));
    const second = await t.db.withContext(maya, (tx) =>
      recordingsRepo.createRecording(tx, input(maya, call, { captions: null, mimeType: 'audio/mp4' })),
    );
    // Devin (team) deletes the conversation: he cannot see Maya's recordings, yet they go with it.
    expect(await t.db.withContext(devin, (tx) => sessionsRepo.softDeleteSession(tx, session))).toBe(true);
    const after = await t.db.withContext(maya, async (tx) => [
      await recordingsRepo.getRecording(tx, first.id),
      await recordingsRepo.getRecording(tx, second.id),
    ]);
    expect(after.map((r) => r?.deletedReason)).toEqual(['conversation', 'conversation']);
    expect(
      await t.db.withContext(maya, (tx) => recordingsRepo.listRecordings(tx, { sessionId: session })),
    ).toEqual([]);
    const purgeable = await t.db.system((sx) =>
      recordingsRepo.listPurgeable(sx, { limit: 10, sessionId: session }),
    );
    expect(purgeable.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    expect(purgeable.find((r) => r.id === second.id)?.captionsKey).toBeNull();
  });

  it('abandons uploads nobody finished', async () => {
    const session = await newSession(maya);
    const call = await callIn(maya, session);
    const created = await t.db.withContext(maya, (tx) =>
      recordingsRepo.createRecording(tx, input(maya, call)),
    );
    expect(
      await t.db.system((sx) => recordingsRepo.abandonStalePending(sx, { olderThanSeconds: 3_600 })),
    ).toBe(0);
    await t.db.system((sx) =>
      sx.query("UPDATE call_recordings SET created_at = now() - interval '2 hours' WHERE id = :id", {
        id: p.uuid(created.id),
      }),
    );
    expect(
      await t.db.system((sx) => recordingsRepo.abandonStalePending(sx, { olderThanSeconds: 3_600 })),
    ).toBe(1);
    expect(
      must(await t.db.withContext(maya, (tx) => recordingsRepo.getRecording(tx, created.id))).deletedReason,
    ).toBe('abandoned');
  });
});
