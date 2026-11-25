/**
 * Migration 0037 (the program's stage a path began with) on a database that already holds paths: each takes its venture's
 * stage of that day, a new path (an older build's insert too) takes it by itself, a change of direction takes the one of
 * its day, nothing else changes it, and it re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { pathRepo, readTogether } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeededVenture, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const STAGE = MIGRATIONS.find((m) => m.version === '0037_path_program_stage');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
let mine: SeededVenture;
let theirs: SeededVenture;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}
const ctx = (key: string) => makeContext(must(seed.principals[key]), seed.tenantId);
const pathOf = (who: string, v: SeededVenture) =>
  t.db.withContext(
    ctx(who),
    async (tx) => pathRepo.pathReadsFrom(await readTogether(tx, pathRepo.pathParts(v.id))).path,
  );
const setStage = (v: SeededVenture, stage: string) =>
  t.db.system((sx) =>
    sx.query('UPDATE ventures SET stage = :s WHERE id = :v', { s: p.text(stage), v: p.uuid(v.id) }),
  );

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: MIGRATIONS.filter((m) => m.version < '0037') });
  seed = await seedDatabase(t.db, CONFIG);
  mine = must(seed.ventures.find((v) => v.key === 'quietquad'));
  theirs = must(seed.ventures.find((v) => v.key === 'benchtally'));
  await setStage(mine, 'validation');
  await t.db.system((sx) =>
    sx.query(
      `INSERT INTO venture_paths (venture_id, tenant_id, stage, playbook_version) VALUES (:v, :t, 'idea', 'v1')`,
      { v: p.uuid(mine.id), t: p.uuid(seed.tenantId) },
    ),
  );
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0037_path_program_stage', () => {
  it('a path that has begun takes its venture’s stage of that day, and keeps it', async () => {
    expect((await migrate(t.db)).applied[0]).toBe('0037_path_program_stage');
    expect(await pathOf('maya', mine)).toMatchObject({ stage: 'idea', programStage: 'validation' });
    await setStage(mine, 'growth');
    expect((await pathOf('maya', mine))?.programStage).toBe('validation');
  });

  it('a path begun since takes it by itself, as a founder writes it', async () => {
    await setStage(theirs, 'business_model');
    await t.db.withContext(ctx('priya'), (tx) =>
      pathRepo.ensurePath(tx, {
        tenantId: seed.tenantId,
        ventureId: theirs.id,
        stage: 'idea',
        playbookVersion: 'v1',
      }),
    );
    expect(await pathOf('priya', theirs)).toMatchObject({ stage: 'idea', programStage: 'business_model' });
    await t.db.withContext(ctx('priya'), (tx) =>
      pathRepo.advanceStage(tx, {
        ventureId: theirs.id,
        stage: 'discovery',
        order: ['idea', 'discovery'],
        playbookVersion: 'v1',
      }),
    );
    expect(await pathOf('priya', theirs)).toMatchObject({
      stage: 'discovery',
      programStage: 'business_model',
    });
  });

  it('a change of direction takes the one of its day', async () => {
    const sessionId = must(
      (
        await t.db.system((sx) =>
          sx.query('SELECT id FROM coaching_sessions WHERE venture_id = :v LIMIT 1', { v: p.uuid(mine.id) }),
        )
      ).rows[0]?.id as string | undefined,
    );
    await t.db.withContext(ctx('maya'), (tx) =>
      pathRepo.keepPivot(tx, {
        tenantId: seed.tenantId,
        ventureId: mine.id,
        principalId: ctx('maya').principalId,
        stage: 'idea',
        playbookVersion: 'v1',
        pivot: { on: '2026-11-25', from: 'quiet rooms', to: 'loud rooms', sessionId },
        sessionId,
      }),
    );
    expect(await pathOf('maya', mine)).toMatchObject({ stage: 'idea', programStage: 'growth' });
  });

  it('re-runs without changes', async () => {
    for (const statement of splitStatements(must(STAGE).sql)) await t.db.system((sx) => sx.query(statement));
    expect((await pathOf('maya', mine))?.programStage).toBe('growth');
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
