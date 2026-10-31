/**
 * Migration 0020 (face pre-approval) on top of the schema production has, with a FULL face and a unit the previous
 * code admitted: it applies cleanly as the non-superuser owner; that unit stays not pre-approved; a unit the turn
 * engine admits as it signs it is marked pre-approved, and only such a unit, with the same digests, on the same live
 * face, is found again for `face/say`; the column stays owner-only like the table; and the file re-runs without
 * changes.
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

const PREAPPROVAL = MIGRATIONS.find((m) => m.version === '0020_face_preapproval');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0020');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const TURN = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

let t: TestDatabase;
let seed: SeedResult;
let callId: string;

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

/** call_face_texts' columns, constraints and grants: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.call_face_texts'::regclass ORDER BY 1`,
      `SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
          WHERE table_name = 'call_face_texts' ORDER BY 1`,
      `SELECT privilege_type FROM information_schema.table_privileges
          WHERE grantee = 'app_rls' AND table_name = 'call_face_texts' ORDER BY 1`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

const admit = (unit: string, seq: number, digests: string[], preapproved: boolean) =>
  t.db.system((sx) =>
    twinRepo.admitFaceText(sx, {
      callId,
      sessionRef: 'sess-full',
      unit,
      turnKey: TURN,
      seq,
      digests,
      wholes: 1,
      preapproved,
    }),
  );

const found = (unit: string, digests: string[], sessionRef = 'sess-full') =>
  t.db.system((sx) => twinRepo.preapprovedFaceText(sx, { callId, sessionRef, unit, digests }));

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  const maya = ctx('maya');
  const venture = must(seed.ventures.find((v) => v.key === 'quietquad'));
  const call = await t.db.withContext(maya, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, venture.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: maya.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    return callsRepo.startCall(tx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      sessionId: session.id,
      personaId: venture.personaId,
      startedBy: maya.principalId,
      provider: 'builtin',
      inputMode: 'typed',
      voiceId: 'Matthew',
      maxSeconds: 1800,
    });
  });
  callId = call.id;
  // A FULL face and a unit the previous code admitted (through face/say), as it wrote them.
  await t.db.system(async (sx) => {
    await sx.query(
      `INSERT INTO call_faces (call_id, tenant_id, started_by, vendor, session_ref, max_seconds, mode,
                               said_turn, said_seq)
       VALUES (:call, :t, :me, 'heygen', 'sess-full', 600, 'full', :turn, 0)`,
      { call: p.uuid(callId), t: p.uuid(seed.tenantId), me: p.uuid(maya.principalId), turn: p.text(TURN) },
    );
    await sx.query(
      `INSERT INTO call_face_texts (call_id, unit, turn_key, seq, digests, wholes)
       VALUES (:call, :unit, :turn, 0, :digests, 1)`,
      { call: p.uuid(callId), unit: p.text(`unit.${TURN}.0`), turn: p.text(TURN), digests: p.textArray([A]) },
    );
  });
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0020_face_preapproval', () => {
  it('applies cleanly on top of the earlier migrations with an admitted unit, which is not pre-approved', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0020'));
    expect(report.applied[0]).toBe('0020_face_preapproval');
    expect(PREAPPROVAL && splitStatements(PREAPPROVAL.sql).length).toBe(2);
    const rows = await t.db.system((sx) =>
      sx.query(`SELECT unit, preapproved FROM call_face_texts WHERE call_id = :call`, {
        call: p.uuid(callId),
      }),
    );
    expect(rows.rows).toEqual([{ unit: `unit.${TURN}.0`, preapproved: false }]);
    expect(await found(`unit.${TURN}.0`, [A])).toBe(false);
  });

  it('marks a unit the turn engine admitted, and finds only that one, with its digests, on its live face', async () => {
    // In order and once, as before: a pre-approved unit takes the same path.
    expect(await admit(`unit.${TURN}.1`, 1, [B, C], true)).toBe(true);
    expect(await admit(`unit.${TURN}.1`, 1, [B, C], true)).toBe(false);
    expect(await admit(`unit.${TURN}.0`, 0, [A], true)).toBe(false);
    expect(await found(`unit.${TURN}.1`, [B, C])).toBe(true);
    // Other words, a part of them, another face session, or a unit face/say admitted: never.
    expect(await found(`unit.${TURN}.1`, [B])).toBe(false);
    expect(await found(`unit.${TURN}.1`, [C, B])).toBe(false);
    expect(await found(`unit.${TURN}.1`, [B, C], 'sess-other')).toBe(false);
    expect(await found(`unit.${TURN}.0`, [A])).toBe(false);
    expect(await found(`unit.${TURN}.2`, [B, C])).toBe(false);
    // Owner role only, like the rest of the table.
    expect(
      await sqlState(
        t.db.withContext(ctx('maya'), (tx) => tx.query(`SELECT preapproved FROM call_face_texts LIMIT 1`)),
      ),
    ).toBe('42501');
    // Once the face ends, nothing is confirmed for it any more.
    await t.db.system((sx) =>
      sx.query(`UPDATE call_faces SET ended_at = now() WHERE call_id = :call`, { call: p.uuid(callId) }),
    );
    expect(await found(`unit.${TURN}.1`, [B, C])).toBe(false);
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!PREAPPROVAL) throw new Error('0020 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(PREAPPROVAL.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
    const kept = await t.db.system((sx) =>
      sx.query(`SELECT count(*) FILTER (WHERE preapproved)::int AS n FROM call_face_texts`),
    );
    expect(kept.rows[0]).toEqual({ n: 1 });
  });
});
