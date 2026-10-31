/**
 * Migration 0018 (the face's mode) on top of the schema production has, with a face the previous code wrote: it
 * applies cleanly as the non-superuser owner; that face is `lite`; a FULL face admits each unit once and in order
 * (later units of the reply it is saying, or a reply it never said), keeps only digests of the words, owner-only;
 * its transcript reconciliation remembers where it is and since when lines are pending; a unit can be reserved for
 * the face apart from its own play; and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, callsRepo, sessionsRepo, twinRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const MODE = MIGRATIONS.find((m) => m.version === '0018_face_mode');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0018');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const TURN_A = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const TURN_B = '8e2f3d5f-2b3c-4d4e-9fa0-1b2c3d4e5f60';
const DIGEST = 'a'.repeat(64);

let t: TestDatabase;
let seed: SeedResult;
let oldFaceCall: string;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof DbError) return err.sqlState;
    throw err;
  }
}

const ctx = (key: string) => makeContext(must(seed.principals[key]), seed.tenantId);

/** A live call of `who` in a new conversation of quietquad. */
async function liveCall(who: ReturnType<typeof ctx>): Promise<callsRepo.CallRecord> {
  const venture = must(seed.ventures.find((v) => v.key === 'quietquad'));
  return t.db.withContext(who, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, venture.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: who.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    return callsRepo.startCall(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      sessionId: session.id,
      personaId: venture.personaId,
      startedBy: who.principalId,
      provider: 'builtin',
      inputMode: 'typed',
      voiceId: 'Matthew',
      maxSeconds: 1800,
    });
  });
}

/** call_faces, call_face_texts and call_speech constraints, columns and grants: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid IN ('public.call_faces'::regclass, 'public.call_face_texts'::regclass,
                             'public.call_speech'::regclass)
          ORDER BY 1, 2`,
      `SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
          WHERE table_name IN ('call_faces', 'call_face_texts') ORDER BY 1, 2`,
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
          WHERE grantee = 'app_rls' AND table_name IN ('call_faces', 'call_face_texts') ORDER BY 1, 2`,
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('call_faces', 'call_face_texts') ORDER BY 1`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  // A face the previous code wrote (no mode yet).
  const maya = ctx('maya');
  const call = await liveCall(maya);
  oldFaceCall = call.id;
  await t.db.system((sx) =>
    sx.query(
      `INSERT INTO call_faces (call_id, tenant_id, started_by, vendor, session_ref, max_seconds)
       VALUES (:call, :t, :me, 'heygen', 'sess-old', 600)`,
      { call: p.uuid(call.id), t: p.uuid(seed.tenantId), me: p.uuid(maya.principalId) },
    ),
  );
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

/** A transcript check that read from the start and verified nothing (fields overridden per case). */
function record(callId: string): Parameters<typeof twinRepo.recordFaceTranscript>[1] {
  return {
    callId,
    from: { at: null, skip: 0 },
    cursor: { at: null, skip: 0 },
    added: 0,
    said: new Map(),
    pending: false,
    complete: true,
  };
}

describe('migration 0018_face_mode', () => {
  it('applies cleanly on top of the earlier migrations with a face, which stays LITE', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(['0018_face_mode']);
    expect(MODE && splitStatements(MODE.sql).length).toBeGreaterThanOrEqual(10);
    const old = must(await t.db.system((sx) => twinRepo.getCallFace(sx, oldFaceCall)));
    expect(old).toMatchObject({
      mode: 'lite',
      transcriptVerified: 0,
      transcriptPending: null,
      transcriptCursor: null,
      transcriptSkip: 0,
    });
    // A LITE face never takes text, and has no transcript to reconcile.
    expect(
      await t.db.system((sx) =>
        twinRepo.admitFaceText(sx, {
          callId: oldFaceCall,
          sessionRef: 'sess-old',
          unit: 'intro',
          turnKey: 'intro',
          seq: 0,
          digests: [DIGEST],
          wholes: 1,
        }),
      ),
    ).toBe(false);
    expect(await t.db.system((sx) => twinRepo.recordFaceTranscript(sx, record(oldFaceCall)))).toBeNull();
    // A LITE face keeps no transcript state.
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(`UPDATE call_faces SET transcript_cursor = 5 WHERE call_id = :id`, {
            id: p.uuid(oldFaceCall),
          }),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(`UPDATE call_faces SET mode = 'medium' WHERE call_id = :id`, { id: p.uuid(oldFaceCall) }),
        ),
      ),
    ).toBe('23514');
    await t.db.withContext(ctx('maya'), (tx) =>
      callsRepo.endCall(tx, { callId: oldFaceCall, reason: 'user', detail: 'client_user' }),
    );
  });

  it('admits each unit to a FULL face once and in order, as digests, owner-only', async () => {
    const maya = ctx('maya');
    const call = await liveCall(maya);
    const face = must(
      await t.db.system((sx) =>
        twinRepo.startCallFace(sx, {
          callId: call.id,
          startedBy: maya.principalId,
          vendor: 'heygen',
          mode: 'full',
          sessionRef: 'sess-full',
          control: null,
          maxSeconds: 600,
        }),
      ),
    );
    expect(face).toMatchObject({ mode: 'full', control: null });
    const admit = (turnKey: string, seq: number, sessionRef = 'sess-full', digests = [DIGEST], wholes = 1) =>
      t.db.system((sx) =>
        twinRepo.admitFaceText(sx, {
          callId: call.id,
          sessionRef,
          unit: turnKey === 'intro' ? 'intro' : `unit.${turnKey}.${String(seq)}`,
          turnKey,
          seq,
          digests,
          wholes,
        }),
      );
    expect(await admit('intro', 0, 'another-session')).toBe(false);
    expect(await admit('intro', 0)).toBe(true);
    expect(await admit('intro', 0)).toBe(false); // replayed
    expect(await admit(TURN_A, 1, 'sess-full', [DIGEST, 'b'.repeat(64)])).toBe(true);
    expect(await admit(TURN_A, 0)).toBe(false); // reordered: an earlier unit after a later one
    expect(await admit(TURN_A, 1)).toBe(false); // replayed
    expect(await admit(TURN_A, 3)).toBe(true); // a later unit (one may be skipped: barge-in, a failure)
    expect(await admit(TURN_B, 0)).toBe(true); // the next reply
    expect(await admit(TURN_A, 4)).toBe(false); // never back to a reply it left
    expect(await admit('intro', 0)).toBe(false);
    // Only digests are kept, and only the owner role reads them.
    expect(await sqlState(admit(TURN_B, 1, 'sess-full', ['not a digest']))).toBe('23514');
    // More whole digests than digests.
    expect(await sqlState(admit(TURN_B, 1, 'sess-full', [DIGEST], 2))).toBe('23514');
    const units = await t.db.system((sx) => twinRepo.faceTextUnits(sx, call.id));
    expect(units).toEqual([
      { unit: 'intro', digests: [DIGEST], wholes: 1, said: 0 },
      { unit: `unit.${TURN_A}.1`, digests: [DIGEST, 'b'.repeat(64)], wholes: 1, said: 0 },
      { unit: `unit.${TURN_A}.3`, digests: [DIGEST], wholes: 1, said: 0 },
      { unit: `unit.${TURN_B}.0`, digests: [DIGEST], wholes: 1, said: 0 },
    ]);
    expect(await sqlState(t.db.withContext(maya, (tx) => tx.query('SELECT * FROM call_face_texts')))).toBe(
      '42501',
    );
    const rows = await t.db.system((sx) =>
      sx.query('SELECT unit FROM call_face_texts WHERE call_id = :id ORDER BY ord', { id: p.uuid(call.id) }),
    );
    expect(rows.rows.map((r) => r.unit)).toEqual([
      'intro',
      `unit.${TURN_A}.1`,
      `unit.${TURN_A}.3`,
      `unit.${TURN_B}.0`,
    ]);

    // The transcript reconciliation: where the last check stopped, what each unit said, since when lines are
    // pending, and when the transcript was last read to its end. A check records only if no other moved the cursor.
    const save = (input: Partial<Parameters<typeof twinRepo.recordFaceTranscript>[1]>) =>
      t.db.system((sx) => twinRepo.recordFaceTranscript(sx, { ...record(call.id), ...input }));
    expect(
      await save({ cursor: { at: 1761900012, skip: 2 }, added: 3, said: new Map([['intro', 1]]) }),
    ).toEqual({ pending: null });
    // Another check that read before that one: refused, nothing changes.
    expect(await save({ cursor: { at: 1761900099, skip: 1 }, added: 9 })).toBeNull();
    expect(
      await save({
        from: { at: 1761900012, skip: 2 },
        cursor: { at: 1761900020.5, skip: 1 },
        added: 1,
        said: new Map([[`unit.${TURN_A}.1`, 2]]),
        pending: true,
        complete: false,
      }),
    ).toEqual({ pending: 0 });
    await t.db.system((sx) =>
      sx.query(
        `UPDATE call_faces SET transcript_pending_since = now() - interval '40 seconds',
                               transcript_checked_at = now() - interval '70 seconds' WHERE call_id = :id`,
        { id: p.uuid(call.id) },
      ),
    );
    const after = must(await t.db.system((sx) => twinRepo.getCallFace(sx, call.id)));
    expect(after).toMatchObject({ transcriptVerified: 4, transcriptCursor: 1761900020.5, transcriptSkip: 1 });
    expect(after.transcriptPending).toBeGreaterThanOrEqual(40);
    expect(after.transcriptUnchecked).toBeGreaterThanOrEqual(70);
    expect((await t.db.system((sx) => twinRepo.faceTextUnits(sx, call.id))).map((unit) => unit.said)).toEqual(
      [1, 2, 0, 0],
    );
    // Bits only ever add; a bit past the unit's digests is refused.
    expect(
      await save({
        from: { at: 1761900020.5, skip: 1 },
        cursor: { at: 1761900020.5, skip: 1 },
        said: new Map([['intro', 1]]),
      }),
    ).toEqual({ pending: null });
    expect(
      must(await t.db.system((sx) => twinRepo.getCallFace(sx, call.id))).transcriptUnchecked,
    ).toBeLessThan(5);
    expect(
      await sqlState(
        save({
          from: { at: 1761900020.5, skip: 1 },
          cursor: { at: 1761900020.5, skip: 1 },
          said: new Map([['intro', 2]]),
        }),
      ),
    ).toBe('23514');

    // Metering names the face's mode (it decides the price).
    expect(must(await t.db.system((sx) => twinRepo.meterCallFace(sx, call.id))).mode).toBe('full');

    // An ended face takes nothing more; its digests go with the call.
    await t.db.withContext(maya, (tx) =>
      callsRepo.endCall(tx, { callId: call.id, reason: 'user', detail: 'client_user' }),
    );
    expect(await admit(TURN_B, 2)).toBe(false);
    const ended = must(await t.db.system((sx) => twinRepo.getCallFace(sx, call.id)));
    expect(ended).toMatchObject({ mode: 'full', endReason: 'call_ended' });
  });

  it('reserves a unit for the face apart from its own play', async () => {
    const maya = ctx('maya');
    const call = await liveCall(maya);
    const budget = { charactersPerSecond: 15, headroomCharacters: 2000, dailyCharacters: 54_000 };
    const reserve = (unit: callsRepo.SpeechUnitKey) =>
      t.db.system((sx) =>
        callsRepo.reserveCallSpeech(sx, {
          callId: call.id,
          principalId: maya.principalId,
          unit,
          characters: 40,
          maxPlays: 1,
          budget,
        }),
      );
    expect(await reserve({ kind: 'unit', turnId: TURN_A, seq: 0 })).toEqual({ ok: true, plays: 1 });
    expect(await reserve({ kind: 'face', turnId: TURN_A, seq: 0 })).toEqual({ ok: true, plays: 1 });
    expect(await reserve({ kind: 'face', turnId: TURN_A, seq: 0 })).toEqual({
      ok: false,
      reason: 'already_played',
    });
    expect(await reserve({ kind: 'face', turnId: null, seq: 0 })).toEqual({ ok: true, plays: 1 });
    const units = await t.db.system((sx) =>
      sx.query('SELECT unit FROM call_speech WHERE call_id = :id ORDER BY unit', { id: p.uuid(call.id) }),
    );
    expect(units.rows.map((r) => r.unit)).toEqual([`face.${TURN_A}.0`, 'face.intro', `unit.${TURN_A}.0`]);
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(
            `INSERT INTO call_speech (call_id, unit, plays, characters) VALUES (:id, 'face.x', 1, 1)`,
            {
              id: p.uuid(call.id),
            },
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!MODE) throw new Error('0018 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(MODE.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
