/**
 * Migration 0015 (the index for the per-person turn limits) on top of the schema production has, with turns
 * the previous code wrote: it applies cleanly as the non-superuser owner, the limit counts read it and still
 * count what they did, and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { turnsRepo } from './repositories/index.js';
import { seedDatabase, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const INDEX = MIGRATIONS.find((m) => m.version === '0015_turn_admission_index');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0015');

let t: TestDatabase;
let seed: SeedResult;
let maya: string;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

/** Turns of the seeded conversation by `author`: `recent` in the last minutes, `old` a day ago, some pending. */
async function writeTurns(author: string, recent: number, old: number): Promise<void> {
  await t.db.system((sx) =>
    sx.query(
      `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status, channel,
                          created_at)
       SELECT s.tenant_id, s.venture_id, s.id,
              (SELECT coalesce(max(ordinal), 0) FROM turns WHERE session_id = s.id) + g, :author, 'coach', 'x',
              CASE WHEN g % 2 = 0 THEN 'pending' ELSE 'completed' END, 'text',
              CASE WHEN g <= :recent THEN now() - interval '1 minute' ELSE now() - interval '1 day' END
       FROM (SELECT * FROM coaching_sessions ORDER BY id LIMIT 1) s, generate_series(1, :total) g`,
      { author: p.uuid(author), recent: p.int(recent), total: p.int(recent + old) },
    ),
  );
}

const counts = () =>
  t.db.withContext(makeContext(maya, seed.tenantId), async (tx) => ({
    recent: await turnsRepo.countRecentTurnsByAuthor(tx, {
      authorId: maya,
      windowSeconds: 600,
      channel: 'text',
    }),
    pending: await turnsRepo.countPendingTurnsByAuthor(tx, { authorId: maya, withinSeconds: 600 }),
  }));

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null });
  maya = must(seed.principals.maya);
  await writeTurns(maya, 4, 6);
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0015_turn_admission_index', () => {
  it('applies cleanly on top of the earlier migrations with existing turns, as the non-superuser owner', async () => {
    const before = await counts();
    const report = await migrate(t.db);
    // Later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0015'));
    expect(report.applied[0]).toBe('0015_turn_admission_index');
    // The limits count exactly what they counted before.
    expect(await counts()).toEqual(before);
    expect(before).toEqual({ recent: 4, pending: 2 });
  });

  it('serves both per-person counts from the author index', async () => {
    const plans = await t.db.system(async (sx) => {
      // The seeded table is tiny; the question is whether the counts can use the index at all.
      await sx.query(`SELECT set_config('enable_seqscan', 'off', true)`);
      const plan = async (sql: string) =>
        (await sx.query(`EXPLAIN ${sql}`, { a: p.uuid(maya) })).rows
          .map((r) => String(r['QUERY PLAN']))
          .join('\n');
      return [
        await plan(
          `SELECT count(*) FROM turns WHERE author_id = :a AND created_at > now() - make_interval(secs => 600)`,
        ),
        await plan(
          `SELECT count(*) FROM turns WHERE author_id = :a AND status = 'pending'
             AND created_at > now() - make_interval(secs => 120)`,
        ),
      ];
    });
    for (const plan of plans) expect(plan).toContain('turns_author_created_idx');
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!INDEX) throw new Error('0015 missing');
    const indexes = () =>
      t.db.system((sx) =>
        sx.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'turns' ORDER BY indexname`),
      );
    const before = (await indexes()).rows;
    expect(before.map((r) => r.indexname)).toContain('turns_author_created_idx');
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(INDEX.sql)) await sx.query(statement);
    });
    expect((await indexes()).rows).toEqual(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
