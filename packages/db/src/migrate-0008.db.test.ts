/**
 * Migration 0008 (calls) on top of the schema production has, with data the previous code wrote: it applies
 * cleanly as the non-superuser owner, leaves existing turns and settings as they were (expand-only: the previous
 * code keeps working), and re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, sessionsRepo, turnsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const CALLS = MIGRATIONS.find((m) => m.version === '0008_calls');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0008');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
let legacy: { session: string; turns: string[] };

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

/** Policies, functions, constraints, indexes, triggers and settings, as text: equal before and after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT tablename, policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
           FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`,
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
      `SELECT tgname, tgrelid::regclass::text AS rel FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
      `SELECT key, value::text AS value FROM platform_settings ORDER BY key`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

/** A conversation with a typed and a spoken turn, written the way the previous code writes them. */
async function writeLegacyData(db: Db): Promise<typeof legacy> {
  const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
  const maya = makeContext(must(seed.principals.maya), seed.tenantId);
  return db.withContext(maya, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: quietquad.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: maya.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'legacy',
    });
    const turns: string[] = [];
    for (const channel of ['text', 'voice'] as const) {
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        sessionId: session.id,
        authorId: maya.principalId,
        mode: 'coach',
        founderText: `A ${channel} message`,
        channel,
      });
      turns.push(turn.id);
    }
    return { session: session.id, turns };
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  legacy = await writeLegacyData(t.db);
  // An administrator already switched calls off: the migration must not switch them back on.
  await t.db.system((sx) =>
    sx.query(`INSERT INTO platform_settings (key, value) VALUES ('calls_enabled', 'false')
              ON CONFLICT (key) DO UPDATE SET value = 'false'`),
  );
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0008_calls', () => {
  it('applies cleanly on top of the earlier migrations with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(['0008_calls']);
    expect(CALLS && splitStatements(CALLS.sql).length).toBeGreaterThan(20);
  });

  it('leaves existing turns and settings as they were', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT channel, call_id, heard_seq, interrupted_at FROM turns WHERE id = ANY (:ids) ORDER BY ordinal`,
        { ids: p.uuidArray(legacy.turns) },
      ),
    );
    expect(rows.rows).toEqual([
      { channel: 'text', call_id: null, heard_seq: null, interrupted_at: null },
      { channel: 'voice', call_id: null, heard_seq: null, interrupted_at: null },
    ]);
    const setting = await t.db.system((sx) =>
      sx.query(`SELECT value::text AS value FROM platform_settings WHERE key = 'calls_enabled'`),
    );
    expect(setting.rows).toEqual([{ value: 'false' }]);
  });

  it('keeps the previous code working: turns written without a call, the previous minute accounting', async () => {
    const maya = makeContext(must(seed.principals.maya), seed.tenantId);
    await t.db.withContext(maya, async (tx) => {
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId: must(seed.ventures.find((v) => v.key === 'quietquad')).id,
        sessionId: legacy.session,
        authorId: maya.principalId,
        mode: 'coach',
        founderText: 'Still works',
        channel: 'voice',
      });
      expect(turn.channel).toBe('voice');
      const spoken = await tx.query('SELECT count(*)::int AS n FROM app.voice_turns_today()');
      expect(spoken.rows[0]).toEqual({ n: 2 });
    });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!CALLS) throw new Error('0008 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(CALLS.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
