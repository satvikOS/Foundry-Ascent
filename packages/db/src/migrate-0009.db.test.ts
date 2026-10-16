/**
 * Migration 0009 (fixes from the review of 5105c40) on top of the schema 0008 leaves, with data the previous
 * code wrote: it applies cleanly as the non-superuser owner, keeps existing rows as they were (an opener copy
 * of unknown origin stays unknown, nothing counts as an unusable answer), keeps the previous code's writes
 * working (expand-only), and re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const REVIEW = MIGRATIONS.find((m) => m.version === '0009_review_privacy');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0009');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
let legacy: string;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

/** Functions, constraints, indexes and triggers, as text: equal before and after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
              coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def, convalidated
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`,
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
      `SELECT tgname, tgrelid::regclass::text AS rel, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
      `SELECT column_name, data_type, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'coaching_sessions' ORDER BY 1`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

/** The columns the previous code's createSession wrote: a conversation opened with a copied opener. */
async function insertAsBefore(db: Db, opener: string | null): Promise<string> {
  const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
  const maya = makeContext(must(seed.principals.maya), seed.tenantId);
  return db.withContext(maya, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
    const r = await tx.query(
      `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                      privacy, policy_version, title_source, opener, opener_source_session_id)
       VALUES (:t, :v, :a, :r, :me, 'coach', 'standard', 'legacy', 'auto', :opener, NULL)
       RETURNING id`,
      {
        t: p.uuid(seed.tenantId),
        v: p.uuid(quietquad.id),
        a: p.uuid(resolved.assignment.id),
        r: p.uuid(must(resolved.release).id),
        me: p.uuid(maya.principalId),
        opener: p.nullable.text(opener),
      },
    );
    return String(r.rows[0]?.id);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  legacy = await insertAsBefore(t.db, 'Last time you planned five interviews. How did they go?');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0009_review_privacy', () => {
  it('applies cleanly on top of the earlier migrations with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    // The later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0009'));
    expect(report.applied[0]).toBe('0009_review_privacy');
    expect(REVIEW && splitStatements(REVIEW.sql).length).toBeGreaterThan(15);
  });

  it('keeps existing rows as they were: a copied opener stays of unknown origin, no unusable answers', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT opener IS NOT NULL AS opener, opener_by_person, distill_unusable_answers
         FROM coaching_sessions WHERE id = :id`,
        { id: p.uuid(legacy) },
      ),
    );
    expect(rows.rows).toEqual([{ opener: true, opener_by_person: false, distill_unusable_answers: 0 }]);
  });

  it('keeps the previous code working: its conversation insert, and a turn on it', async () => {
    const id = await insertAsBefore(t.db, null);
    const maya = makeContext(must(seed.principals.maya), seed.tenantId);
    await t.db.withContext(maya, (tx) =>
      tx.query(
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text)
         SELECT s.tenant_id, s.venture_id, s.id, 1, :me, 'coach', 'Still works' FROM coaching_sessions s WHERE s.id = :id`,
        { id: p.uuid(id), me: p.uuid(maya.principalId) },
      ),
    );
    const title = await t.db.system((sx) =>
      sx.query('SELECT title FROM coaching_sessions WHERE id = :id', { id: p.uuid(id) }),
    );
    expect(title.rows).toEqual([{ title: 'Still works' }]);
  });

  it('adds its checks without scanning the table, and enforces them on every later write', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT conname, convalidated FROM pg_constraint
         WHERE conname IN ('coaching_sessions_opener_origin_check', 'coaching_sessions_distill_unusable_answers_check')
         ORDER BY conname`,
      ),
    );
    expect(r.rows).toEqual([
      { conname: 'coaching_sessions_distill_unusable_answers_check', convalidated: false },
      { conname: 'coaching_sessions_opener_origin_check', convalidated: false },
    ]);
    await expect(
      t.db.system((sx) =>
        sx.query('UPDATE coaching_sessions SET distill_unusable_answers = -1 WHERE id = :id', {
          id: p.uuid(legacy),
        }),
      ),
    ).rejects.toMatchObject({ sqlState: '23514' });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!REVIEW) throw new Error('0009 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(REVIEW.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
