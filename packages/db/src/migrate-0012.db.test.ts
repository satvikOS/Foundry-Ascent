/**
 * Migration 0012 (the EIR studio test bench) on top of the schema production has, with usage the previous code
 * wrote: it applies cleanly as the non-superuser owner, the ledger takes the new purpose and keeps the old rows,
 * the admission counts are the caller's own and counts only, and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { auditRepo, turnsRepo, usageRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const BENCH = MIGRATIONS.find((m) => m.version === '0012_test_bench');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0012');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const WINDOW = { windowSeconds: 600, inFlightSeconds: 120 };

let t: TestDatabase;
let seed: SeedResult;

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

function usage(purpose: usageRepo.UsagePurpose) {
  return t.db.system((sx) =>
    usageRepo.recordUsage(sx, {
      tenantId: seed.tenantId,
      principalId: must(seed.principals['eir-corin']),
      purpose,
      modelId: 'mock-model',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.25,
      requestId: `req-${purpose}`,
    }),
  );
}

/** One bench audit event as the request principal (the way the service appends it). */
function benchEvent(who: ReturnType<typeof ctx>, action: string, runId: string): Promise<number> {
  return t.db.withContext(who, (tx) =>
    auditRepo.appendAudit(tx, {
      action,
      outcome: 'succeeded',
      objectType: 'test_bench_run',
      objectId: runId,
    }),
  );
}

const admission = (who: ReturnType<typeof ctx>) =>
  t.db.withContext(who, (tx) => turnsRepo.testBenchAdmission(tx, WINDOW));

/** The ledger CHECK constraint and the app functions with their grants: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'usage_ledger'::regclass ORDER BY conname`,
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
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
  await usage('turn');
  await usage('distill');
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0012_test_bench', () => {
  it('refuses the purpose before it applies', async () => {
    expect(await sqlState(usage('test_bench'))).toBe('23514');
  });

  it('applies cleanly on top of the earlier migrations with existing usage, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    // Later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0012'));
    expect(report.applied[0]).toBe('0012_test_bench');
    expect(BENCH && splitStatements(BENCH.sql).length).toBeGreaterThanOrEqual(4);
  });

  it('meters test conversations under their own purpose, against the same caps, keeping earlier rows', async () => {
    await usage('test_bench');
    const rows = await t.db.system((sx) =>
      sx.query(`SELECT purpose FROM usage_ledger WHERE request_id LIKE 'req-%' ORDER BY id`),
    );
    expect(rows.rows.map((r) => r.purpose)).toEqual(['turn', 'distill', 'test_bench']);
    // The curator's own daily spend counts it (the per-person cap reads the same ledger).
    const spent = await t.db.system((sx) =>
      usageRepo.spendToday(sx, { principalId: must(seed.principals['eir-corin']) }),
    );
    expect(spent).toBeCloseTo(0.75, 6);
    expect(await sqlState(usage('bogus' as usageRepo.UsagePurpose))).toBe('23514');
  });

  it('counts the caller’s own test messages, and those not answered yet', async () => {
    const corin = ctx('eir-corin');
    const ruth = ctx('eir-ruth');
    expect(await admission(corin)).toEqual({ recent: 0, inFlight: 0 });
    const run1 = '11111111-1111-4111-8111-111111111111';
    const run2 = '22222222-2222-4222-8222-222222222222';
    await benchEvent(corin, 'test_bench.used', run1);
    await benchEvent(corin, 'test_bench.used', run2);
    await benchEvent(corin, 'test_bench.answered', run1);
    // Someone else's messages and other actions never count.
    await benchEvent(ruth, 'test_bench.used', '33333333-3333-4333-8333-333333333333');
    await benchEvent(corin, 'turn.accepted', '44444444-4444-4444-8444-444444444444');
    expect(await admission(corin)).toEqual({ recent: 2, inFlight: 1 });
    expect(await admission(ruth)).toEqual({ recent: 1, inFlight: 1 });
    // Another person answering a run id never closes the caller's run.
    await benchEvent(ruth, 'test_bench.answered', run2);
    expect(await admission(corin)).toEqual({ recent: 2, inFlight: 1 });
    // Old messages leave both windows.
    await t.db.system((sx) =>
      sx.query(`UPDATE audit_events SET at = at - interval '1 hour' WHERE object_id = :id`, {
        id: p.text(run2),
      }),
    );
    expect(await admission(corin)).toEqual({ recent: 1, inFlight: 0 });
  });

  it('keeps the audit log closed to app_rls: only the counts are readable', async () => {
    expect(
      await sqlState(
        t.db.withContext(ctx('eir-corin'), (tx) => tx.query('SELECT count(*) AS n FROM audit_events')),
      ),
    ).toBe('42501');
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!BENCH) throw new Error('0012 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(BENCH.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
